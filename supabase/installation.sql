-- =================================================================
-- Sun Power: dispatch (serial numbers) and installation (technician form, photos, customer signature)
-- Run after orders.sql. Safe to run again. (If you ever re-run orders.sql, run this file again afterwards.)
-- =================================================================

-- =================================================================
-- 1. Helpers
-- =================================================================

-- Automation inside a security-definer function can switch this on for the rest of the transaction
create or replace function public.is_internal()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role' or pg_trigger_depth() > 0
      or coalesce(current_setting('app.internal', true), '') = 'on';
$$;

-- Is the logged-in technician on this job's crew (crew lead or member)?
create or replace function public.on_job_crew(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.install_jobs j
    join public.crews c on c.id = j.crew_id
    left join public.crew_members m on m.crew_id = c.id
    where j.id = p_job_id
      and (lower(c.lead_technician_email) = lower(auth.jwt() ->> 'email')
           or lower(m.staff_email) = lower(auth.jwt() ->> 'email'))
  );
$$;

-- Installation photos are stored under "<job id>/…": office, or the job's own crew
create or replace function public.can_use_job_file(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return public.is_office() or (public.is_technician() and public.on_job_crew(split_part(p_name, '/', 1)::uuid));
exception when others then
  return false; -- not a job folder
end;
$$;

-- What the technician must tick before the job can be completed
create or replace function public.install_checklist_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['panels_mounted', 'dc_wiring', 'inverter', 'earthing', 'lightning_arrestor', 'acdb_dcdb', 'generation', 'handover'];
$$;

-- Safety checks the crew confirms before work can start
create or replace function public.install_safety_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['ppe', 'harness', 'ladder', 'weather', 'dc_isolation', 'first_aid'];
$$;

-- Photos the crew must take; a photo's file name starts with its slot: "<job id>/<slot>-<random>.jpg"
create or replace function public.install_photo_slots()
returns table (slot text, label text, required boolean)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('before', 'Before work', true), ('panels', 'Panels & structure', true), ('inverter', 'Inverter', true),
    ('earthing', 'Earthing pit', true), ('acdb', 'ACDB / DCDB', true), ('meter', 'Meter', false), ('after', 'After work', true)
  ) v(slot, label, required);
$$;

-- =================================================================
-- 2. New columns
-- =================================================================

alter table public.orders
  add column if not exists dispatch_vehicle        text,
  add column if not exists dispatch_driver         text,
  add column if not exists dispatched_by           text,
  add column if not exists installed_at            timestamptz,
  add column if not exists completed_at            timestamptz,
  add column if not exists install_message_sent_at timestamptz;

alter table public.install_jobs
  add column if not exists started_at     timestamptz,
  add column if not exists finished_at    timestamptz,
  add column if not exists started_by     text,
  add column if not exists checklist      jsonb not null default '{}'::jsonb,
  add column if not exists photos         jsonb not null default '[]'::jsonb,
  add column if not exists generation_kwh numeric,
  add column if not exists install_notes  text,
  add column if not exists signed_by_name text,
  add column if not exists signature_path text,
  add column if not exists safety_checklist    jsonb not null default '{}'::jsonb,
  add column if not exists safety_confirmed_at timestamptz;

-- =================================================================
-- 3. Serial numbers (scanned in the warehouse before dispatch)
-- =================================================================

create table if not exists public.order_serials (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete cascade,
  order_item_id uuid not null references public.order_items (id) on delete cascade,
  product_id    uuid not null references public.products (id),
  serial_no     text not null check (length(trim(serial_no)) between 3 and 60),
  scanned_by    text,
  scanned_at    timestamptz not null default now()
);

-- One serial number can only ever go out once per product
create unique index if not exists order_serials_product_serial_idx on public.order_serials (product_id, upper(serial_no));
create index if not exists order_serials_order_idx on public.order_serials (order_id);

create or replace function public.add_serial(p_order_item_id uuid, p_serial text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  it record;
  v_serial text := upper(trim(coalesce(p_serial, '')));
  v_used text;
  v_id uuid;
begin
  if not (public.is_office() or public.is_warehouse()) then
    raise exception 'Not allowed';
  end if;
  select oi.id, oi.order_id, oi.product_id, oi.qty, oi.description, p.serial_tracked, o.status
    into it
  from public.order_items oi
  join public.products p on p.id = oi.product_id
  join public.orders o on o.id = oi.order_id
  where oi.id = p_order_item_id;
  if not found then
    raise exception 'Item not found';
  end if;
  if not it.serial_tracked then
    raise exception '% has no serial numbers', it.description;
  end if;
  if it.status not in ('confirmed', 'packing', 'packed') then
    raise exception 'Serial numbers can only be added before dispatch';
  end if;
  if length(v_serial) < 3 then
    raise exception 'That serial number is too short';
  end if;
  if (select count(*) from public.order_serials where order_item_id = it.id) >= ceil(it.qty) then
    raise exception 'All % serial numbers for % are already scanned', ceil(it.qty), it.description;
  end if;
  select o.order_number into v_used
  from public.order_serials s join public.orders o on o.id = s.order_id
  where s.product_id = it.product_id and upper(s.serial_no) = v_serial;
  if v_used is not null then
    raise exception 'Serial % is already used on order %', v_serial, v_used;
  end if;

  insert into public.order_serials (order_id, order_item_id, product_id, serial_no, scanned_by)
  values (it.order_id, it.id, it.product_id, v_serial, auth.jwt() ->> 'email')
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.remove_serial(p_serial_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.is_office() or public.is_warehouse()) then
    raise exception 'Not allowed';
  end if;
  delete from public.order_serials s
  using public.orders o
  where s.id = p_serial_id and o.id = s.order_id and o.status in ('confirmed', 'packing', 'packed');
  if not found then
    raise exception 'This serial number can no longer be removed';
  end if;
end;
$$;

-- =================================================================
-- 4. Dispatch: stock leaves the warehouse
-- =================================================================

create or replace function public.dispatch_order(p_order_id uuid, p_vehicle text default null, p_driver text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
  it record;
  v_missing text;
  v_count int := 0;
begin
  if not (public.is_office() or public.is_warehouse()) then
    raise exception 'Not allowed';
  end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found';
  end if;
  if o.status <> 'packed' then
    raise exception 'Only packed orders can be dispatched (this one is %)', replace(o.status, '_', ' ');
  end if;

  -- Every serial-tracked item needs all its serial numbers
  select string_agg(format('%s (%s of %s)', x.description, x.n, ceil(x.qty)), ', ') into v_missing
  from (
    select oi.description, oi.qty, (select count(*) from public.order_serials s where s.order_item_id = oi.id) as n
    from public.order_items oi join public.products p on p.id = oi.product_id
    where oi.order_id = o.id and p.serial_tracked and not oi.is_service
  ) x
  where x.n < ceil(x.qty);
  if v_missing is not null then
    raise exception 'Scan the serial numbers first: %', v_missing;
  end if;

  perform set_config('app.internal', 'on', true);
  for it in
    select id, product_id, qty, reserved_qty from public.order_items
    where order_id = o.id and not is_service and product_id is not null
    for update
  loop
    -- The reserved part leaves the shelf; anything that couldn't be reserved comes straight out of stock
    if least(it.reserved_qty, it.qty) > 0 then
      perform public.move_stock(it.product_id, least(it.reserved_qty, it.qty), 'dispatch', o.id, 'Dispatched ' || o.order_number);
    end if;
    if it.qty > it.reserved_qty then
      perform public.move_stock(it.product_id, -(it.qty - it.reserved_qty), 'adjustment', o.id, 'Dispatched ' || o.order_number || ' (was not reserved)');
    end if;
    update public.order_items set reserved_qty = 0 where id = it.id;
    v_count := v_count + 1;
  end loop;

  update public.orders
    set status = 'dispatched', dispatch_vehicle = nullif(trim(p_vehicle), ''), dispatch_driver = nullif(trim(p_driver), ''),
        dispatched_by = auth.jwt() ->> 'email'
    where id = o.id;
  perform public.log_lead_activity(o.lead_id, format('Order %s dispatched: %s items%s%s.', o.order_number, v_count,
    case when nullif(trim(p_vehicle), '') is not null then ', vehicle ' || trim(p_vehicle) else '' end,
    case when nullif(trim(p_driver), '') is not null then ', driver ' || trim(p_driver) else '' end));
  perform set_config('app.internal', 'off', true);
end;
$$;

-- =================================================================
-- 5. Order rules: timestamps, no cancelling once goods have left, serials freed on cancel
-- =================================================================

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
      if old.status in ('dispatched', 'installed', 'completed') then
        raise exception 'The goods have already left the warehouse; bring them back before cancelling';
      end if;
    elsif public.order_stage_rank(new.status) < public.order_stage_rank(old.status) then
      raise exception 'Order status can only move forward (% → %)', old.status, new.status;
    end if;
    if new.status = 'confirmed' then new.confirmed_at := coalesce(new.confirmed_at, now()); end if;
    if new.status = 'packed' then new.packed_at := coalesce(new.packed_at, now()); end if;
    if new.status = 'dispatched' then new.dispatched_at := coalesce(new.dispatched_at, now()); end if;
    if new.status = 'installed' then new.installed_at := coalesce(new.installed_at, now()); end if;
    if new.status = 'completed' then new.completed_at := coalesce(new.completed_at, now()); end if;
  end if;
  return new;
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
      delete from public.order_serials where order_id = new.id; -- the serial numbers can go on another order
    end if;
  end if;
  return new;
end;
$$;

-- Payments: a fully paid installed order is completed
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
  elsif o.status = 'installed' and o.amount_paid >= o.total then
    update public.orders set status = 'completed' where id = o.id;
  end if;
  return new;
end;
$$;

-- =================================================================
-- 6. Installation (technician on site)
-- =================================================================

-- The old version (without safety checks) must not stay callable
drop function if exists public.start_installation(uuid);

create or replace function public.start_installation(p_job_id uuid, p_safety jsonb)
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
  select ij.*, o.status as order_status, o.order_number, c.name as crew
    into j
  from public.install_jobs ij
  join public.orders o on o.id = ij.order_id
  left join public.crews c on c.id = ij.crew_id
  where ij.id = p_job_id for update of ij;
  if not found then
    raise exception 'Job not found';
  end if;
  if j.status in ('done', 'cancelled') then
    raise exception 'This job is already %', case j.status when 'done' then 'completed' else 'cancelled' end;
  end if;
  if j.order_status <> 'dispatched' then
    raise exception 'The goods haven''t been dispatched yet. Ask the warehouse to dispatch order % first.', j.order_number;
  end if;
  if j.status = 'in_progress' then
    return; -- already started
  end if;
  if exists (select 1 from unnest(public.install_safety_keys()) k where coalesce(p_safety ->> k, 'false') <> 'true') then
    raise exception 'Confirm every safety check before starting';
  end if;

  update public.install_jobs
    set status = 'in_progress', started_at = coalesce(started_at, now()), started_by = coalesce(started_by, auth.jwt() ->> 'email'),
        safety_checklist = p_safety, safety_confirmed_at = now()
    where id = p_job_id;
  perform set_config('app.internal', 'on', true);
  perform public.log_lead_activity(j.lead_id, format('Installation of %s started on site by %s (%s); safety checks confirmed.',
    j.order_number, auth.jwt() ->> 'email', coalesce(j.crew, 'no crew')));
  perform set_config('app.internal', 'off', true);
end;
$$;

-- Only "<job id>/…" files from this job's folder can be attached
create or replace function public.clean_job_photos(p_job_id uuid, p_photos jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(p), '[]'::jsonb)
  from jsonb_array_elements_text(case when jsonb_typeof(p_photos) = 'array' then p_photos else '[]'::jsonb end) p
  where p like p_job_id::text || '/%' and p not like '%..%';
$$;

create or replace function public.save_installation(p_job_id uuid, p_checklist jsonb, p_photos jsonb,
                                                    p_generation_kwh numeric default null, p_notes text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.is_office() or public.on_job_crew(p_job_id)) then
    raise exception 'This job isn''t assigned to your crew';
  end if;
  update public.install_jobs
    set checklist = case when jsonb_typeof(p_checklist) = 'object' then p_checklist else '{}'::jsonb end,
        photos = public.clean_job_photos(p_job_id, p_photos),
        generation_kwh = p_generation_kwh,
        install_notes = left(nullif(trim(p_notes), ''), 2000)
    where id = p_job_id and status = 'in_progress';
  if not found then
    raise exception 'Start the installation first';
  end if;
end;
$$;

create or replace function public.complete_installation(p_job_id uuid, p_checklist jsonb, p_photos jsonb,
                                                        p_generation_kwh numeric, p_notes text,
                                                        p_signed_by text, p_signature_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j record;
  o public.orders;
  v_missing text;
  v_photos jsonb := public.clean_job_photos(p_job_id, p_photos);
begin
  if not (public.is_office() or public.on_job_crew(p_job_id)) then
    raise exception 'This job isn''t assigned to your crew';
  end if;
  select ij.*, c.name as crew into j
  from public.install_jobs ij left join public.crews c on c.id = ij.crew_id
  where ij.id = p_job_id for update of ij;
  if not found or j.status <> 'in_progress' then
    raise exception 'Start the installation first';
  end if;

  select string_agg(k, ', ') into v_missing
  from unnest(public.install_checklist_keys()) k
  where coalesce(p_checklist ->> k, 'false') <> 'true';
  if v_missing is not null then
    raise exception 'Tick every checklist item first';
  end if;
  select string_agg(s.label, ', ') into v_missing
  from public.install_photo_slots() s
  where s.required and not exists (
    select 1 from jsonb_array_elements_text(v_photos) p where p like p_job_id::text || '/' || s.slot || '-%');
  if v_missing is not null then
    raise exception 'Add a photo for: %', v_missing;
  end if;
  select string_agg(format('%s (%s of %s)', x.description, x.n, ceil(x.qty)), ', ') into v_missing
  from (
    select oi.description, oi.qty, (select count(*) from public.order_serials s where s.order_item_id = oi.id) as n
    from public.order_items oi join public.products p on p.id = oi.product_id
    where oi.order_id = j.order_id and p.category = 'panel' and not oi.is_service
  ) x
  where x.n < ceil(x.qty);
  if v_missing is not null then
    raise exception 'Scan the panel serial numbers first: %', v_missing;
  end if;
  if p_generation_kwh is null or p_generation_kwh < 0 then
    raise exception 'Enter the generation reading at handover (kWh)';
  end if;
  if nullif(trim(p_signed_by), '') is null or coalesce(p_signature_path, '') not like p_job_id::text || '/%' then
    raise exception 'The customer''s name and signature are needed';
  end if;

  update public.install_jobs
    set status = 'done', finished_at = now(), checklist = p_checklist, photos = v_photos,
        generation_kwh = p_generation_kwh, install_notes = left(nullif(trim(p_notes), ''), 2000),
        signed_by_name = left(trim(p_signed_by), 120), signature_path = p_signature_path
    where id = p_job_id;

  perform set_config('app.internal', 'on', true);
  update public.orders set status = 'installed' where id = j.order_id and status = 'dispatched' returning * into o;
  if o.id is null then
    select * into o from public.orders where id = j.order_id;
  end if;
  if o.status = 'installed' and o.amount_paid >= o.total then
    update public.orders set status = 'completed' where id = o.id;
  end if;
  perform public.log_lead_activity(j.lead_id, format('Installation of %s completed by %s: generation at handover %s kWh, signed by %s.',
    o.order_number, coalesce(j.crew, 'the crew'), p_generation_kwh, trim(p_signed_by)));
  perform set_config('app.internal', 'off', true);

  -- Tell the customer on WhatsApp (the function re-reads the order with the service role)
  perform net.http_post(
    url     := 'https://iekfgtyfwmplsauutegs.supabase.co/functions/v1/send-whatsapp',
    body    := jsonb_build_object('kind', 'installation_complete', 'order_id', o.id),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
end;
$$;

-- Panel serial numbers are scanned on the roof by the crew
create or replace function public.add_site_serial(p_job_id uuid, p_order_item_id uuid, p_serial text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  j record;
  it record;
  v_serial text := upper(trim(coalesce(p_serial, '')));
  v_used text;
  v_id uuid;
begin
  if not (public.is_office() or public.on_job_crew(p_job_id)) then
    raise exception 'This job isn''t assigned to your crew';
  end if;
  select status, order_id into j from public.install_jobs where id = p_job_id;
  if not found or j.status <> 'in_progress' then
    raise exception 'Start the installation first';
  end if;
  select oi.id, oi.order_id, oi.product_id, oi.qty, oi.description, p.category
    into it
  from public.order_items oi join public.products p on p.id = oi.product_id
  where oi.id = p_order_item_id and oi.order_id = j.order_id;
  if not found then
    raise exception 'That item isn''t on this job';
  end if;
  if it.category <> 'panel' then
    raise exception 'Only panel serial numbers are added on site';
  end if;
  if length(v_serial) < 3 then
    raise exception 'That serial number is too short';
  end if;
  if (select count(*) from public.order_serials where order_item_id = it.id) >= ceil(it.qty) then
    raise exception 'All % panel serial numbers are already scanned', ceil(it.qty);
  end if;
  select o.order_number into v_used
  from public.order_serials s join public.orders o on o.id = s.order_id
  where s.product_id = it.product_id and upper(s.serial_no) = v_serial;
  if v_used is not null then
    raise exception 'Serial % is already used on order %', v_serial, v_used;
  end if;

  insert into public.order_serials (order_id, order_item_id, product_id, serial_no, scanned_by)
  values (it.order_id, it.id, it.product_id, v_serial, auth.jwt() ->> 'email')
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.remove_site_serial(p_job_id uuid, p_serial_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.is_office() or public.on_job_crew(p_job_id)) then
    raise exception 'This job isn''t assigned to your crew';
  end if;
  delete from public.order_serials s
  using public.install_jobs j, public.products p
  where s.id = p_serial_id and j.id = p_job_id and j.status = 'in_progress' and s.order_id = j.order_id
    and p.id = s.product_id and p.category = 'panel';
  if not found then
    raise exception 'This serial number can no longer be removed';
  end if;
end;
$$;

-- =================================================================
-- 7. What the warehouse and technicians see (new columns, so the functions are recreated)
-- =================================================================

drop function if exists public.packing_lists();
create function public.packing_lists()
returns table (order_id uuid, order_number text, status text, stock_short boolean, client_code text,
               install_date date, time_slot text, crew_name text, dispatched_at timestamptz,
               dispatch_vehicle text, dispatch_driver text, items jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, o.status, o.stock_short, l.client_code, j.scheduled_date, j.time_slot, c.name,
         o.dispatched_at, o.dispatch_vehicle, o.dispatch_driver,
         coalesce((
           select jsonb_agg(jsonb_build_object('id', oi.id, 'sku', oi.sku, 'description', oi.description,
                    'qty', oi.qty, 'unit', oi.unit, 'packed_qty', oi.packed_qty, 'reserved_qty', oi.reserved_qty,
                    'serial_tracked', p.serial_tracked,
                    'serials', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'serial_no', s.serial_no) order by s.scanned_at)
                                         from public.order_serials s where s.order_item_id = oi.id), '[]'::jsonb))
                  order by oi.description)
           from public.order_items oi
           join public.products p on p.id = oi.product_id
           where oi.order_id = o.id and not oi.is_service
         ), '[]'::jsonb)
  from public.orders o
  join public.leads l on l.id = o.lead_id
  left join public.install_jobs j on j.id = o.install_job_id
  left join public.crews c on c.id = j.crew_id
  where (public.is_office() or public.is_warehouse())
    and (o.status in ('confirmed', 'packing', 'packed')
         or (o.status = 'dispatched' and o.dispatched_at > now() - interval '14 days'))
  order by j.scheduled_date nulls last, o.created_at;
$$;

drop function if exists public.my_install_jobs();
create function public.my_install_jobs()
returns table (job_id uuid, scheduled_date date, time_slot text, job_status text, crew_name text,
               client_code text, client_name text, area text, system_size_kw numeric, system_type text,
               order_number text, order_status text, packing_status text, items jsonb,
               started_at timestamptz, finished_at timestamptz, checklist jsonb, photos jsonb,
               generation_kwh numeric, install_notes text, signed_by_name text, signature_path text)
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
         j.started_at, j.finished_at, j.checklist, j.photos, j.generation_kwh, j.install_notes, j.signed_by_name, j.signature_path
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
-- 8. Security
-- =================================================================

alter table public.order_serials enable row level security;
revoke all on public.order_serials from anon;
revoke insert, update, delete on public.order_serials from authenticated;
drop policy if exists "office read serials" on public.order_serials;
create policy "office read serials" on public.order_serials for select to authenticated using (public.is_office());

do $$
declare f text;
begin
  foreach f in array array[
    'public.on_job_crew(uuid)', 'public.can_use_job_file(text)',
    'public.add_serial(uuid, text)', 'public.remove_serial(uuid)', 'public.dispatch_order(uuid, text, text)',
    'public.start_installation(uuid, jsonb)', 'public.save_installation(uuid, jsonb, jsonb, numeric, text)',
    'public.add_site_serial(uuid, uuid, text)', 'public.remove_site_serial(uuid, uuid)',
    'public.complete_installation(uuid, jsonb, jsonb, numeric, text, text, text)',
    'public.packing_lists()', 'public.my_install_jobs()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- Private storage for installation photos and signatures: "<job id>/<file>"
insert into storage.buckets (id, name, public)
values ('install-photos', 'install-photos', false)
on conflict (id) do nothing;

drop policy if exists "crew read install photos" on storage.objects;
create policy "crew read install photos" on storage.objects
  for select to authenticated using (bucket_id = 'install-photos' and public.can_use_job_file(name));
drop policy if exists "crew upload install photos" on storage.objects;
create policy "crew upload install photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'install-photos' and public.can_use_job_file(name));
drop policy if exists "crew replace install photos" on storage.objects;
create policy "crew replace install photos" on storage.objects
  for update to authenticated using (bucket_id = 'install-photos' and public.can_use_job_file(name));
drop policy if exists "crew remove install photos" on storage.objects;
create policy "crew remove install photos" on storage.objects
  for delete to authenticated using (bucket_id = 'install-photos' and public.can_use_job_file(name));
