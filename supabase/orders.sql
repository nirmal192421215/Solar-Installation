-- Sun Power Solar CRM: kit templates, orders, payments, warehouse packing and install scheduling
-- Run once in Supabase (SQL Editor → New query → paste → Run), after engineer_portal.sql.
-- Safe to re-run.
--
-- Flow: approved survey → final quote from a kit template → customer accepts (CRM or WhatsApp)
--       → order → advance/full payment → order confirmed → stock reserved + packing list
--       → install job auto-scheduled on a crew → customer gets a WhatsApp confirmation.

create extension if not exists pg_net;

-- =================================================================
-- 0. Quote rule and the "Survey approved" stage
-- =================================================================

alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check
  check (status in ('new', 'ai_called', 'interested', 'survey_booked', 'survey_done', 'survey_approved',
                    'quote_sent', 'won', 'lost'));

-- Only after the survey is approved should the customer receive a quote (estimates are always allowed).
-- Checked on insert only, so existing quotes stay valid.
create or replace function public.quotes_need_approved_survey()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind in ('final', 'quote') and not exists (
    select 1 from public.surveys s where s.lead_id = new.lead_id and s.status = 'approved'
  ) then
    raise exception 'A final quote needs an approved site survey';
  end if;
  return new;
end;
$$;

drop trigger if exists quotes_need_approved_survey on public.quotes;
create trigger quotes_need_approved_survey
  before insert on public.quotes
  for each row execute function public.quotes_need_approved_survey();

-- A manager approving the survey moves the lead to "Survey approved" (forward only)
create or replace function public.surveys_after_approve()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    update public.leads set status = 'survey_approved'
      where id = new.lead_id and status in ('new', 'ai_called', 'interested', 'survey_booked', 'survey_done');
  end if;
  return new;
end;
$$;

drop trigger if exists surveys_after_approve on public.surveys;
create trigger surveys_after_approve
  after insert or update on public.surveys
  for each row execute function public.surveys_after_approve();

-- =================================================================
-- 1. Roles: warehouse and technician
-- =================================================================

alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check
  check (role in ('owner', 'manager', 'staff', 'engineer', 'warehouse', 'technician'));

create or replace function public.is_warehouse()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff
    where lower(email) = lower(auth.jwt() ->> 'email') and role = 'warehouse'
  );
$$;

create or replace function public.is_technician()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff
    where lower(email) = lower(auth.jwt() ->> 'email') and role = 'technician'
  );
$$;

-- Office staff: owner, manager and staff (not engineers, warehouse or technicians)
create or replace function public.is_office()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff
    where lower(email) = lower(auth.jwt() ->> 'email') and role in ('owner', 'manager', 'staff')
  );
$$;

-- The service role (Edge Functions) and database triggers run the automation
create or replace function public.is_internal()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role' or pg_trigger_depth() > 0;
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.log_lead_activity(p_lead_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.is_office() or public.is_internal()) then
    raise exception 'Not allowed';
  end if;
  insert into public.lead_activities (lead_id, type, body, created_by)
  values (p_lead_id, 'note', left(p_body, 5000), coalesce(auth.jwt() ->> 'email', 'system'));
end;
$$;

-- =================================================================
-- 2. Products and stock
-- =================================================================

create table if not exists public.products (
  id               uuid primary key default gen_random_uuid(),
  sku              text not null unique,
  name             text not null,
  category         text not null check (category in ('panel', 'inverter', 'battery', 'charge_controller', 'structure',
                     'dc_cable', 'ac_cable', 'acdb_dcdb', 'earthing', 'lightning_arrestor', 'connector', 'service', 'other')),
  unit             text not null default 'pcs' check (unit in ('pcs', 'm', 'set', 'kw', 'job')),
  cost_price       numeric(12, 2) not null default 0,
  sell_price       numeric(12, 2) not null default 0,
  gst_percent      numeric not null default 12,
  stock_qty        numeric not null default 0 check (stock_qty >= 0),
  reserved_qty     numeric not null default 0 check (reserved_qty >= 0),
  low_stock_level  numeric not null default 0,
  serial_tracked   boolean not null default false,
  warranty_months  int,
  is_service       boolean not null default false,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

create table if not exists public.stock_movements (
  id          bigint generated always as identity primary key,
  product_id  uuid not null references public.products (id) on delete cascade,
  qty         numeric not null,
  type        text not null check (type in ('purchase', 'adjustment', 'reserve', 'unreserve', 'dispatch', 'return')),
  order_id    uuid,
  note        text,
  created_by  text,
  created_at  timestamptz not null default now()
);

create index if not exists stock_movements_product_idx on public.stock_movements (product_id, created_at desc);

-- The only way stock changes. Returns the product's available quantity afterwards.
create or replace function public.move_stock(p_product_id uuid, p_qty numeric, p_type text,
                                             p_order_id uuid default null, p_note text default null)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.products;
  q numeric := abs(coalesce(p_qty, 0));
  signed numeric;
begin
  if not (public.is_office() or public.is_internal()) then
    raise exception 'Not allowed';
  end if;
  if q = 0 then
    raise exception 'Quantity must not be zero';
  end if;
  select * into v from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product not found';
  end if;
  if v.is_service then
    raise exception 'Services are not stocked';
  end if;

  case p_type
    when 'purchase', 'return' then
      update public.products set stock_qty = stock_qty + q where id = v.id;
      signed := q;
    when 'adjustment' then
      if v.stock_qty + p_qty < 0 then
        raise exception 'Stock cannot go below zero (in stock: %)', v.stock_qty;
      end if;
      update public.products set stock_qty = stock_qty + p_qty where id = v.id;
      signed := p_qty;
    when 'reserve' then
      update public.products set reserved_qty = reserved_qty + q where id = v.id;
      signed := q;
    when 'unreserve' then
      update public.products set reserved_qty = greatest(reserved_qty - q, 0) where id = v.id;
      signed := -q;
    when 'dispatch' then
      if v.stock_qty < q then
        raise exception 'Not enough stock to dispatch (in stock: %)', v.stock_qty;
      end if;
      update public.products set stock_qty = stock_qty - q, reserved_qty = greatest(reserved_qty - q, 0) where id = v.id;
      signed := -q;
    else
      raise exception 'Unknown stock movement type %', p_type;
  end case;

  insert into public.stock_movements (product_id, qty, type, order_id, note, created_by)
  values (v.id, signed, p_type, p_order_id, p_note, coalesce(auth.jwt() ->> 'email', 'system'));

  return (select stock_qty - reserved_qty from public.products where id = v.id);
end;
$$;

-- Demo catalogue with Indian market prices and opening stock (only added if the SKU is missing)
with seed (sku, name, category, unit, cost_price, sell_price, gst_percent, stock_qty, low_stock_level, serial_tracked, warranty_months, is_service) as (
  values
    ('PNL-540-T1',  'Solar panel 540 Wp Mono PERC, Tier-1 (ALMM)', 'panel',              'pcs', 10500,  12000, 12, 200,  40, false, 240, false),
    ('INV-OG-1K',   'On-grid inverter 1 kW',                       'inverter',           'pcs', 13000,  16000, 12, 10,   2,  true,  24,  false),
    ('INV-OG-2K',   'On-grid inverter 2 kW',                       'inverter',           'pcs', 18000,  22000, 12, 10,   2,  true,  24,  false),
    ('INV-OG-3K',   'On-grid inverter 3 kW',                       'inverter',           'pcs', 24000,  29000, 12, 10,   2,  true,  24,  false),
    ('INV-OG-5K',   'On-grid inverter 5 kW',                       'inverter',           'pcs', 36000,  43000, 12, 10,   2,  true,  24,  false),
    ('INV-HY-3K',   'Hybrid inverter 3 kW',                        'inverter',           'pcs', 42000,  50000, 12, 10,   2,  true,  24,  false),
    ('INV-HY-5K',   'Hybrid inverter 5 kW',                        'inverter',           'pcs', 62000,  74000, 12, 10,   2,  true,  24,  false),
    ('BAT-LFP-5K',  'Lithium battery 5 kWh (LFP)',                 'battery',            'pcs', 78000,  92000, 12, 6,    2,  true,  24,  false),
    ('CC-MPPT-60',  'MPPT charge controller 60 A',                 'charge_controller',  'pcs', 7000,   9000,  12, 10,   2,  true,  24,  false),
    ('STR-GI-KW',   'GI mounting structure (per kW)',              'structure',          'kw',  6000,   7000,  12, 100,  15, false, null, false),
    ('STR-ELV-KW',  'Elevated structure extra (per kW)',           'structure',          'kw',  3500,   4000,  12, 50,   10, false, null, false),
    ('CBL-DC-4',    'DC solar cable 4 sq mm (per m)',              'dc_cable',           'm',   45,     60,    12, 1000, 200, false, null, false),
    ('CBL-AC-4',    'AC cable 4 sq mm (per m)',                    'ac_cable',           'm',   65,     90,    12, 1000, 200, false, null, false),
    ('ACDB-1',      'ACDB with surge protection',                  'acdb_dcdb',          'pcs', 2800,   3500,  12, 20,   5,  false, null, false),
    ('DCDB-1',      'DCDB with surge protection',                  'acdb_dcdb',          'pcs', 2800,   3500,  12, 20,   5,  false, null, false),
    ('EARTH-KIT',   'Earthing kit (chemical, 3 pits)',             'earthing',           'set', 4000,   5000,  12, 15,   4,  false, null, false),
    ('LA-1',        'Lightning arrestor',                          'lightning_arrestor', 'pcs', 2000,   2500,  12, 15,   4,  false, null, false),
    ('MC4-PAIR',    'MC4 connectors (pair)',                       'connector',          'set', 80,     150,   12, 300,  50, false, null, false),
    ('SVC-INSTALL', 'Installation & commissioning (per kW)',       'service',            'kw',  3500,   5000,  18, 0,    0,  false, null, true),
    ('SVC-NETMTR',  'Net metering & DISCOM charges',               'service',            'job', 4500,   6000,  18, 0,    0,  false, null, true)
),
added as (
  insert into public.products (sku, name, category, unit, cost_price, sell_price, gst_percent, stock_qty,
                               low_stock_level, serial_tracked, warranty_months, is_service)
  select sku, name, category, unit, cost_price, sell_price, gst_percent, stock_qty,
         low_stock_level, serial_tracked, warranty_months, is_service
  from seed
  on conflict (sku) do nothing
  returning id, stock_qty
)
insert into public.stock_movements (product_id, qty, type, note, created_by)
select id, stock_qty, 'purchase', 'Opening stock', 'system' from added where stock_qty > 0;

-- Warehouse view of stock: no prices
create or replace function public.warehouse_stock()
returns table (product_id uuid, sku text, name text, unit text, stock_qty numeric, reserved_qty numeric,
               available numeric, low_stock_level numeric, is_low boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.sku, p.name, p.unit, p.stock_qty, p.reserved_qty,
         p.stock_qty - p.reserved_qty, p.low_stock_level, (p.stock_qty - p.reserved_qty) <= p.low_stock_level
  from public.products p
  where (public.is_office() or public.is_warehouse()) and p.active and not p.is_service
  order by (p.stock_qty - p.reserved_qty) <= p.low_stock_level desc, p.category, p.name;
$$;

-- =================================================================
-- 3. Kit templates
-- =================================================================

create table if not exists public.kit_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  system_type text not null check (system_type in ('on_grid', 'off_grid', 'hybrid')),
  size_kw     numeric not null check (size_kw > 0),
  active      boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.kit_template_items (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.kit_templates (id) on delete cascade,
  product_id  uuid not null references public.products (id),
  qty_mode    text not null default 'fixed'
              check (qty_mode in ('fixed', 'per_kw', 'per_panel', 'from_survey_dc_cable', 'from_survey_ac_cable')),
  qty         numeric not null default 1,
  sort        int not null default 0
);

create index if not exists kit_template_items_template_idx on public.kit_template_items (template_id, sort);

-- 1–5 kW × On-Grid / Off-Grid. Panels per kW = ceil(1000 / 540 Wp) = 2.
insert into public.kit_templates (name, system_type, size_kw)
select kw || ' kW ' || kind, case kind when 'On-Grid' then 'on_grid' else 'off_grid' end, kw
from (values (1), (2), (3), (4), (5)) s(kw)
cross join (values ('On-Grid'), ('Off-Grid')) k(kind)
on conflict (name) do nothing;

with sizes(kw) as (values (1), (2), (3), (4), (5)),
rows (kw, kind, sku, qty_mode, qty, sort) as (
  -- Common to every kit; cable metres are replaced by the survey's measurements
  select s.kw, k.kind, x.sku, x.qty_mode, x.qty, x.sort
  from sizes s
  cross join (values ('On-Grid'), ('Off-Grid')) k(kind)
  cross join (values
    ('PNL-540-T1',  'per_kw',               2,  1),
    ('STR-GI-KW',   'per_kw',               1,  3),
    ('CBL-DC-4',    'from_survey_dc_cable', 20, 4),
    ('CBL-AC-4',    'from_survey_ac_cable', 15, 5),
    ('DCDB-1',      'fixed',                1,  6),
    ('ACDB-1',      'fixed',                1,  7),
    ('MC4-PAIR',    'per_kw',               2,  8),
    ('EARTH-KIT',   'fixed',                1,  9),
    ('LA-1',        'fixed',                1,  10),
    ('SVC-INSTALL', 'per_kw',               1,  20)
  ) x(sku, qty_mode, qty, sort)
  -- On-Grid: on-grid inverter (4 kW uses the 5 kW unit) and net metering
  union all
  select kw, 'On-Grid', case kw when 1 then 'INV-OG-1K' when 2 then 'INV-OG-2K' when 3 then 'INV-OG-3K' else 'INV-OG-5K' end, 'fixed', 1, 2 from sizes
  union all
  select kw, 'On-Grid', 'SVC-NETMTR', 'fixed', 1, 21 from sizes
  -- Off-Grid: hybrid inverter + battery + charge controller instead
  union all
  select kw, 'Off-Grid', case when kw <= 3 then 'INV-HY-3K' else 'INV-HY-5K' end, 'fixed', 1, 2 from sizes
  union all
  select kw, 'Off-Grid', 'BAT-LFP-5K', 'fixed', case when kw <= 2 then 1 when kw <= 4 then 2 else 3 end, 11 from sizes
  union all
  select kw, 'Off-Grid', 'CC-MPPT-60', 'fixed', 1, 12 from sizes
)
insert into public.kit_template_items (template_id, product_id, qty_mode, qty, sort)
select t.id, p.id, r.qty_mode, r.qty, r.sort
from rows r
join public.kit_templates t on t.name = r.kw || ' kW ' || r.kind
join public.products p on p.sku = r.sku
where not exists (select 1 from public.kit_template_items i where i.template_id = t.id);

-- =================================================================
-- 4–5. Quote acceptance → orders
-- =================================================================

alter table public.quotes
  add column if not exists accepted_at  timestamptz,
  add column if not exists accepted_via text;

alter table public.quotes drop constraint if exists quotes_accepted_via_check;
alter table public.quotes add constraint quotes_accepted_via_check
  check (accepted_via is null or accepted_via in ('crm', 'whatsapp'));

create sequence if not exists public.order_number_seq;
grant usage on sequence public.order_number_seq to authenticated;

create table if not exists public.orders (
  id                   uuid primary key default gen_random_uuid(),
  order_number         text not null unique
                       default ('SP-ORD-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY') || '-' ||
                                lpad(nextval('public.order_number_seq')::text, 4, '0')),
  lead_id              uuid not null references public.leads (id) on delete cascade,
  quote_id             uuid not null unique references public.quotes (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  system_type          text,
  system_size_kw       numeric,
  total                numeric(12, 2) not null,
  subsidy              numeric(12, 2) not null default 0,
  net_payable          numeric(12, 2),
  amount_paid          numeric(12, 2) not null default 0,
  balance              numeric(12, 2) generated always as (total - amount_paid) stored,
  advance_required     numeric(12, 2) not null default 0,
  status               text not null default 'awaiting_payment'
                       check (status in ('awaiting_payment', 'confirmed', 'packing', 'packed', 'dispatched',
                                         'installed', 'completed', 'cancelled')),
  stock_short          boolean not null default false,
  confirmed_at         timestamptz,
  packed_at            timestamptz,
  dispatched_at        timestamptz,
  confirmation_sent_at timestamptz,
  install_job_id       uuid,
  notes                text
);

create index if not exists orders_status_idx on public.orders (status, created_at desc);
create index if not exists orders_lead_idx on public.orders (lead_id);

create table if not exists public.order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders (id) on delete cascade,
  product_id   uuid references public.products (id),
  sku          text,
  description  text not null,
  qty          numeric not null default 1,
  unit         text,
  unit_price   numeric(12, 2),
  amount       numeric(12, 2) not null default 0,
  is_service   boolean not null default false,
  packed_qty   numeric not null default 0 check (packed_qty >= 0),
  reserved_qty numeric not null default 0 check (reserved_qty >= 0)
);

create index if not exists order_items_order_idx on public.order_items (order_id);

-- One order per accepted final quote. Safe to call twice.
create or replace function public.create_order_from_quote(p_quote_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.quotes;
  v_order_id uuid;
  v_advance numeric;
begin
  if not (public.is_office() or public.is_internal()) then
    raise exception 'Not allowed';
  end if;

  select id into v_order_id from public.orders where quote_id = p_quote_id;
  if v_order_id is not null then
    return v_order_id;
  end if;

  select * into q from public.quotes where id = p_quote_id;
  if not found or q.kind <> 'final' then
    raise exception 'Only an accepted final quote can become an order';
  end if;

  select coalesce(nullif(settings ->> 'advance_percent', '')::numeric, 30) into v_advance
  from public.quote_settings where id = 1;

  insert into public.orders (lead_id, quote_id, system_type, system_size_kw, total, subsidy, net_payable, advance_required)
  values (q.lead_id, q.id, q.system_type, q.system_size_kw, q.total, q.subsidy, q.net_payable,
          round(q.total * coalesce(v_advance, 30) / 100, 2))
  on conflict (quote_id) do nothing
  returning id into v_order_id;

  if v_order_id is null then
    select id into v_order_id from public.orders where quote_id = p_quote_id;
    return v_order_id;
  end if;

  insert into public.order_items (order_id, product_id, sku, description, qty, unit, unit_price, amount, is_service)
  select v_order_id,
         p.id,
         coalesce(nullif(e ->> 'sku', ''), p.sku),
         coalesce(nullif(e ->> 'description', ''), p.name, 'Item'),
         coalesce(nullif(e ->> 'qty', '')::numeric, 1),
         coalesce(nullif(e ->> 'unit', ''), p.unit),
         coalesce(nullif(e ->> 'unit_price', '')::numeric,
                  coalesce(nullif(e ->> 'amount', '')::numeric, 0) / greatest(coalesce(nullif(e ->> 'qty', '')::numeric, 1), 1)),
         coalesce(nullif(e ->> 'amount', '')::numeric, 0),
         -- Free-text lines (discounts, notes) are never packed
         coalesce(p.is_service, true)
  from jsonb_array_elements(coalesce(q.items, '[]'::jsonb)) e
  left join public.products p on p.id = case
    when coalesce(e ->> 'product_id', '') ~* '^[0-9a-f-]{36}$' then (e ->> 'product_id')::uuid end;

  perform public.log_lead_activity(q.lead_id, format('Order %s created from quotation %s: total ₹%s, advance due ₹%s.',
    (select order_number from public.orders where id = v_order_id), q.quote_number,
    to_char(q.total, 'FM99,99,99,990'), to_char(round(q.total * coalesce(v_advance, 30) / 100), 'FM99,99,99,990')));

  return v_order_id;
end;
$$;

-- Accepting a final quote: stamp it, lead → won (forward only), create the order
create or replace function public.quotes_before_accept()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    new.accepted_at := coalesce(new.accepted_at, now());
    new.accepted_via := coalesce(new.accepted_via, 'crm');
  end if;
  return new;
end;
$$;

drop trigger if exists quotes_before_accept on public.quotes;
create trigger quotes_before_accept
  before update on public.quotes
  for each row execute function public.quotes_before_accept();

create or replace function public.quotes_after_accept()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' and new.kind = 'final' then
    update public.leads set status = 'won', deal_value = new.total where id = new.lead_id and status not in ('won', 'lost');
    perform public.log_lead_activity(new.lead_id,
      format('Quotation %s accepted via %s.', new.quote_number, coalesce(new.accepted_via, 'crm')));
    perform public.create_order_from_quote(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists quotes_after_accept on public.quotes;
create trigger quotes_after_accept
  after update on public.quotes
  for each row execute function public.quotes_after_accept();

-- Order stages only move forward; only a manager may cancel
create or replace function public.order_stage_rank(p_status text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'awaiting_payment' then 0 when 'confirmed' then 1 when 'packing' then 2 when 'packed' then 3
    when 'dispatched' then 4 when 'installed' then 5 when 'completed' then 6 else 99 end;
$$;

create or replace function public.orders_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.status is distinct from old.status then
    if old.status = 'cancelled' then
      raise exception 'A cancelled order cannot be reopened';
    end if;
    if new.status = 'cancelled' then
      if not (public.is_manager() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
        raise exception 'Only a manager can cancel an order';
      end if;
    elsif public.order_stage_rank(new.status) < public.order_stage_rank(old.status) then
      raise exception 'Order status can only move forward (% → %)', old.status, new.status;
    end if;
    if new.status = 'confirmed' then new.confirmed_at := coalesce(new.confirmed_at, now()); end if;
    if new.status = 'packed' then new.packed_at := coalesce(new.packed_at, now()); end if;
    if new.status = 'dispatched' then new.dispatched_at := coalesce(new.dispatched_at, now()); end if;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_before_update on public.orders;
create trigger orders_before_update
  before update on public.orders
  for each row execute function public.orders_before_update();

-- =================================================================
-- 6. Payments
-- =================================================================

create sequence if not exists public.receipt_number_seq;
grant usage on sequence public.receipt_number_seq to authenticated;

create table if not exists public.payments (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders (id) on delete cascade,
  lead_id          uuid references public.leads (id) on delete cascade,
  created_at       timestamptz not null default now(),
  amount           numeric(12, 2) not null check (amount > 0),
  type             text not null check (type in ('advance', 'part', 'final', 'full', 'refund')),
  method           text not null check (method in ('upi', 'cash', 'bank_transfer', 'card', 'cheque', 'razorpay_test')),
  reference        text,
  paid_on          date not null default ((now() at time zone 'Asia/Kolkata')::date),
  received_by      text,
  receipt_number   text not null unique
                   default ('SP-RCPT-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY') || '-' ||
                            lpad(nextval('public.receipt_number_seq')::text, 4, '0')),
  receipt_pdf_path text,
  notes            text
);

create index if not exists payments_order_idx on public.payments (order_id, created_at);
-- The same UPI / bank reference can't be recorded twice for an order
create unique index if not exists payments_order_reference_idx on public.payments (order_id, lower(reference))
  where reference is not null and reference <> '';

create or replace function public.payments_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
begin
  select * into o from public.orders where id = new.order_id;
  if not found then
    raise exception 'Order not found';
  end if;
  if o.status = 'cancelled' and new.type <> 'refund' then
    raise exception 'This order is cancelled';
  end if;
  new.lead_id := o.lead_id;
  new.received_by := coalesce(new.received_by, auth.jwt() ->> 'email');
  new.reference := nullif(trim(new.reference), '');
  return new;
end;
$$;

drop trigger if exists payments_before_insert on public.payments;
create trigger payments_before_insert
  before insert on public.payments
  for each row execute function public.payments_before_insert();

-- Recompute what's been paid; the advance confirms the order
create or replace function public.payments_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paid numeric;
  o public.orders;
begin
  select coalesce(sum(case when type = 'refund' then -amount else amount end), 0) into v_paid
  from public.payments where order_id = new.order_id;

  update public.orders set amount_paid = v_paid where id = new.order_id returning * into o;

  perform public.log_lead_activity(o.lead_id, format('Payment ₹%s recorded (%s, %s%s). Receipt %s. Paid so far ₹%s, balance ₹%s.',
    to_char(new.amount, 'FM99,99,99,990'), new.type, replace(new.method, '_', ' '),
    case when new.reference is not null then ', ref ' || new.reference else '' end, new.receipt_number,
    to_char(o.amount_paid, 'FM99,99,99,990'), to_char(o.balance, 'FM99,99,99,990')));

  if o.status = 'awaiting_payment' and o.amount_paid >= o.advance_required then
    update public.orders set status = 'confirmed' where id = o.id;
  end if;
  return new;
end;
$$;

drop trigger if exists payments_after_insert on public.payments;
create trigger payments_after_insert
  after insert on public.payments
  for each row execute function public.payments_after_insert();

-- =================================================================
-- 7. Warehouse: reservation and packing
-- =================================================================

-- Reserve what's available for each stocked item; returns true if anything is short
create or replace function public.reserve_order_stock(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  it record;
  v_need numeric;
  v_take numeric;
  v_short boolean := false;
begin
  if not (public.is_office() or public.is_internal()) then
    raise exception 'Not allowed';
  end if;
  for it in
    select oi.id, oi.product_id, oi.qty, oi.reserved_qty, p.stock_qty - p.reserved_qty as available, p.name
    from public.order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = p_order_id and not oi.is_service and oi.reserved_qty < oi.qty
    for update of oi
  loop
    v_need := it.qty - it.reserved_qty;
    v_take := least(v_need, greatest(it.available, 0));
    if v_take > 0 then
      perform public.move_stock(it.product_id, v_take, 'reserve', p_order_id, 'Reserved for order');
      update public.order_items set reserved_qty = reserved_qty + v_take where id = it.id;
    end if;
    if v_take < v_need then
      v_short := true;
    end if;
  end loop;
  return v_short;
end;
$$;

create or replace function public.unreserve_order_stock(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  it record;
begin
  if not (public.is_office() or public.is_internal()) then
    raise exception 'Not allowed';
  end if;
  for it in
    select id, product_id, reserved_qty from public.order_items
    where order_id = p_order_id and reserved_qty > 0 and product_id is not null
    for update
  loop
    perform public.move_stock(it.product_id, it.reserved_qty, 'unreserve', p_order_id, 'Order cancelled');
    update public.order_items set reserved_qty = 0 where id = it.id;
  end loop;
end;
$$;

create or replace function public.set_packed(p_order_item_id uuid, p_qty numeric)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_qty numeric;
begin
  if not (public.is_office() or public.is_warehouse()) then
    raise exception 'Not allowed';
  end if;
  update public.order_items oi
    set packed_qty = least(greatest(coalesce(p_qty, 0), 0), oi.qty)
    from public.orders o
    where oi.id = p_order_item_id and o.id = oi.order_id and o.status in ('confirmed', 'packing')
    returning oi.packed_qty into v_qty;
  if v_qty is null then
    raise exception 'This item can no longer be changed';
  end if;
  return v_qty;
end;
$$;

create or replace function public.mark_order_packed(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.is_office() or public.is_warehouse()) then
    raise exception 'Not allowed';
  end if;
  update public.order_items set packed_qty = qty
    where order_id = p_order_id and not is_service and product_id is not null;
  update public.orders set status = 'packed' where id = p_order_id and status in ('confirmed', 'packing');
  if not found then
    raise exception 'Only orders being packed can be marked packed';
  end if;
end;
$$;

-- =================================================================
-- 8. Crews and installation jobs
-- =================================================================

create table if not exists public.crews (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null unique,
  lead_technician_email text,
  active                boolean not null default true,
  created_at            timestamptz not null default now()
);

create table if not exists public.crew_members (
  crew_id     uuid not null references public.crews (id) on delete cascade,
  staff_email text not null,
  primary key (crew_id, staff_email)
);

create table if not exists public.install_jobs (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null unique references public.orders (id) on delete cascade,
  lead_id        uuid not null references public.leads (id) on delete cascade,
  crew_id        uuid references public.crews (id),
  scheduled_date date not null,
  time_slot      text not null default 'Full day' check (time_slot in ('Morning 9–1', 'Afternoon 2–6', 'Full day')),
  est_hours      numeric,
  status         text not null default 'scheduled'
                 check (status in ('scheduled', 'in_progress', 'done', 'rescheduled', 'cancelled')),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists install_jobs_date_idx on public.install_jobs (scheduled_date, crew_id);

drop trigger if exists install_jobs_touch on public.install_jobs;
create trigger install_jobs_touch before update on public.install_jobs
  for each row execute function public.touch_updated_at();

-- Placeholder crews: replace the technician emails with your team's (see SETUP-ORDERS.md)
insert into public.crews (name, lead_technician_email) values
  ('Crew A', 'crew-a@example.com'),
  ('Crew B', 'crew-b@example.com'),
  ('Crew C', 'crew-c@example.com')
on conflict (name) do nothing;

insert into public.crew_members (crew_id, staff_email)
select id, lead_technician_email from public.crews where lead_technician_email is not null
on conflict do nothing;

-- Half-day jobs use 1 unit, full-day jobs 2; a crew has 2 units per working day
-- (installation.sql / service.sql upgrade some of these functions; dropping first keeps this file safe to re-run)
drop function if exists public.crew_day_load(uuid, date, uuid);
create or replace function public.crew_day_load(p_crew_id uuid, p_date date, p_exclude_job uuid default null)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when time_slot = 'Full day' then 2 else 1 end), 0)::int
  from public.install_jobs
  where crew_id = p_crew_id and scheduled_date = p_date and status <> 'cancelled'
    and (p_exclude_job is null or id <> p_exclude_job);
$$;

-- Earliest working day (Mon–Sat) from today + 3 with a crew that has room. Safe to call twice.
create or replace function public.auto_schedule_install(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
  c record;
  v_job uuid;
  v_hours numeric;
  v_units int;
  v_day date := (now() at time zone 'Asia/Kolkata')::date + 3;
  v_slot text;
begin
  if not (public.is_office() or public.is_internal()) then
    raise exception 'Not allowed';
  end if;
  select * into o from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order not found';
  end if;
  select id into v_job from public.install_jobs where order_id = p_order_id;
  if v_job is not null then
    return v_job;
  end if;

  v_hours := case when coalesce(o.system_size_kw, 0) <= 3 then 4 else 8 end
             + case when coalesce(o.system_type, 'on_grid') <> 'on_grid' then 2 else 0 end;
  v_units := case when v_hours > 4 then 2 else 1 end;

  for i in 0..90 loop
    if extract(dow from v_day) <> 0 then
      for c in select id, name from public.crews where active order by name loop
        if public.crew_day_load(c.id, v_day) + v_units <= 2 then
          v_slot := case
            when v_units = 2 then 'Full day'
            when exists (select 1 from public.install_jobs where crew_id = c.id and scheduled_date = v_day
                         and status <> 'cancelled' and time_slot = 'Morning 9–1') then 'Afternoon 2–6'
            else 'Morning 9–1' end;
          insert into public.install_jobs (order_id, lead_id, crew_id, scheduled_date, time_slot, est_hours)
          values (o.id, o.lead_id, c.id, v_day, v_slot, v_hours)
          returning id into v_job;
          update public.orders set install_job_id = v_job where id = o.id;
          return v_job;
        end if;
      end loop;
    end if;
    v_day := v_day + 1;
  end loop;
  return null;
end;
$$;

-- Packing lists for the warehouse: no prices, no phone numbers
drop function if exists public.packing_lists();
create or replace function public.packing_lists()
returns table (order_id uuid, order_number text, status text, stock_short boolean, client_code text,
               install_date date, time_slot text, crew_name text, items jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, o.status, o.stock_short, l.client_code, j.scheduled_date, j.time_slot, c.name,
         coalesce((
           select jsonb_agg(jsonb_build_object('id', oi.id, 'sku', oi.sku, 'description', oi.description,
                    'qty', oi.qty, 'unit', oi.unit, 'packed_qty', oi.packed_qty, 'reserved_qty', oi.reserved_qty)
                  order by oi.description)
           from public.order_items oi
           where oi.order_id = o.id and not oi.is_service and oi.product_id is not null
         ), '[]'::jsonb)
  from public.orders o
  join public.leads l on l.id = o.lead_id
  left join public.install_jobs j on j.id = o.install_job_id
  left join public.crews c on c.id = j.crew_id
  where (public.is_office() or public.is_warehouse())
    and o.status in ('confirmed', 'packing', 'packed')
  order by j.scheduled_date nulls last, o.created_at;
$$;

-- A technician's jobs: only what the crew needs (no phone numbers or prices)
drop function if exists public.my_install_jobs();
create or replace function public.my_install_jobs()
returns table (job_id uuid, scheduled_date date, time_slot text, job_status text, crew_name text,
               client_code text, client_name text, area text, system_size_kw numeric, system_type text,
               order_status text, packing_status text, items jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.scheduled_date, j.time_slot, j.status, c.name,
         l.client_code, l.name, l.location, o.system_size_kw, o.system_type,
         o.status,
         case when o.status in ('packed', 'dispatched', 'installed', 'completed') then 'Packed'
              when o.status = 'packing' then 'Packing' else 'Not packed' end,
         coalesce((
           select jsonb_agg(jsonb_build_object('description', oi.description, 'qty', oi.qty, 'unit', oi.unit,
                    'packed_qty', oi.packed_qty) order by oi.description)
           from public.order_items oi
           where oi.order_id = o.id and not oi.is_service and oi.product_id is not null
         ), '[]'::jsonb)
  from public.install_jobs j
  join public.orders o on o.id = j.order_id
  join public.leads l on l.id = j.lead_id
  left join public.crews c on c.id = j.crew_id
  where (public.is_technician() or public.is_office())
    and j.status <> 'cancelled'
    and j.scheduled_date >= (now() at time zone 'Asia/Kolkata')::date - 7
    and (public.is_office() or exists (
      select 1 from public.crews cc
      left join public.crew_members m on m.crew_id = cc.id
      where cc.id = j.crew_id
        and (lower(cc.lead_technician_email) = lower(auth.jwt() ->> 'email')
             or lower(m.staff_email) = lower(auth.jwt() ->> 'email'))
    ))
  order by j.scheduled_date, j.time_slot;
$$;

-- =================================================================
-- 9. Confirmation automation (no phone calls)
-- =================================================================

create or replace function public.confirm_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
  j record;
  v_short boolean;
begin
  if not (public.is_office() or public.is_internal()) then
    raise exception 'Not allowed';
  end if;
  select * into o from public.orders where id = p_order_id;
  if not found or o.status <> 'confirmed' then
    return; -- already handled, or not confirmed
  end if;

  -- 1. Reserve stock and open the packing list
  v_short := public.reserve_order_stock(o.id);
  update public.orders set status = 'packing', stock_short = v_short where id = o.id;

  -- 2. Book the installation crew
  perform public.auto_schedule_install(o.id);
  select ij.scheduled_date, ij.time_slot, c.name as crew into j
  from public.install_jobs ij left join public.crews c on c.id = ij.crew_id
  where ij.order_id = o.id;

  -- 3. Log it
  perform public.log_lead_activity(o.lead_id, format('Order %s confirmed: ₹%s received. Packing list created%s. %s',
    o.order_number, to_char(o.amount_paid, 'FM99,99,99,990'),
    case when v_short then ' (STOCK SHORT: some items could not be reserved)' else '' end,
    case when j.scheduled_date is not null
      then format('Installation scheduled for %s, %s, %s.', to_char(j.scheduled_date, 'Dy DD Mon'), j.time_slot, coalesce(j.crew, 'crew TBC'))
      else 'No crew available in the next 90 days: schedule the installation manually.' end));

  -- 4. Tell the customer on WhatsApp (the function re-reads the order with the service role)
  perform net.http_post(
    url     := 'https://iekfgtyfwmplsauutegs.supabase.co/functions/v1/send-whatsapp',
    body    := jsonb_build_object('kind', 'order_confirmed', 'order_id', o.id),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
end;
$$;

create or replace function public.orders_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    perform public.log_lead_activity(new.lead_id,
      format('Order %s: %s → %s.', new.order_number, replace(old.status, '_', ' '), replace(new.status, '_', ' ')));

    if new.status = 'confirmed' then
      perform public.confirm_order(new.id);
    elsif new.status = 'cancelled' then
      perform public.unreserve_order_stock(new.id);
      update public.install_jobs set status = 'cancelled' where order_id = new.id and status <> 'done';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_after_update on public.orders;
create trigger orders_after_update
  after update on public.orders
  for each row execute function public.orders_after_update();

-- =================================================================
-- 10. Security
-- =================================================================

alter table public.products enable row level security;
alter table public.stock_movements enable row level security;
alter table public.kit_templates enable row level security;
alter table public.kit_template_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.crews enable row level security;
alter table public.crew_members enable row level security;
alter table public.install_jobs enable row level security;

revoke all on public.products, public.stock_movements, public.kit_templates, public.kit_template_items,
  public.orders, public.order_items, public.payments, public.crews, public.crew_members, public.install_jobs
  from anon;

-- Products: office only; stock changes only through move_stock()
revoke insert, update on public.products from authenticated;
grant select, delete on public.products to authenticated;
grant insert (sku, name, category, unit, cost_price, sell_price, gst_percent, low_stock_level, serial_tracked,
              warranty_months, is_service, active) on public.products to authenticated;
grant update (sku, name, category, unit, cost_price, sell_price, gst_percent, low_stock_level, serial_tracked,
              warranty_months, is_service, active) on public.products to authenticated;

drop policy if exists "office manage products" on public.products;
create policy "office manage products" on public.products for all to authenticated
  using (public.is_office()) with check (public.is_office());

revoke insert, update, delete on public.stock_movements from authenticated;
drop policy if exists "office read stock movements" on public.stock_movements;
create policy "office read stock movements" on public.stock_movements for select to authenticated using (public.is_office());

drop policy if exists "office manage kit templates" on public.kit_templates;
create policy "office manage kit templates" on public.kit_templates for all to authenticated
  using (public.is_office()) with check (public.is_office());
drop policy if exists "office manage kit template items" on public.kit_template_items;
create policy "office manage kit template items" on public.kit_template_items for all to authenticated
  using (public.is_office()) with check (public.is_office());

-- Orders: office only (warehouse and technicians use packing_lists() / my_install_jobs())
drop policy if exists "office manage orders" on public.orders;
create policy "office manage orders" on public.orders for all to authenticated
  using (public.is_office()) with check (public.is_office());
drop policy if exists "office manage order items" on public.order_items;
create policy "office manage order items" on public.order_items for all to authenticated
  using (public.is_office()) with check (public.is_office());

-- Payments: office records them; never edited afterwards (apart from the receipt PDF and notes)
revoke update, delete on public.payments from authenticated;
grant update (receipt_pdf_path, notes) on public.payments to authenticated;
drop policy if exists "office manage payments" on public.payments;
create policy "office manage payments" on public.payments for all to authenticated
  using (public.is_office()) with check (public.is_office());

drop policy if exists "office manage crews" on public.crews;
create policy "office manage crews" on public.crews for all to authenticated
  using (public.is_office()) with check (public.is_office());
drop policy if exists "office manage crew members" on public.crew_members;
create policy "office manage crew members" on public.crew_members for all to authenticated
  using (public.is_office()) with check (public.is_office());
drop policy if exists "office manage install jobs" on public.install_jobs;
create policy "office manage install jobs" on public.install_jobs for all to authenticated
  using (public.is_office()) with check (public.is_office());

-- Functions: logged-in users only (each checks the role itself); never anonymous visitors
do $$
declare f text;
begin
  foreach f in array array[
    'public.move_stock(uuid, numeric, text, uuid, text)', 'public.warehouse_stock()',
    'public.create_order_from_quote(uuid)', 'public.reserve_order_stock(uuid)', 'public.unreserve_order_stock(uuid)',
    'public.packing_lists()', 'public.set_packed(uuid, numeric)', 'public.mark_order_packed(uuid)',
    'public.crew_day_load(uuid, date, uuid)', 'public.auto_schedule_install(uuid)', 'public.my_install_jobs()',
    'public.confirm_order(uuid)', 'public.log_lead_activity(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- Private storage for payment receipts
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "office read receipts" on storage.objects;
create policy "office read receipts" on storage.objects
  for select to authenticated using (bucket_id = 'receipts' and public.is_office());
drop policy if exists "office upload receipts" on storage.objects;
create policy "office upload receipts" on storage.objects
  for insert to authenticated with check (bucket_id = 'receipts' and public.is_office());
drop policy if exists "office replace receipts" on storage.objects;
create policy "office replace receipts" on storage.objects
  for update to authenticated using (bucket_id = 'receipts' and public.is_office());
