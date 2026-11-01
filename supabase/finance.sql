-- =================================================================
-- Sun Power: money and people. Technician hours and pay, profit per installation,
-- GST tax invoices (orders and chargeable repairs), PM Surya Ghar subsidy paperwork.
-- Run after director.sql. Safe to run again.
-- Defaults (labour cost, HSN/SAC codes, rates) are starting points: change them in Quote settings / Products / Team.
-- =================================================================

-- =================================================================
-- 1. Settings helpers
-- =================================================================

create or replace function public.setting(p_key text, p_default text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(trim((select settings ->> p_key from public.quote_settings where id = 1)), ''), p_default);
$$;

-- HSN codes on products (goods) and SAC for services; check them with your accountant
alter table public.products add column if not exists hsn_code text;
update public.products set hsn_code = case category
    when 'panel' then '8541' when 'inverter' then '8504' when 'charge_controller' then '8504' when 'battery' then '8507'
    when 'structure' then '7308' when 'dc_cable' then '8544' when 'ac_cable' then '8544' when 'acdb_dcdb' then '8537'
    when 'earthing' then '8538' when 'lightning_arrestor' then '8535' when 'connector' then '8536' when 'service' then '9954'
    else null end
  where hsn_code is null;
grant insert (hsn_code), update (hsn_code) on public.products to authenticated;

-- =================================================================
-- 2. Technician hours and pay
-- =================================================================

create table if not exists public.technician_rates (
  staff_email    text primary key,
  cost_per_hour  numeric not null default 150 check (cost_per_hour >= 0),  -- what an hour costs the company (for job profit)
  monthly_salary numeric not null default 0 check (monthly_salary >= 0),
  per_install    numeric not null default 0 check (per_install >= 0),     -- bonus per installation completed
  per_visit      numeric not null default 0 check (per_visit >= 0),       -- bonus per service visit completed
  hourly_rate    numeric not null default 0 check (hourly_rate >= 0),     -- for technicians paid by the hour
  updated_at     timestamptz not null default now()
);

create table if not exists public.work_logs (
  id             uuid primary key default gen_random_uuid(),
  staff_email    text not null,
  work_date      date not null,
  kind           text not null check (kind in ('install', 'service', 'other')),
  install_job_id uuid references public.install_jobs (id) on delete cascade,
  ticket_id      uuid references public.service_tickets (id) on delete cascade,
  order_id       uuid references public.orders (id) on delete set null,
  hours          numeric not null check (hours >= 0 and hours <= 16),
  source         text not null default 'auto' check (source in ('auto', 'manual')),
  notes          text,
  created_by     text,
  created_at     timestamptz not null default now()
);

create unique index if not exists work_logs_job_person_idx on public.work_logs (lower(staff_email), install_job_id) where install_job_id is not null;
create unique index if not exists work_logs_ticket_person_idx on public.work_logs (lower(staff_email), ticket_id) where ticket_id is not null;
create index if not exists work_logs_date_idx on public.work_logs (work_date, staff_email);

-- Everyone on a crew (lead technician + members) who is on the staff list (placeholder emails are skipped)
create or replace function public.crew_people(p_crew_id uuid)
returns table (staff_email text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct lower(e) from (
    select lead_technician_email as e from public.crews where id = p_crew_id
    union select staff_email from public.crew_members where crew_id = p_crew_id
  ) x where e is not null and lower(e) in (select lower(email) from public.staff);
$$;

-- Hours between start and finish, at least ¼ hour, at most 16
create or replace function public.hours_between(p_start timestamptz, p_end timestamptz)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select least(16, greatest(0.25, round((extract(epoch from (p_end - p_start)) / 3600)::numeric * 4) / 4));
$$;

-- When a job or visit is finished, each person on the crew gets the hours (the office can correct them on the Team screen)
create or replace function public.install_jobs_log_hours()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' and new.started_at is not null and new.finished_at is not null and new.crew_id is not null then
    insert into public.work_logs (staff_email, work_date, kind, install_job_id, order_id, hours, created_by)
    select p.staff_email, (new.finished_at at time zone 'Asia/Kolkata')::date, 'install', new.id, new.order_id,
           public.hours_between(new.started_at, new.finished_at), 'system'
    from public.crew_people(new.crew_id) p
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists install_jobs_log_hours on public.install_jobs;
create trigger install_jobs_log_hours
  after update on public.install_jobs
  for each row execute function public.install_jobs_log_hours();

create or replace function public.service_tickets_log_hours()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'resolved' and old.status is distinct from 'resolved' and new.started_at is not null and new.crew_id is not null then
    insert into public.work_logs (staff_email, work_date, kind, ticket_id, order_id, hours, created_by)
    select p.staff_email, (coalesce(new.resolved_at, now()) at time zone 'Asia/Kolkata')::date, 'service', new.id, new.order_id,
           public.hours_between(new.started_at, coalesce(new.resolved_at, now())), 'system'
    from public.crew_people(new.crew_id) p
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists service_tickets_log_hours on public.service_tickets;
create trigger service_tickets_log_hours
  after update on public.service_tickets
  for each row execute function public.service_tickets_log_hours();

create table if not exists public.technician_payouts (
  id          uuid primary key default gen_random_uuid(),
  month       date not null,            -- first day of the month paid for
  staff_email text not null,
  amount      numeric not null check (amount >= 0),
  paid_on     date not null default ((now() at time zone 'Asia/Kolkata')::date),
  method      text,
  reference   text,
  notes       text,
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (month, staff_email)
);

-- Pay sheet for a month: hours, jobs and what each technician earns (owner and managers only)
create or replace function public.technician_pay(p_month date)
returns table (staff_email text, name text, hours numeric, installs bigint, visits bigint,
               monthly_salary numeric, install_pay numeric, visit_pay numeric, hourly_pay numeric, total numeric,
               paid numeric, paid_on date, cost_per_hour numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with m as (select date_trunc('month', p_month)::date as m0, (date_trunc('month', p_month) + interval '1 month')::date as m1),
  logs as (
    select lower(w.staff_email) as e, sum(w.hours) as hours,
           count(*) filter (where w.kind = 'install') as installs, count(*) filter (where w.kind = 'service') as visits
    from public.work_logs w, m where w.work_date >= m.m0 and w.work_date < m.m1 group by 1
  )
  select s.email, s.name, coalesce(l.hours, 0), coalesce(l.installs, 0), coalesce(l.visits, 0),
         coalesce(r.monthly_salary, 0),
         coalesce(l.installs, 0) * coalesce(r.per_install, 0),
         coalesce(l.visits, 0) * coalesce(r.per_visit, 0),
         round(coalesce(l.hours, 0) * coalesce(r.hourly_rate, 0), 2),
         coalesce(r.monthly_salary, 0) + coalesce(l.installs, 0) * coalesce(r.per_install, 0)
           + coalesce(l.visits, 0) * coalesce(r.per_visit, 0) + round(coalesce(l.hours, 0) * coalesce(r.hourly_rate, 0), 2),
         p.amount, p.paid_on,
         coalesce(r.cost_per_hour, public.setting('labour_cost_per_hour', '150')::numeric)
  from public.staff s
  cross join m
  left join logs l on l.e = lower(s.email)
  left join public.technician_rates r on lower(r.staff_email) = lower(s.email)
  left join public.technician_payouts p on lower(p.staff_email) = lower(s.email) and p.month = m.m0
  where public.is_manager() and s.role = 'technician'
  order by s.name;
$$;

-- =================================================================
-- 3. Profit per installation
-- =================================================================

create table if not exists public.job_expenses (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders (id) on delete cascade,
  category   text not null check (category in ('transport', 'discom_fees', 'civil_work', 'extra_material', 'subcontract', 'other')),
  amount     numeric not null check (amount > 0),
  spent_on   date not null default ((now() at time zone 'Asia/Kolkata')::date),
  note       text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists job_expenses_order_idx on public.job_expenses (order_id);

-- Revenue (excl. GST) minus parts at cost, crew hours at cost, other job costs and free warranty repairs.
-- Installation service lines are covered by the crew hours; DISCOM and other fees are entered as job costs.
create or replace function public.job_profit(p_order_ids uuid[])
returns table (order_id uuid, order_number text, client_name text, client_code text, system_size_kw numeric, status text,
               installed_at timestamptz, revenue numeric, parts_cost numeric, labour_hours numeric, labour_cost numeric,
               expenses numeric, warranty_cost numeric, profit numeric, margin_pct numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with o as (select * from public.orders where id = any (p_order_ids)),
  default_rate as (select public.setting('labour_cost_per_hour', '150')::numeric as r),
  calc as (
    select o.id,
      coalesce((select sum(oi.amount) from public.order_items oi where oi.order_id = o.id), 0) as revenue,
      coalesce((select sum(oi.qty * p.cost_price) from public.order_items oi join public.products p on p.id = oi.product_id
                where oi.order_id = o.id and not oi.is_service), 0) as parts_cost,
      coalesce((select sum(w.hours) from public.work_logs w where w.order_id = o.id and w.kind = 'install'), 0) as labour_hours,
      coalesce((select sum(w.hours * coalesce(r.cost_per_hour, d.r)) from public.work_logs w
                left join public.technician_rates r on lower(r.staff_email) = lower(w.staff_email), default_rate d
                where w.order_id = o.id and w.kind = 'install'), 0) as labour_cost,
      coalesce((select sum(amount) from public.job_expenses e where e.order_id = o.id), 0) as expenses,
      -- Free (in-warranty) repairs on this system: parts at cost + crew hours
      coalesce((select sum((x ->> 'qty')::numeric * p.cost_price) from public.service_tickets t
                cross join jsonb_array_elements(t.parts) x join public.products p on p.id = (x ->> 'product_id')::uuid
                where t.order_id = o.id and not t.chargeable and t.status in ('resolved', 'closed')), 0)
      + coalesce((select sum(w.hours * coalesce(r.cost_per_hour, d.r)) from public.work_logs w
                  join public.service_tickets t on t.id = w.ticket_id
                  left join public.technician_rates r on lower(r.staff_email) = lower(w.staff_email), default_rate d
                  where t.order_id = o.id and not t.chargeable), 0) as warranty_cost
    from o
  )
  select o.id, o.order_number, l.name, l.client_code, o.system_size_kw, o.status, o.installed_at,
         c.revenue, c.parts_cost, c.labour_hours, round(c.labour_cost, 2), c.expenses, round(c.warranty_cost, 2),
         round(c.revenue - c.parts_cost - c.labour_cost - c.expenses - c.warranty_cost, 2),
         case when c.revenue > 0 then round(100 * (c.revenue - c.parts_cost - c.labour_cost - c.expenses - c.warranty_cost) / c.revenue, 1) end
  from o join calc c on c.id = o.id join public.leads l on l.id = o.lead_id
  where public.is_office();
$$;

-- =================================================================
-- 4. GST tax invoices
-- =================================================================

create table if not exists public.invoice_counters (fy text primary key, last int not null default 0);

-- "SP/2026-27/0001": numbered per Indian financial year (April–March), no gaps
create or replace function public.next_invoice_number()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  d date := (now() at time zone 'Asia/Kolkata')::date;
  y int := extract(year from d)::int - case when extract(month from d) < 4 then 1 else 0 end;
  v_fy text := y || '-' || lpad(((y + 1) % 100)::text, 2, '0');
  n int;
begin
  insert into public.invoice_counters (fy, last) values (v_fy, 1)
  on conflict (fy) do update set last = public.invoice_counters.last + 1
  returning last into n;
  return public.setting('invoice_prefix', 'SP') || '/' || v_fy || '/' || lpad(n::text, 4, '0');
end;
$$;

create table if not exists public.invoices (
  id               uuid primary key default gen_random_uuid(),
  invoice_number   text not null unique,
  kind             text not null check (kind in ('order', 'service')),
  order_id         uuid references public.orders (id) on delete restrict,
  ticket_id        uuid references public.service_tickets (id) on delete restrict,
  lead_id          uuid not null references public.leads (id) on delete restrict,
  invoice_date     date not null default ((now() at time zone 'Asia/Kolkata')::date),
  customer_name    text,
  customer_address text,
  customer_gstin   text,
  place_of_supply  text,
  intra_state      boolean not null default true,
  lines            jsonb not null,   -- [{description, hsn, qty, unit, rate, taxable, gst_rate, gst}]
  discount         numeric not null default 0,
  taxable          numeric not null,
  cgst             numeric not null default 0,
  sgst             numeric not null default 0,
  igst             numeric not null default 0,
  rounding         numeric not null default 0,
  total            numeric not null,
  status           text not null default 'issued' check (status in ('issued', 'cancelled')),
  cancelled_reason text,
  pdf_path         text,
  sent_at          timestamptz,
  paid_on          date,              -- service invoices (order invoices are paid through the order's payments)
  paid_method      text,
  paid_reference   text,
  created_by       text,
  created_at       timestamptz not null default now()
);

create unique index if not exists invoices_one_per_order_idx on public.invoices (order_id) where kind = 'order' and status = 'issued';
create unique index if not exists invoices_one_per_ticket_idx on public.invoices (ticket_id) where kind = 'service' and status = 'issued';
create index if not exists invoices_lead_idx on public.invoices (lead_id);

-- Shared: GST per line, CGST+SGST within the state or IGST across states, round to the rupee
create or replace function public.make_invoice(p_kind text, p_order_id uuid, p_ticket_id uuid, p_lead_id uuid, p_lines jsonb,
                                               p_discount numeric, p_target_total numeric, p_address text, p_gstin text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.leads;
  v_company_state text := left(coalesce(nullif(public.setting('gstin', ''), ''), '36'), 2);
  v_customer_state text := left(nullif(trim(coalesce(p_gstin, '')), ''), 2);
  v_intra boolean;
  v_taxable numeric;
  v_gst numeric;
  v_lines jsonb := p_lines;
  v_total numeric;
  v_id uuid;
begin
  select * into l from public.leads where id = p_lead_id;
  v_intra := v_customer_state is null or v_customer_state = v_company_state;
  select coalesce(sum((x ->> 'taxable')::numeric), 0), coalesce(sum((x ->> 'gst')::numeric), 0) into v_taxable, v_gst
  from jsonb_array_elements(v_lines) x;

  -- The order total is what the customer agreed: if per-item GST doesn't add up to it (older quotes used one rate),
  -- spread the agreed GST over the lines at one effective rate
  if p_target_total is not null and v_taxable > 0 and abs((v_taxable + v_gst) - p_target_total) > 1 then
    v_gst := round(p_target_total - v_taxable, 2);
    select jsonb_agg(x || jsonb_build_object('gst_rate', round(100 * v_gst / v_taxable, 2),
                                            'gst', round((x ->> 'taxable')::numeric * v_gst / v_taxable, 2)))
      into v_lines from jsonb_array_elements(v_lines) x;
  end if;
  v_total := round(v_taxable + v_gst);

  insert into public.invoices (invoice_number, kind, order_id, ticket_id, lead_id, customer_name, customer_address, customer_gstin,
                               place_of_supply, intra_state, lines, discount, taxable, cgst, sgst, igst, rounding, total, created_by)
  values (public.next_invoice_number(), p_kind, p_order_id, p_ticket_id, p_lead_id, l.name,
          coalesce(nullif(trim(p_address), ''), l.location), nullif(upper(trim(coalesce(p_gstin, ''))), ''),
          case when v_intra then public.setting('company_state', 'Telangana') else 'State code ' || v_customer_state end, v_intra,
          v_lines, coalesce(p_discount, 0), v_taxable,
          case when v_intra then round(v_gst / 2, 2) else 0 end, case when v_intra then v_gst - round(v_gst / 2, 2) else 0 end,
          case when v_intra then 0 else v_gst end,
          round(v_total - v_taxable - v_gst, 2), v_total, coalesce(auth.jwt() ->> 'email', 'system'))
  returning id into v_id;
  return v_id;
end;
$$;

-- Tax invoice for an order (once the goods have gone out). Safe to call twice.
create or replace function public.issue_order_invoice(p_order_id uuid, p_address text default null, p_gstin text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
  v_id uuid;
  v_gross numeric;
  v_discount numeric;
  v_share numeric;
  v_lines jsonb;
  v_sac text := public.setting('installation_sac', '9954');
begin
  if not (public.is_office() or public.is_internal()) then
    raise exception 'Not allowed';
  end if;
  select * into o from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order not found';
  end if;
  select id into v_id from public.invoices where order_id = o.id and kind = 'order' and status = 'issued';
  if v_id is not null then
    return v_id;
  end if;
  if o.status not in ('dispatched', 'installed', 'completed') then
    raise exception 'Issue the tax invoice once the goods have been dispatched (this order is %)', replace(o.status, '_', ' ');
  end if;

  -- A quote discount is spread over the lines in proportion (the same way the quote worked out GST)
  select coalesce(sum(amount) filter (where amount > 0), 0), coalesce(-sum(amount) filter (where amount < 0), 0)
    into v_gross, v_discount from public.order_items where order_id = o.id;
  v_share := case when v_gross > 0 then (v_gross - v_discount) / v_gross else 1 end;
  select coalesce(jsonb_agg(jsonb_build_object(
           'description', oi.description, 'hsn', coalesce(p.hsn_code, case when oi.is_service then v_sac end),
           'qty', oi.qty, 'unit', oi.unit, 'rate', oi.unit_price,
           'taxable', round(oi.amount * v_share, 2),
           'gst_rate', coalesce(p.gst_percent, 18),
           'gst', round(oi.amount * v_share * coalesce(p.gst_percent, 18) / 100, 2)) order by oi.is_service, oi.description), '[]'::jsonb)
    into v_lines
  from public.order_items oi left join public.products p on p.id = oi.product_id
  where oi.order_id = o.id and oi.amount > 0;

  v_id := public.make_invoice('order', o.id, null, o.lead_id, v_lines, v_discount, o.total, p_address, p_gstin);
  perform public.log_lead_activity(o.lead_id, format('Tax invoice %s issued for %s.', (select invoice_number from public.invoices where id = v_id), o.order_number));
  return v_id;
end;
$$;

-- Tax invoice for a chargeable repair: parts at selling price + the visit charge, plus GST
create or replace function public.issue_service_invoice(p_ticket_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.service_tickets;
  v_id uuid;
  v_visit numeric := public.setting('service_visit_charge', '500')::numeric;
  v_sac text := public.setting('service_sac', '9987');
  v_lines jsonb;
begin
  if not (public.is_office() or public.is_internal()) then
    raise exception 'Not allowed';
  end if;
  select * into t from public.service_tickets where id = p_ticket_id;
  if not found then
    raise exception 'Ticket not found';
  end if;
  select id into v_id from public.invoices where ticket_id = t.id and kind = 'service' and status = 'issued';
  if v_id is not null then
    return v_id;
  end if;
  if not t.chargeable or coalesce(t.charge_amount, 0) <= 0 then
    raise exception 'This repair is free (under warranty)';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'description', x ->> 'description', 'hsn', p.hsn_code, 'qty', (x ->> 'qty')::numeric, 'unit', x ->> 'unit',
           'rate', (x ->> 'unit_price')::numeric, 'taxable', round((x ->> 'qty')::numeric * (x ->> 'unit_price')::numeric, 2),
           'gst_rate', coalesce(p.gst_percent, 18),
           'gst', round((x ->> 'qty')::numeric * (x ->> 'unit_price')::numeric * coalesce(p.gst_percent, 18) / 100, 2))), '[]'::jsonb)
    into v_lines
  from jsonb_array_elements(t.parts) x left join public.products p on p.id = (x ->> 'product_id')::uuid;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'description', 'Service visit and labour (' || t.ticket_number || ')', 'hsn', v_sac, 'qty', 1, 'unit', 'job',
    'rate', v_visit, 'taxable', v_visit, 'gst_rate', 18, 'gst', round(v_visit * 0.18, 2)));

  v_id := public.make_invoice('service', t.order_id, t.id, t.lead_id, v_lines, 0, null, null, null);
  perform public.log_lead_activity(t.lead_id, format('Tax invoice %s issued for repair %s.', (select invoice_number from public.invoices where id = v_id), t.ticket_number));
  return v_id;
end;
$$;

-- Out-of-warranty repairs are billed automatically when the visit is resolved
create or replace function public.service_tickets_auto_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'resolved' and old.status is distinct from 'resolved' and new.chargeable and coalesce(new.charge_amount, 0) > 0 then
    perform public.issue_service_invoice(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists service_tickets_auto_invoice on public.service_tickets;
create trigger service_tickets_auto_invoice
  after update on public.service_tickets
  for each row execute function public.service_tickets_auto_invoice();

-- Issued invoices never change (only PDF, sending, payment and cancellation by a manager)
create or replace function public.invoices_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'cancelled' then
    raise exception 'A cancelled invoice cannot be changed';
  end if;
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    -- (not is_internal(): inside this trigger every caller would count as internal)
    if not (public.is_manager() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
      raise exception 'Only a manager can cancel an invoice';
    end if;
    if nullif(trim(coalesce(new.cancelled_reason, '')), '') is null then
      raise exception 'Give a reason to cancel the invoice';
    end if;
  end if;
  if (new.invoice_number, new.kind, new.lines, new.taxable, new.cgst, new.sgst, new.igst, new.total, new.invoice_date, new.lead_id)
     is distinct from (old.invoice_number, old.kind, old.lines, old.taxable, old.cgst, old.sgst, old.igst, old.total, old.invoice_date, old.lead_id) then
    raise exception 'An issued invoice cannot be edited; cancel it and issue a new one';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_before_update on public.invoices;
create trigger invoices_before_update
  before update on public.invoices
  for each row execute function public.invoices_before_update();

-- =================================================================
-- 5. PM Surya Ghar subsidy paperwork
-- =================================================================

create table if not exists public.subsidy_cases (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null unique references public.orders (id) on delete cascade,
  lead_id          uuid not null references public.leads (id) on delete cascade,
  amount           numeric not null default 0,
  scheme           text not null default 'PM Surya Ghar',
  discom           text not null default 'TGSPDCL',
  application_no   text,
  step             text not null default 'registration'
                   check (step in ('registration', 'feasibility', 'installation', 'inspection', 'claim', 'credited', 'rejected')),
  registered_on    date,
  feasibility_on   date,
  installed_on     date,
  inspection_on    date,
  net_meter_no     text,
  claim_on         date,
  credited_on      date,
  credited_amount  numeric,
  documents        jsonb not null default '{}'::jsonb,  -- {aadhaar, electricity_bill, bank_passbook, ownership_proof, site_photo, net_meter_agreement}
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The current step is the furthest one with a date
create or replace function public.subsidy_cases_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.step <> 'rejected' then
    new.step := case
      when new.credited_on is not null then 'credited'
      when new.claim_on is not null then 'claim'
      when new.inspection_on is not null then 'inspection'
      when new.installed_on is not null then 'installation'
      when new.feasibility_on is not null then 'feasibility'
      else 'registration' end;
  end if;
  -- (runs inside a trigger, so the log counts as internal; it must never switch app.internal off under its caller)
  if tg_op = 'UPDATE' and new.step is distinct from old.step then
    perform public.log_lead_activity(new.lead_id, format('Subsidy (%s): %s → %s%s.', new.scheme, old.step, new.step,
      case when new.step = 'credited' then format(', ₹%s credited', to_char(coalesce(new.credited_amount, new.amount), 'FM99,99,990')) else '' end));
  end if;
  return new;
end;
$$;

drop trigger if exists subsidy_cases_before_write on public.subsidy_cases;
create trigger subsidy_cases_before_write
  before insert or update on public.subsidy_cases
  for each row execute function public.subsidy_cases_before_write();

-- A subsidy case opens when an order with a subsidy is confirmed; the installation step ticks itself
create or replace function public.orders_subsidy_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new.subsidy, 0) > 0 and new.status not in ('awaiting_payment', 'cancelled') then
    insert into public.subsidy_cases (order_id, lead_id, amount)
    values (new.id, new.lead_id, new.subsidy)
    on conflict (order_id) do nothing;
  end if;
  if new.installed_at is not null then
    update public.subsidy_cases set installed_on = (new.installed_at at time zone 'Asia/Kolkata')::date
    where order_id = new.id and installed_on is null;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_subsidy_sync on public.orders;
create trigger orders_subsidy_sync
  after insert or update on public.orders
  for each row execute function public.orders_subsidy_sync();

-- Existing orders with a subsidy get a case now
insert into public.subsidy_cases (order_id, lead_id, amount, installed_on)
select id, lead_id, subsidy, (installed_at at time zone 'Asia/Kolkata')::date
from public.orders where coalesce(subsidy, 0) > 0 and status not in ('awaiting_payment', 'cancelled')
on conflict (order_id) do nothing;

-- =================================================================
-- 6. Director: profit per job, unfinished work, invoices to send, subsidy, payroll
-- =================================================================

create or replace function public.director_money(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month')::date;
  t0 timestamptz := v_from::timestamp at time zone 'Asia/Kolkata';
  t1 timestamptz := v_to::timestamp at time zone 'Asia/Kolkata';
begin
  if not public.is_manager() then
    raise exception 'Only the owner and managers can see the director''s dashboard';
  end if;
  return jsonb_build_object(
    -- Installations finished this month, with their profit
    'jobs', (select coalesce(jsonb_agg(to_jsonb(j) order by j.profit), '[]'::jsonb) from public.job_profit(
      array(select id from public.orders where installed_at >= t0 and installed_at < t1 and status <> 'cancelled')) j),
    -- Every order not yet completed, and what it is waiting for
    'unfinished', (select coalesce(jsonb_agg(jsonb_build_object('order_id', o.id, 'order_number', o.order_number, 'client_name', l.name,
        'client_code', l.client_code, 'status', o.status, 'balance', o.balance, 'created_at', o.created_at,
        'install_date', j.scheduled_date,
        'waiting_for', case o.status
          when 'awaiting_payment' then 'Advance payment'
          when 'confirmed' then 'Packing' when 'packing' then 'Packing'
          when 'packed' then 'Dispatch'
          when 'dispatched' then 'Installation'
          when 'installed' then 'Balance payment' end) order by o.created_at), '[]'::jsonb)
      from public.orders o join public.leads l on l.id = o.lead_id left join public.install_jobs j on j.id = o.install_job_id
      where o.status not in ('completed', 'cancelled')),
    'invoices', jsonb_build_object(
      'to_issue', (select coalesce(jsonb_agg(jsonb_build_object('order_id', o.id, 'order_number', o.order_number, 'client_name', l.name, 'total', o.total)), '[]'::jsonb)
                   from public.orders o join public.leads l on l.id = o.lead_id
                   where o.status in ('dispatched', 'installed', 'completed')
                     and not exists (select 1 from public.invoices i where i.order_id = o.id and i.kind = 'order' and i.status = 'issued')),
      'not_sent', (select count(*) from public.invoices where status = 'issued' and sent_at is null),
      'issued_value', (select coalesce(sum(total), 0) from public.invoices where status = 'issued' and invoice_date >= v_from and invoice_date < v_to),
      'unpaid_service', (select coalesce(sum(total), 0) from public.invoices where kind = 'service' and status = 'issued' and paid_on is null)),
    'subsidy', (select jsonb_build_object(
        'cases', count(*) filter (where step not in ('credited', 'rejected')),
        'pending_amount', coalesce(sum(amount) filter (where step not in ('credited', 'rejected')), 0),
        'credited_this_month', coalesce(sum(coalesce(credited_amount, amount)) filter (where credited_on >= v_from and credited_on < v_to), 0),
        'by_step', jsonb_build_object(
          'registration', count(*) filter (where step = 'registration'), 'feasibility', count(*) filter (where step = 'feasibility'),
          'installation', count(*) filter (where step = 'installation'), 'inspection', count(*) filter (where step = 'inspection'),
          'claim', count(*) filter (where step = 'claim')),
        'stuck', count(*) filter (where step not in ('credited', 'rejected') and updated_at < now() - interval '21 days'))
      from public.subsidy_cases),
    'payroll', (select jsonb_build_object('total', coalesce(sum(total), 0), 'hours', coalesce(sum(hours), 0),
                                          'paid', coalesce(sum(paid), 0), 'technicians', count(*))
                from public.technician_pay(v_from)),
    'job_expenses', (select coalesce(sum(amount), 0) from public.job_expenses where spent_on >= v_from and spent_on < v_to)
  );
end;
$$;

-- =================================================================
-- 7. Security
-- =================================================================

alter table public.technician_rates enable row level security;
alter table public.work_logs enable row level security;
alter table public.technician_payouts enable row level security;
alter table public.job_expenses enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.subsidy_cases enable row level security;
revoke all on public.technician_rates, public.work_logs, public.technician_payouts, public.job_expenses,
  public.invoices, public.invoice_counters, public.subsidy_cases from anon;
revoke all on public.invoice_counters from authenticated;

-- Pay is for the owner and managers only; hours are visible to the office
drop policy if exists "managers manage rates" on public.technician_rates;
create policy "managers manage rates" on public.technician_rates for all to authenticated using (public.is_manager()) with check (public.is_manager());
drop policy if exists "managers manage payouts" on public.technician_payouts;
create policy "managers manage payouts" on public.technician_payouts for all to authenticated using (public.is_manager()) with check (public.is_manager());
drop policy if exists "office manage work logs" on public.work_logs;
create policy "office manage work logs" on public.work_logs for all to authenticated using (public.is_office()) with check (public.is_office());
drop policy if exists "office manage job expenses" on public.job_expenses;
create policy "office manage job expenses" on public.job_expenses for all to authenticated using (public.is_office()) with check (public.is_office());
drop policy if exists "office manage subsidy" on public.subsidy_cases;
create policy "office manage subsidy" on public.subsidy_cases for all to authenticated using (public.is_office()) with check (public.is_office());

-- Invoices: read by the office; created only through issue_*_invoice; only these columns can change afterwards
drop policy if exists "office read invoices" on public.invoices;
create policy "office read invoices" on public.invoices for select to authenticated using (public.is_office());
drop policy if exists "office update invoices" on public.invoices;
create policy "office update invoices" on public.invoices for update to authenticated using (public.is_office()) with check (public.is_office());
revoke insert, update, delete on public.invoices from authenticated;
grant update (pdf_path, sent_at, paid_on, paid_method, paid_reference, status, cancelled_reason) on public.invoices to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'public.technician_pay(date)', 'public.job_profit(uuid[])', 'public.issue_order_invoice(uuid, text, text)',
    'public.issue_service_invoice(uuid)', 'public.director_money(date)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'public.setting(text, text)', 'public.crew_people(uuid)', 'public.next_invoice_number()',
    'public.make_invoice(text, uuid, uuid, uuid, jsonb, numeric, numeric, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;

-- Private storage for invoice PDFs
insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', false)
on conflict (id) do nothing;

drop policy if exists "office read invoice pdfs" on storage.objects;
create policy "office read invoice pdfs" on storage.objects
  for select to authenticated using (bucket_id = 'invoices' and public.is_office());
drop policy if exists "office upload invoice pdfs" on storage.objects;
create policy "office upload invoice pdfs" on storage.objects
  for insert to authenticated with check (bucket_id = 'invoices' and public.is_office());
drop policy if exists "office replace invoice pdfs" on storage.objects;
create policy "office replace invoice pdfs" on storage.objects
  for update to authenticated using (bucket_id = 'invoices' and public.is_office());
