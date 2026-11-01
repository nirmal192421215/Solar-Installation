-- =================================================================
-- Sun Power: after-sales service. Breakdown tickets (rainy season), warranty + SLA,
-- technician service visits, pre-monsoon checkup campaigns, customer portal links.
-- Run after installation.sql. Safe to run again. (Re-run it after re-running orders.sql or installation.sql.)
-- =================================================================

-- =================================================================
-- 1. Customer portal links (a private link per customer; only its hash is stored)
-- =================================================================

alter table public.leads
  add column if not exists portal_token_hash       text,
  add column if not exists portal_token_created_at timestamptz;

create unique index if not exists leads_portal_token_idx on public.leads (portal_token_hash) where portal_token_hash is not null;

-- New link for a customer (the old one stops working). Returns the token once; only its hash is kept.
create or replace function public.issue_portal_token(p_lead_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not (public.is_office() or public.is_internal()) then
    raise exception 'Not allowed';
  end if;
  update public.leads
    set portal_token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), portal_token_created_at = now()
    where id = p_lead_id;
  if not found then
    raise exception 'Lead not found';
  end if;
  perform public.log_lead_activity(p_lead_id, 'Customer portal link created (any earlier link no longer works).');
  return v_token;
end;
$$;

-- =================================================================
-- 2. Tickets and campaigns
-- =================================================================

create sequence if not exists public.ticket_number_seq;
grant usage on sequence public.ticket_number_seq to authenticated;

create table if not exists public.service_campaigns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  start_date  date not null,
  end_date    date not null check (end_date >= start_date),
  created_by  text,
  created_at  timestamptz not null default now()
);

create table if not exists public.service_tickets (
  id                  uuid primary key default gen_random_uuid(),
  ticket_number       text not null unique
                      default ('SP-TKT-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY') || '-' ||
                               lpad(nextval('public.ticket_number_seq')::text, 4, '0')),
  lead_id             uuid not null references public.leads (id) on delete cascade,
  order_id            uuid references public.orders (id) on delete set null,
  campaign_id         uuid references public.service_campaigns (id) on delete set null,
  kind                text not null default 'breakdown' check (kind in ('breakdown', 'checkup')),
  category            text not null default 'other'
                      check (category in ('safety', 'no_generation', 'low_generation', 'inverter_error', 'tripping',
                                          'water_leak', 'physical_damage', 'wiring', 'checkup', 'other')),
  priority            text check (priority in ('urgent', 'high', 'normal', 'low')),
  description         text,
  source              text not null default 'crm' check (source in ('crm', 'portal', 'campaign', 'whatsapp')),
  status              text not null default 'open'
                      check (status in ('open', 'scheduled', 'in_progress', 'resolved', 'closed', 'cancelled')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          text,
  sla_due_at          timestamptz,
  sla_met             boolean,
  warranty_status     text check (warranty_status in ('in_warranty', 'out_of_warranty', 'not_covered', 'unknown')),
  warranty_note       text,
  chargeable          boolean not null default false,
  charge_amount       numeric(12, 2),
  crew_id             uuid references public.crews (id),
  visit_date          date,
  visit_slot          text check (visit_slot is null or visit_slot in ('Morning 9–1', 'Afternoon 2–6')),
  started_at          timestamptz,
  started_by          text,
  safety_checklist    jsonb not null default '{}'::jsonb,
  resolved_at         timestamptz,
  resolved_by         text,
  cause               text,
  work_done           text,
  checklist           jsonb not null default '{}'::jsonb,
  parts               jsonb not null default '[]'::jsonb,
  photos              jsonb not null default '[]'::jsonb,  -- "<ticket id>/<customer|before|after|other>-<random>.jpg"
  generation_kwh      numeric,
  signed_by_name      text,
  signature_path      text,
  customer_rating     int check (customer_rating between 1 and 5),
  customer_feedback   text,
  closed_at           timestamptz,
  notified            jsonb not null default '{}'::jsonb   -- which customer WhatsApps went out (send-whatsapp)
);

create index if not exists service_tickets_status_idx on public.service_tickets (status, sla_due_at);
create index if not exists service_tickets_lead_idx on public.service_tickets (lead_id);
create index if not exists service_tickets_visit_idx on public.service_tickets (visit_date, crew_id);

-- What the customer gets for each category, and how fast we respond
create or replace function public.ticket_default_priority(p_category text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_category
    when 'safety' then 'urgent'
    when 'no_generation' then 'high' when 'water_leak' then 'high' when 'tripping' then 'high'
    when 'checkup' then 'low'
    else 'normal' end;
$$;

create or replace function public.ticket_sla_hours(p_priority text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_priority when 'urgent' then 4 when 'high' then 24 when 'normal' then 72 else 168 end;
$$;

-- Checks during a pre-monsoon checkup (the technician must tick all of them)
create or replace function public.checkup_checklist_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['panels_cleaned', 'earthing_tested', 'cables_checked', 'junctions_sealed', 'structure_tightened',
               'inverter_checked', 'acdb_spd', 'drainage_clear'];
$$;

-- Warranty for this problem: from the installation date and the warranties that apply
create or replace function public.ticket_warranty(p_order_id uuid, p_category text)
returns table (status text, note text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_installed date;
  v_months int;
  v_what text;
  v_until date;
begin
  select coalesce(o.installed_at, j.finished_at)::date into v_installed
  from public.orders o left join public.install_jobs j on j.order_id = o.id and j.status = 'done'
  where o.id = p_order_id;
  if p_category = 'checkup' then
    return query select 'in_warranty'::text, 'Free checkup'::text;
    return;
  end if;
  if p_category = 'physical_damage' then
    return query select 'not_covered'::text, 'Storm / physical damage is not covered by warranty (insurance claim). Repairs are chargeable.'::text;
    return;
  end if;
  if v_installed is null then
    return query select 'unknown'::text, 'No installation date on record'::text;
    return;
  end if;
  if p_category = 'inverter_error' then
    select coalesce(max(p.warranty_months), 24) into v_months
    from public.order_items oi join public.products p on p.id = oi.product_id
    where oi.order_id = p_order_id and p.category = 'inverter';
    v_what := 'Inverter warranty';
  else
    select coalesce(nullif(settings ->> 'workmanship_warranty_months', '')::int, 60) into v_months
    from public.quote_settings where id = 1;
    v_months := coalesce(v_months, 60);
    v_what := 'Installation (workmanship) warranty';
  end if;
  v_until := v_installed + make_interval(months => v_months);
  return query select
    case when current_date <= v_until then 'in_warranty' else 'out_of_warranty' end,
    format('%s %s months from %s: %s %s', v_what, v_months, to_char(v_installed, 'DD Mon YYYY'),
           case when current_date <= v_until then 'valid until' else 'expired on' end, to_char(v_until, 'DD Mon YYYY'));
end;
$$;

create or replace function public.service_tickets_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  w record;
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    -- The customer's installed order, if not given
    if new.order_id is null then
      select id into new.order_id from public.orders
      where lead_id = new.lead_id and status in ('installed', 'completed', 'dispatched')
      order by created_at desc limit 1;
    end if;
    if new.kind = 'checkup' then new.category := 'checkup'; end if;
    new.priority := coalesce(new.priority, public.ticket_default_priority(new.category));
    new.created_by := coalesce(new.created_by, auth.jwt() ->> 'email', 'system');
    select * into w from public.ticket_warranty(new.order_id, new.category);
    new.warranty_status := w.status;
    new.warranty_note := w.note;
    new.chargeable := w.status in ('out_of_warranty', 'not_covered');
  end if;

  -- Response deadline: breakdowns by priority; checkups by the campaign's last day
  if new.kind = 'breakdown' and (tg_op = 'INSERT' or new.priority is distinct from old.priority) then
    new.sla_due_at := new.created_at + make_interval(hours => public.ticket_sla_hours(new.priority));
  elsif new.kind = 'checkup' and new.sla_due_at is null then
    select (end_date + 1)::timestamp at time zone 'Asia/Kolkata' into new.sla_due_at from public.service_campaigns where id = new.campaign_id;
  end if;

  -- A visit with a crew and a date is scheduled
  if new.status = 'open' and new.crew_id is not null and new.visit_date is not null then
    new.status := 'scheduled';
  end if;
  if new.status = 'resolved' and new.resolved_at is null then new.resolved_at := now(); end if;
  if new.status = 'resolved' and new.sla_met is null then new.sla_met := new.resolved_at <= coalesce(new.sla_due_at, new.resolved_at); end if;
  if new.status = 'closed' and new.closed_at is null then new.closed_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists service_tickets_before_write on public.service_tickets;
create trigger service_tickets_before_write
  before insert or update on public.service_tickets
  for each row execute function public.service_tickets_before_write();

-- Activity on the lead + WhatsApp to the customer (created / visit booked / resolved)
create or replace function public.service_tickets_after_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event text;
  v_label text := replace(new.category, '_', ' ');
begin
  if tg_op = 'INSERT' then
    perform public.log_lead_activity(new.lead_id, format('%s %s opened (%s, %s priority%s). %s',
      case when new.kind = 'checkup' then 'Checkup' else 'Service ticket' end, new.ticket_number, v_label, new.priority,
      case when new.source = 'portal' then ', reported on the customer portal' else '' end, coalesce(new.warranty_note, '')));
    v_event := case when new.kind = 'breakdown' then 'created' end;
  end if;
  if new.status = 'scheduled' and new.visit_date is not null
     and (tg_op = 'INSERT' or old.visit_date is distinct from new.visit_date or old.crew_id is distinct from new.crew_id
          or old.status is distinct from new.status) then
    v_event := 'scheduled';
    perform public.log_lead_activity(new.lead_id, format('%s: visit booked for %s, %s.', new.ticket_number,
      to_char(new.visit_date, 'Dy DD Mon'), coalesce(new.visit_slot, 'time to be confirmed')));
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'resolved' then
      v_event := 'resolved';
    end if;
    if new.status in ('in_progress', 'resolved', 'closed', 'cancelled') then
      perform public.log_lead_activity(new.lead_id, format('%s: %s → %s.', new.ticket_number,
        replace(old.status, '_', ' '), replace(new.status, '_', ' ')));
    end if;
  end if;

  if v_event is not null then
    perform net.http_post(
      url     := 'https://iekfgtyfwmplsauutegs.supabase.co/functions/v1/send-whatsapp',
      body    := jsonb_build_object('kind', 'ticket', 'ticket_id', new.id, 'event', v_event),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  end if;
  return new;
end;
$$;

drop trigger if exists service_tickets_after_write on public.service_tickets;
create trigger service_tickets_after_write
  after insert or update on public.service_tickets
  for each row execute function public.service_tickets_after_write();

-- =================================================================
-- 3. Crew capacity: installations and service visits share the day
--    (full-day install 2, half-day install 1, breakdown visit 1, checkup ½; a crew has 2 per day)
-- =================================================================

drop function if exists public.crew_day_load(uuid, date, uuid);
create function public.crew_day_load(p_crew_id uuid, p_date date, p_exclude_job uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select sum(case when time_slot = 'Full day' then 2 else 1 end)
    from public.install_jobs
    where crew_id = p_crew_id and scheduled_date = p_date and status <> 'cancelled'
      and (p_exclude_job is null or id <> p_exclude_job)
  ), 0) + coalesce((
    select sum(case when kind = 'checkup' then 0.5 else 1 end)
    from public.service_tickets
    where crew_id = p_crew_id and visit_date = p_date and status in ('scheduled', 'in_progress')
      and (p_exclude_job is null or id <> p_exclude_job)
  ), 0);
$$;

-- Is the logged-in technician on this crew?
create or replace function public.on_crew(p_crew_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.crews c
    left join public.crew_members m on m.crew_id = c.id
    where c.id = p_crew_id
      and (lower(c.lead_technician_email) = lower(auth.jwt() ->> 'email')
           or lower(m.staff_email) = lower(auth.jwt() ->> 'email'))
  );
$$;

-- =================================================================
-- 4. Pre-monsoon checkup campaign: one checkup per installed customer, spread over crew days
-- =================================================================

create or replace function public.create_checkup_campaign(p_name text, p_start date, p_end date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign uuid;
  r record;
  c record;
  v_day date;
  v_load numeric;
  v_done boolean;
  v_created int := 0;
  v_scheduled int := 0;
begin
  if not public.is_office() then
    raise exception 'Not allowed';
  end if;
  if p_end < p_start then
    raise exception 'The end date is before the start date';
  end if;
  insert into public.service_campaigns (name, start_date, end_date, created_by)
  values (coalesce(nullif(trim(p_name), ''), 'Pre-monsoon checkup'), p_start, p_end, auth.jwt() ->> 'email')
  returning id into v_campaign;

  -- Installed customers without an open checkup, grouped by area so a crew's day stays in one place
  for r in
    select o.id as order_id, o.lead_id
    from public.orders o join public.leads l on l.id = o.lead_id
    where o.status in ('installed', 'completed')
      and not exists (select 1 from public.service_tickets t
                      where t.order_id = o.id and t.kind = 'checkup' and t.status in ('open', 'scheduled', 'in_progress'))
    order by l.location, l.name
  loop
    -- Earliest working day in the window where some active crew has room for ½ a unit
    v_done := false;
    v_day := greatest(p_start, (now() at time zone 'Asia/Kolkata')::date + 1);
    while v_day <= p_end and not v_done loop
      if extract(dow from v_day) <> 0 then
        for c in select id from public.crews where active order by name loop
          v_load := public.crew_day_load(c.id, v_day);
          if v_load + 0.5 <= 2 then
            insert into public.service_tickets (lead_id, order_id, campaign_id, kind, source, description, crew_id, visit_date, visit_slot)
            values (r.lead_id, r.order_id, v_campaign, 'checkup', 'campaign', coalesce(nullif(trim(p_name), ''), 'Pre-monsoon checkup'),
                    c.id, v_day, case when v_load < 1 then 'Morning 9–1' else 'Afternoon 2–6' end);
            v_scheduled := v_scheduled + 1;
            v_done := true;
            exit;
          end if;
        end loop;
      end if;
      v_day := v_day + 1;
    end loop;
    if not v_done then
      -- No room left in the window: the office schedules it by hand
      insert into public.service_tickets (lead_id, order_id, campaign_id, kind, source, description)
      values (r.lead_id, r.order_id, v_campaign, 'checkup', 'campaign', coalesce(nullif(trim(p_name), ''), 'Pre-monsoon checkup'));
    end if;
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object('campaign_id', v_campaign, 'tickets', v_created, 'scheduled', v_scheduled, 'unscheduled', v_created - v_scheduled);
end;
$$;

-- =================================================================
-- 5. Technician service visits
-- =================================================================

create or replace function public.my_service_visits()
returns table (ticket_id uuid, ticket_number text, kind text, category text, priority text, status text, description text,
               visit_date date, visit_slot text, crew_name text, sla_due_at timestamptz, warranty_status text, warranty_note text,
               client_code text, client_name text, area text, system_size_kw numeric, system_type text, installed_at timestamptz,
               serials jsonb, customer_photos jsonb, started_at timestamptz, resolved_at timestamptz, cause text, work_done text,
               checklist jsonb, parts jsonb, photos jsonb, generation_kwh numeric, signed_by_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.ticket_number, t.kind, t.category, t.priority, t.status, t.description,
         t.visit_date, t.visit_slot, c.name, t.sla_due_at, t.warranty_status, t.warranty_note,
         l.client_code, l.name, l.location, o.system_size_kw, o.system_type, o.installed_at,
         coalesce((select jsonb_agg(jsonb_build_object('description', oi.description, 'serial_no', s.serial_no) order by oi.description, s.serial_no)
                   from public.order_serials s join public.order_items oi on oi.id = s.order_item_id
                   where s.order_id = t.order_id), '[]'::jsonb),
         coalesce((select jsonb_agg(p) from jsonb_array_elements_text(t.photos) p where p like '%/customer-%'), '[]'::jsonb),
         t.started_at, t.resolved_at, t.cause, t.work_done, t.checklist, t.parts,
         coalesce((select jsonb_agg(p) from jsonb_array_elements_text(t.photos) p where p not like '%/customer-%'), '[]'::jsonb),
         t.generation_kwh, t.signed_by_name
  from public.service_tickets t
  join public.leads l on l.id = t.lead_id
  left join public.orders o on o.id = t.order_id
  left join public.crews c on c.id = t.crew_id
  where (public.is_technician() or public.is_office())
    and t.crew_id is not null
    and (t.status in ('scheduled', 'in_progress') or (t.status in ('resolved', 'closed') and t.resolved_at > now() - interval '7 days'))
    and (public.is_office() or public.on_crew(t.crew_id))
  order by t.visit_date nulls last, t.visit_slot;
$$;

create or replace function public.start_service_visit(p_ticket_id uuid, p_safety jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.service_tickets;
begin
  select * into t from public.service_tickets where id = p_ticket_id for update;
  if not found or not (public.is_office() or public.on_crew(t.crew_id)) then
    raise exception 'This visit isn''t assigned to your crew';
  end if;
  if t.status = 'in_progress' then
    return; -- already started
  end if;
  if t.status <> 'scheduled' then
    raise exception 'This visit is %', replace(t.status, '_', ' ');
  end if;
  if exists (select 1 from unnest(public.install_safety_keys()) k where coalesce(p_safety ->> k, 'false') <> 'true') then
    raise exception 'Confirm every safety check before starting';
  end if;
  update public.service_tickets
    set status = 'in_progress', started_at = now(), started_by = auth.jwt() ->> 'email', safety_checklist = p_safety
    where id = p_ticket_id;
end;
$$;

-- Only "<ticket id>/before-…", "/after-…", "/other-…" files the crew uploaded
create or replace function public.clean_ticket_photos(p_ticket_id uuid, p_photos jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(p), '[]'::jsonb)
  from jsonb_array_elements_text(case when jsonb_typeof(p_photos) = 'array' then p_photos else '[]'::jsonb end) p
  where p ~ ('^' || p_ticket_id::text || '/(before|after|other)-[A-Za-z0-9-]+\.(jpg|jpeg|png)$');
$$;

create or replace function public.save_service_visit(p_ticket_id uuid, p_cause text, p_work_done text, p_checklist jsonb,
                                                     p_photos jsonb, p_generation_kwh numeric default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.service_tickets;
begin
  select * into t from public.service_tickets where id = p_ticket_id for update;
  if not found or not (public.is_office() or public.on_crew(t.crew_id)) then
    raise exception 'This visit isn''t assigned to your crew';
  end if;
  if t.status <> 'in_progress' then
    raise exception 'Start the visit first';
  end if;
  update public.service_tickets
    set cause = left(nullif(trim(p_cause), ''), 1000), work_done = left(nullif(trim(p_work_done), ''), 2000),
        checklist = case when jsonb_typeof(p_checklist) = 'object' then p_checklist else '{}'::jsonb end,
        -- customer photos stay; the crew's photos are replaced
        photos = coalesce((select jsonb_agg(p) from jsonb_array_elements_text(t.photos) p where p like '%/customer-%'), '[]'::jsonb)
                 || public.clean_ticket_photos(p_ticket_id, p_photos),
        generation_kwh = p_generation_kwh
    where id = p_ticket_id;
end;
$$;

create or replace function public.complete_service_visit(p_ticket_id uuid, p_cause text, p_work_done text, p_checklist jsonb,
                                                         p_parts jsonb, p_photos jsonb, p_generation_kwh numeric,
                                                         p_signed_by text, p_signature_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.service_tickets;
  v_photos jsonb := public.clean_ticket_photos(p_ticket_id, p_photos);
  v_missing text;
  it jsonb;
  p public.products;
  v_qty numeric;
  v_parts jsonb := '[]'::jsonb;
  v_parts_value numeric := 0;
  v_visit_charge numeric;
begin
  select * into t from public.service_tickets where id = p_ticket_id for update;
  if not found or not (public.is_office() or public.on_crew(t.crew_id)) then
    raise exception 'This visit isn''t assigned to your crew';
  end if;
  if t.status <> 'in_progress' then
    raise exception 'Start the visit first';
  end if;

  if not exists (select 1 from jsonb_array_elements_text(v_photos) x where x like '%/before-%')
     or not exists (select 1 from jsonb_array_elements_text(v_photos) x where x like '%/after-%') then
    raise exception 'Add a BEFORE and an AFTER photo';
  end if;
  if t.kind = 'checkup' then
    select string_agg(k, ', ') into v_missing
    from unnest(public.checkup_checklist_keys()) k where coalesce(p_checklist ->> k, 'false') <> 'true';
    if v_missing is not null then
      raise exception 'Tick every checkup item first';
    end if;
  elsif nullif(trim(p_cause), '') is null or nullif(trim(p_work_done), '') is null then
    raise exception 'Write the cause you found and the work you did';
  end if;
  if p_generation_kwh is null or p_generation_kwh < 0 then
    raise exception 'Enter the generation reading after the visit (kWh)';
  end if;
  if nullif(trim(p_signed_by), '') is null or coalesce(p_signature_path, '') not like p_ticket_id::text || '/signature%' then
    raise exception 'The customer''s name and signature are needed';
  end if;

  -- Parts used come out of stock
  perform set_config('app.internal', 'on', true);
  for it in select * from jsonb_array_elements(case when jsonb_typeof(p_parts) = 'array' then p_parts else '[]'::jsonb end) loop
    v_qty := nullif(it ->> 'qty', '')::numeric;
    if v_qty is null or v_qty <= 0 then
      continue;
    end if;
    select * into p from public.products where id = (it ->> 'product_id')::uuid;
    if not found or p.is_service then
      raise exception 'Unknown part';
    end if;
    perform public.move_stock(p.id, -v_qty, 'adjustment', null, 'Used on ' || t.ticket_number);
    v_parts := v_parts || jsonb_build_object('product_id', p.id, 'sku', p.sku, 'description', p.name, 'qty', v_qty,
                                             'unit', p.unit, 'unit_price', p.sell_price);
    v_parts_value := v_parts_value + v_qty * p.sell_price;
  end loop;

  select coalesce(nullif(settings ->> 'service_visit_charge', '')::numeric, 500) into v_visit_charge from public.quote_settings where id = 1;
  update public.service_tickets
    set status = 'resolved', resolved_by = auth.jwt() ->> 'email',
        cause = left(nullif(trim(p_cause), ''), 1000), work_done = left(nullif(trim(p_work_done), ''), 2000),
        checklist = case when jsonb_typeof(p_checklist) = 'object' then p_checklist else '{}'::jsonb end,
        parts = v_parts,
        photos = coalesce((select jsonb_agg(x) from jsonb_array_elements_text(t.photos) x where x like '%/customer-%'), '[]'::jsonb) || v_photos,
        generation_kwh = p_generation_kwh, signed_by_name = left(trim(p_signed_by), 120), signature_path = p_signature_path,
        charge_amount = case when t.chargeable then round(v_parts_value + coalesce(v_visit_charge, 500), 2) else 0 end
    where id = p_ticket_id;
  perform set_config('app.internal', 'off', true);
end;
$$;

-- Parts list for the technician's form: names and stock only (no prices)
create or replace function public.service_parts()
returns table (product_id uuid, sku text, name text, unit text, available numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.sku, p.name, p.unit, p.stock_qty - p.reserved_qty
  from public.products p
  where (public.is_technician() or public.is_office()) and p.active and not p.is_service
  order by p.category, p.name;
$$;

-- =================================================================
-- 6. Security
-- =================================================================

alter table public.service_tickets enable row level security;
alter table public.service_campaigns enable row level security;
revoke all on public.service_tickets, public.service_campaigns from anon;

drop policy if exists "office manage tickets" on public.service_tickets;
create policy "office manage tickets" on public.service_tickets for all to authenticated
  using (public.is_office()) with check (public.is_office());
drop policy if exists "office manage campaigns" on public.service_campaigns;
create policy "office manage campaigns" on public.service_campaigns for all to authenticated
  using (public.is_office()) with check (public.is_office());

do $$
declare f text;
begin
  foreach f in array array[
    'public.issue_portal_token(uuid)', 'public.ticket_warranty(uuid, text)', 'public.crew_day_load(uuid, date, uuid)',
    'public.on_crew(uuid)', 'public.create_checkup_campaign(text, date, date)', 'public.my_service_visits()',
    'public.start_service_visit(uuid, jsonb)', 'public.save_service_visit(uuid, text, text, jsonb, jsonb, numeric)',
    'public.complete_service_visit(uuid, text, text, jsonb, jsonb, jsonb, numeric, text, text)', 'public.service_parts()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- Private storage for service photos: "<ticket id>/<file>" (office, or the visit's crew; customers upload through the portal function)
create or replace function public.can_use_ticket_file(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return public.is_office() or (public.is_technician() and exists (
    select 1 from public.service_tickets t where t.id = split_part(p_name, '/', 1)::uuid and public.on_crew(t.crew_id)));
exception when others then
  return false; -- not a ticket folder
end;
$$;

insert into storage.buckets (id, name, public)
values ('service-photos', 'service-photos', false)
on conflict (id) do nothing;

drop policy if exists "service photos read" on storage.objects;
create policy "service photos read" on storage.objects
  for select to authenticated using (bucket_id = 'service-photos' and public.can_use_ticket_file(name));
drop policy if exists "service photos upload" on storage.objects;
create policy "service photos upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'service-photos' and public.can_use_ticket_file(name));
drop policy if exists "service photos replace" on storage.objects;
create policy "service photos replace" on storage.objects
  for update to authenticated using (bucket_id = 'service-photos' and public.can_use_ticket_file(name));
drop policy if exists "service photos remove" on storage.objects;
create policy "service photos remove" on storage.objects
  for delete to authenticated using (bucket_id = 'service-photos' and public.can_use_ticket_file(name));
