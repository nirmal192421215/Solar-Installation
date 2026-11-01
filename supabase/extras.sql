-- =================================================================
-- Sun Power: the remaining pieces of the brief.
--   Stock purchases (supplier, bill, cost, GST) · warranty per serial number, starting at delivery ·
--   serial / customer search · today / this week figures for the director · full address and
--   grid check on leads · confirmed installed size · charge controller in On-Grid kits ·
--   Solar Panel Set packages · breakdown tickets close only when the customer confirms.
-- Run after finance.sql. Safe to run again.
-- =================================================================

-- =================================================================
-- 1. Leads: full address and the grid-connection check
-- =================================================================

alter table public.leads
  add column if not exists address text check (address is null or char_length(address) <= 300),
  add column if not exists grid_ok text check (grid_ok is null or grid_ok in ('Yes', 'No', 'Unknown'));
grant insert (address) on public.leads to anon; -- the website form may send the address

-- =================================================================
-- 2. Packages: charge controller in On-Grid kits; Solar Panel Set (panels, connectors, wires + installation)
-- =================================================================

alter table public.kit_templates drop constraint if exists kit_templates_system_type_check;
alter table public.kit_templates add constraint kit_templates_system_type_check
  check (system_type in ('on_grid', 'off_grid', 'hybrid', 'panel_set'));

-- As the package list describes it: On-Grid includes a battery charge controller (remove it in Kit templates if not wanted)
insert into public.kit_template_items (template_id, product_id, qty_mode, qty, sort)
select t.id, p.id, 'fixed', 1, 12
from public.kit_templates t join public.products p on p.sku = 'CC-MPPT-60'
where t.system_type = 'on_grid' and t.name like '% kW On-Grid'
  and not exists (select 1 from public.kit_template_items i where i.template_id = t.id and i.product_id = p.id);

insert into public.kit_templates (name, system_type, size_kw, notes)
select kw || ' kW Panel Set', 'panel_set', kw, 'Solar panels, connectors and wires (hardware) + installation'
from (values (1), (2), (3), (4), (5)) s(kw)
on conflict (name) do nothing;

insert into public.kit_template_items (template_id, product_id, qty_mode, qty, sort)
select t.id, p.id, x.qty_mode, x.qty, x.sort
from public.kit_templates t
cross join (values ('PNL-540-T1', 'per_kw', 2, 1), ('MC4-PAIR', 'per_kw', 2, 2), ('CBL-DC-4', 'from_survey_dc_cable', 20, 3),
                   ('SVC-INSTALL', 'per_kw', 1, 20)) x(sku, qty_mode, qty, sort)
join public.products p on p.sku = x.sku
where t.system_type = 'panel_set'
  and not exists (select 1 from public.kit_template_items i where i.template_id = t.id);

-- =================================================================
-- 3. Stock purchases
-- =================================================================

create sequence if not exists public.purchase_number_seq;

create table if not exists public.purchases (
  id              uuid primary key default gen_random_uuid(),
  purchase_number text not null unique
                  default ('PUR-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY') || '-' ||
                           lpad(nextval('public.purchase_number_seq')::text, 4, '0')),
  supplier        text not null check (char_length(trim(supplier)) >= 2),
  supplier_gstin  text,
  bill_no         text,
  bill_date       date not null default ((now() at time zone 'Asia/Kolkata')::date),
  lines           jsonb not null,   -- [{product_id, sku, name, qty, unit_cost, amount}]
  taxable         numeric not null default 0,
  gst             numeric not null default 0,
  total           numeric not null default 0,
  notes           text,
  created_by      text,
  created_at      timestamptz not null default now()
);

-- The same supplier bill can't be entered twice
create unique index if not exists purchases_supplier_bill_idx on public.purchases (lower(supplier), lower(bill_no)) where bill_no is not null and bill_no <> '';
alter table public.stock_movements add column if not exists purchase_id uuid references public.purchases (id) on delete set null;

-- Stock in from a supplier bill. Each product's cost price becomes the weighted average of old stock and this purchase.
create or replace function public.record_purchase(p_supplier text, p_gstin text, p_bill_no text, p_bill_date date,
                                                  p_lines jsonb, p_gst numeric, p_notes text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  it jsonb;
  p public.products;
  v_qty numeric;
  v_cost numeric;
  v_lines jsonb := '[]'::jsonb;
  v_taxable numeric := 0;
begin
  if not public.is_office() then
    raise exception 'Not allowed';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one item';
  end if;
  for it in select * from jsonb_array_elements(p_lines) loop
    v_qty := nullif(it ->> 'qty', '')::numeric;
    v_cost := coalesce(nullif(it ->> 'unit_cost', '')::numeric, 0);
    select * into p from public.products where id = (it ->> 'product_id')::uuid;
    if not found or p.is_service then
      raise exception 'Choose a stocked product for every line';
    end if;
    if v_qty is null or v_qty <= 0 or v_cost < 0 then
      raise exception 'Enter a quantity and cost for %', p.name;
    end if;
    v_lines := v_lines || jsonb_build_object('product_id', p.id, 'sku', p.sku, 'name', p.name, 'qty', v_qty, 'unit', p.unit,
                                             'unit_cost', v_cost, 'amount', round(v_qty * v_cost, 2));
    v_taxable := v_taxable + round(v_qty * v_cost, 2);
  end loop;

  insert into public.purchases (supplier, supplier_gstin, bill_no, bill_date, lines, taxable, gst, total, notes, created_by)
  values (trim(p_supplier), nullif(upper(trim(coalesce(p_gstin, ''))), ''), nullif(trim(coalesce(p_bill_no, '')), ''),
          coalesce(p_bill_date, (now() at time zone 'Asia/Kolkata')::date), v_lines, v_taxable, coalesce(p_gst, 0),
          v_taxable + coalesce(p_gst, 0), nullif(trim(coalesce(p_notes, '')), ''), auth.jwt() ->> 'email')
  returning id into v_id;

  for it in select * from jsonb_array_elements(v_lines) loop
    select * into p from public.products where id = (it ->> 'product_id')::uuid for update;
    if (it ->> 'unit_cost')::numeric > 0 then
      update public.products
        set cost_price = round((greatest(p.stock_qty, 0) * p.cost_price + (it ->> 'qty')::numeric * (it ->> 'unit_cost')::numeric)
                               / (greatest(p.stock_qty, 0) + (it ->> 'qty')::numeric), 2)
        where id = p.id;
    end if;
    perform public.move_stock(p.id, (it ->> 'qty')::numeric, 'purchase', null,
      format('Purchase %s from %s%s', (select purchase_number from public.purchases where id = v_id), trim(p_supplier),
             case when nullif(trim(coalesce(p_bill_no, '')), '') is not null then ', bill ' || trim(p_bill_no) else '' end));
    update public.stock_movements set purchase_id = v_id
      where id = (select max(id) from public.stock_movements where product_id = p.id and type = 'purchase');
  end loop;
  return v_id;
end;
$$;

-- =================================================================
-- 4. Warranty per serial number, starting at delivery
-- =================================================================

alter table public.orders add column if not exists delivered_at timestamptz;
alter table public.order_serials
  add column if not exists warranty_months int,
  add column if not exists warranty_start  date,
  add column if not exists warranty_end    date;

-- Start the clock for every serial of a delivered order that doesn't have one yet
create or replace function public.start_serial_warranties(p_order_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  update public.order_serials s
    set warranty_months = p.warranty_months,
        warranty_start = (o.delivered_at at time zone 'Asia/Kolkata')::date,
        warranty_end = ((o.delivered_at at time zone 'Asia/Kolkata')::date + make_interval(months => coalesce(p.warranty_months, 0)))::date
    from public.orders o, public.products p
    where s.order_id = p_order_id and o.id = s.order_id and p.id = s.product_id
      and o.delivered_at is not null and s.warranty_start is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Delivered = the crew starts work on site with the goods (or the office marks it delivered)
create or replace function public.install_jobs_mark_delivered()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'in_progress' and old.status is distinct from 'in_progress' then
    update public.orders set delivered_at = coalesce(delivered_at, new.started_at, now())
    where id = new.order_id and delivered_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists install_jobs_mark_delivered on public.install_jobs;
create trigger install_jobs_mark_delivered
  after update on public.install_jobs
  for each row execute function public.install_jobs_mark_delivered();

create or replace function public.orders_after_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if new.delivered_at is not null and old.delivered_at is null then
    n := public.start_serial_warranties(new.id);
    perform public.log_lead_activity(new.lead_id, format('Order %s delivered %s: warranty started for %s serial-numbered unit%s.',
      new.order_number, to_char(new.delivered_at at time zone 'Asia/Kolkata', 'DD Mon YYYY'), n, case when n = 1 then '' else 's' end));
  end if;
  return new;
end;
$$;

drop trigger if exists orders_after_delivery on public.orders;
create trigger orders_after_delivery
  after update on public.orders
  for each row execute function public.orders_after_delivery();

-- Panels scanned on the roof (after delivery) get their warranty straight away
create or replace function public.order_serials_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.start_serial_warranties(new.order_id);
  return new;
end;
$$;

drop trigger if exists order_serials_after_insert on public.order_serials;
create trigger order_serials_after_insert
  after insert on public.order_serials
  for each row execute function public.order_serials_after_insert();

-- Office / warehouse can mark a dispatched order delivered (e.g. goods dropped before the crew's day)
create or replace function public.mark_delivered(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.is_office() or public.is_warehouse()) then
    raise exception 'Not allowed';
  end if;
  update public.orders set delivered_at = now()
  where id = p_order_id and delivered_at is null and status in ('dispatched', 'installed', 'completed');
  if not found then
    raise exception 'Only a dispatched order that isn''t delivered yet can be marked delivered';
  end if;
end;
$$;

-- Existing deliveries: the crew's start time, or the dispatch time
update public.orders o
  set delivered_at = coalesce((select j.started_at from public.install_jobs j where j.order_id = o.id and j.started_at is not null), o.dispatched_at)
  where o.delivered_at is null and o.status in ('dispatched', 'installed', 'completed')
    and (o.dispatched_at is not null or exists (select 1 from public.install_jobs j where j.order_id = o.id and j.started_at is not null));
select public.start_serial_warranties(id) from public.orders where delivered_at is not null;

-- Find a customer and their units in seconds: by serial number, phone, client ID or name
create or replace function public.search_serials(p_query text)
returns table (serial_id uuid, serial_no text, product text, category text, lead_id uuid, client_name text, client_code text,
               phone text, location text, order_id uuid, order_number text, delivered_on date, warranty_start date, warranty_end date,
               in_warranty boolean, open_tickets bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.serial_no, p.name, p.category, l.id, l.name, l.client_code, l.phone, l.location, o.id, o.order_number,
         (o.delivered_at at time zone 'Asia/Kolkata')::date, s.warranty_start, s.warranty_end,
         s.warranty_end is not null and s.warranty_end >= (now() at time zone 'Asia/Kolkata')::date,
         (select count(*) from public.service_tickets t where t.order_id = o.id and t.status in ('open', 'scheduled', 'in_progress'))
  from public.order_serials s
  join public.products p on p.id = s.product_id
  join public.orders o on o.id = s.order_id
  join public.leads l on l.id = o.lead_id
  where public.is_office() and length(trim(coalesce(p_query, ''))) >= 3
    and (upper(s.serial_no) like '%' || upper(trim(p_query)) || '%'
         or replace(l.phone, '+91', '') like '%' || regexp_replace(p_query, '\D', '', 'g') || '%' and length(regexp_replace(p_query, '\D', '', 'g')) >= 5
         or l.client_code ilike trim(p_query)
         or l.name ilike '%' || trim(p_query) || '%')
  order by l.name, p.category, s.serial_no
  limit 40;
$$;

-- A ticket can name the exact unit; its own warranty then decides free or chargeable
alter table public.service_tickets
  add column if not exists serial_id uuid references public.order_serials (id) on delete set null,
  add column if not exists customer_confirmed_at timestamptz,
  add column if not exists confirmed_via text check (confirmed_via is null or confirmed_via in ('portal', 'phone', 'whatsapp'));

-- Runs after service_tickets_before_write (triggers fire in name order)
create or replace function public.service_tickets_unit_warranty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
begin
  -- An inverter fault without a unit named: use the system's inverter
  if tg_op = 'INSERT' and new.serial_id is null and new.category = 'inverter_error' and new.order_id is not null then
    select os.id into new.serial_id from public.order_serials os join public.products p on p.id = os.product_id
    where os.order_id = new.order_id and p.category = 'inverter' order by os.scanned_at limit 1;
  end if;
  if new.serial_id is not null and new.category not in ('physical_damage', 'checkup')
     and (tg_op = 'INSERT' or new.serial_id is distinct from old.serial_id) then
    select os.serial_no, os.warranty_start, os.warranty_end, os.warranty_months, os.order_id, p.name into s
    from public.order_serials os join public.products p on p.id = os.product_id where os.id = new.serial_id;
    if s.warranty_end is not null then
      new.order_id := coalesce(new.order_id, s.order_id);
      new.warranty_status := case when s.warranty_end >= (now() at time zone 'Asia/Kolkata')::date then 'in_warranty' else 'out_of_warranty' end;
      new.warranty_note := format('%s S/N %s: %s months from delivery %s, %s %s', s.name, s.serial_no, s.warranty_months,
        to_char(s.warranty_start, 'DD Mon YYYY'), case when new.warranty_status = 'in_warranty' then 'valid until' else 'expired on' end,
        to_char(s.warranty_end, 'DD Mon YYYY'));
      new.chargeable := new.warranty_status <> 'in_warranty';
    end if;
  end if;

  -- A breakdown is closed only once the customer confirms everything works
  if new.kind = 'breakdown' and new.status = 'closed' and (tg_op = 'INSERT' or old.status is distinct from 'closed')
     and new.customer_confirmed_at is null then
    raise exception 'Close the ticket once the customer confirms everything works (portal rating, or "Customer confirmed")';
  end if;
  return new;
end;
$$;

drop trigger if exists service_tickets_zz_unit_warranty on public.service_tickets;
create trigger service_tickets_zz_unit_warranty
  before insert or update on public.service_tickets
  for each row execute function public.service_tickets_unit_warranty();

-- =================================================================
-- 5. The crew confirms the installed system size before completing
-- =================================================================

alter table public.install_jobs add column if not exists installed_kw numeric check (installed_kw is null or installed_kw > 0);

create or replace function public.confirm_installed_size(p_job_id uuid, p_kw numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j record;
begin
  if not (public.is_office() or public.on_job_crew(p_job_id)) then
    raise exception 'This job isn''t assigned to your crew';
  end if;
  select ij.*, o.system_size_kw, o.order_number into j
  from public.install_jobs ij join public.orders o on o.id = ij.order_id where ij.id = p_job_id;
  if not found or j.status <> 'in_progress' then
    raise exception 'Start the installation first';
  end if;
  if p_kw is null or p_kw <= 0 or p_kw > 100 then
    raise exception 'Enter the installed system size in kW';
  end if;
  update public.install_jobs set installed_kw = p_kw where id = p_job_id;
  if abs(p_kw - coalesce(j.system_size_kw, p_kw)) > 0.05 then
    perform set_config('app.internal', 'on', true);
    perform public.log_lead_activity(j.lead_id, format('%s: installed size %s kW differs from the ordered %s kW. Please check.',
      j.order_number, p_kw, j.system_size_kw));
    perform set_config('app.internal', 'off', true);
  end if;
end;
$$;

create or replace function public.install_jobs_need_size()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' and new.installed_kw is null then
    raise exception 'Confirm the installed system size (kW) before completing';
  end if;
  return new;
end;
$$;

drop trigger if exists install_jobs_need_size on public.install_jobs;
create trigger install_jobs_need_size
  before update on public.install_jobs
  for each row execute function public.install_jobs_need_size();

-- my_install_jobs: the crew needs to see / confirm the installed size (new column, so recreated)
drop function if exists public.my_install_jobs();
create function public.my_install_jobs()
returns table (job_id uuid, scheduled_date date, time_slot text, job_status text, crew_name text,
               client_code text, client_name text, area text, system_size_kw numeric, system_type text,
               order_number text, order_status text, packing_status text, items jsonb,
               started_at timestamptz, finished_at timestamptz, checklist jsonb, photos jsonb,
               generation_kwh numeric, install_notes text, signed_by_name text, signature_path text, installed_kw numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.scheduled_date, j.time_slot, j.status, c.name,
         l.client_code, l.name, l.location, o.system_size_kw, o.system_type,
         o.order_number, o.status,
         case when o.status in ('dispatched', 'installed', 'completed') then 'Dispatched'
              when o.status = 'packed' then 'Packed'
              when o.status = 'packing' then 'Packing' else 'Not packed' end,
         coalesce((
           select jsonb_agg(jsonb_build_object('id', oi.id, 'description', oi.description, 'qty', oi.qty, 'unit', oi.unit,
                    'packed_qty', oi.packed_qty, 'site_serial', p.category = 'panel',
                    'serials', coalesce((select jsonb_agg(s.serial_no order by s.scanned_at)
                                         from public.order_serials s where s.order_item_id = oi.id), '[]'::jsonb),
                    'serial_list', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'serial_no', s.serial_no) order by s.scanned_at)
                                             from public.order_serials s where s.order_item_id = oi.id), '[]'::jsonb))
                  order by oi.description)
           from public.order_items oi
           join public.products p on p.id = oi.product_id
           where oi.order_id = o.id and not oi.is_service
         ), '[]'::jsonb),
         j.started_at, j.finished_at, j.checklist, j.photos, j.generation_kwh, j.install_notes, j.signed_by_name, j.signature_path, j.installed_kw
  from public.install_jobs j
  join public.orders o on o.id = j.order_id
  join public.leads l on l.id = j.lead_id
  left join public.crews c on c.id = j.crew_id
  where (public.is_technician() or public.is_office())
    and j.status <> 'cancelled'
    and (j.scheduled_date >= (now() at time zone 'Asia/Kolkata')::date - 7 or j.status = 'in_progress')
    and (public.is_office() or public.on_job_crew(j.id))
  order by j.scheduled_date, j.time_slot;
$$;

-- =================================================================
-- 6. Director: any period (today / this week / this month), with the period before for comparison
-- =================================================================

create or replace function public.director_period(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_len int := greatest(1, p_to - p_from);
  t0 timestamptz := p_from::timestamp at time zone 'Asia/Kolkata';
  t1 timestamptz := p_to::timestamp at time zone 'Asia/Kolkata';
begin
  if not public.is_manager() then
    raise exception 'Only the owner and managers can see the director''s dashboard';
  end if;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'now', public.month_kpis(p_from, p_to),
    'prev', public.month_kpis(p_from - v_len, p_from),
    'jobs', (select coalesce(jsonb_agg(to_jsonb(j) order by j.profit), '[]'::jsonb) from public.job_profit(
      array(select id from public.orders where installed_at >= t0 and installed_at < t1 and status <> 'cancelled')) j),
    'purchases', (select jsonb_build_object('total', coalesce(sum(total), 0), 'count', count(*))
                  from public.purchases where bill_date >= p_from and bill_date < p_to),
    'purchases_prev', (select coalesce(sum(total), 0) from public.purchases where bill_date >= p_from - v_len and bill_date < p_from),
    'open_repairs', (select count(*) from public.service_tickets where kind = 'breakdown' and status in ('open', 'scheduled', 'in_progress'))
  );
end;
$$;

-- =================================================================
-- 7. Security
-- =================================================================

alter table public.purchases enable row level security;
revoke all on public.purchases from anon;
revoke insert, update, delete on public.purchases from authenticated;
drop policy if exists "office read purchases" on public.purchases;
create policy "office read purchases" on public.purchases for select to authenticated using (public.is_office());

do $$
declare f text;
begin
  foreach f in array array[
    'public.record_purchase(text, text, text, date, jsonb, numeric, text)', 'public.mark_delivered(uuid)',
    'public.search_serials(text)', 'public.confirm_installed_size(uuid, numeric)', 'public.director_period(date, date)',
    'public.my_install_jobs()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  execute 'revoke all on function public.start_serial_warranties(uuid) from public, anon, authenticated';
end;
$$;
