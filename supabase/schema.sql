-- Sun Power Solar CRM: database setup
-- Run this once in Supabase: SQL Editor → New query → paste → Run.
-- Before running, put your team's login emails in the "staff" insert at the bottom.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- Staff allowed into the CRM (matched against the login email)
-- ---------------------------------------------------------------
create table if not exists public.staff (
  email      text primary key,
  name       text,
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Leads from the website form
-- ---------------------------------------------------------------
create table if not exists public.leads (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Required on the form
  name                text not null check (char_length(name) between 2 and 120),
  phone               text not null check (phone ~ '^\+91[6-9][0-9]{9}$'),
  location            text not null check (char_length(location) between 2 and 120),
  consent             boolean not null check (consent),

  -- Optional on the form
  email               text check (email is null or (char_length(email) <= 200 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  property_type       text check (property_type is null or char_length(property_type) <= 40),
  monthly_bill        text check (monthly_bill is null or char_length(monthly_bill) <= 40),
  system_size         text check (system_size is null or char_length(system_size) <= 40),
  system_type         text check (system_type is null or char_length(system_type) <= 40),
  wants_subsidy       text check (wants_subsidy is null or char_length(wants_subsidy) <= 40),
  preferred_call_time text check (preferred_call_time is null or char_length(preferred_call_time) <= 40),

  -- Managed in the CRM
  source              text not null default 'website',
  status              text not null default 'new'
                      check (status in ('new', 'ai_called', 'interested', 'survey_booked', 'quote_sent', 'won', 'lost')),
  follow_up_date      date,
  assigned_to         text,
  deal_value          numeric(12, 2)
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_status_idx on public.leads (status);

-- ---------------------------------------------------------------
-- Notes, status changes and call logs for each lead
-- ---------------------------------------------------------------
create table if not exists public.lead_activities (
  id         bigint generated always as identity primary key,
  lead_id    uuid not null references public.leads (id) on delete cascade,
  created_at timestamptz not null default now(),
  type       text not null check (type in ('note', 'status', 'call')),
  body       text not null check (char_length(body) between 1 and 5000),
  created_by text
);

create index if not exists lead_activities_lead_idx on public.lead_activities (lead_id, created_at desc);

-- ---------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff
    where lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- Keep updated_at current and log status changes automatically
create or replace function public.leads_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.status is distinct from old.status then
    insert into public.lead_activities (lead_id, type, body, created_by)
    values (new.id, 'status', old.status || ' → ' || new.status, coalesce(auth.jwt() ->> 'email', 'system'));
  end if;
  return new;
end;
$$;

drop trigger if exists leads_before_update on public.leads;
create trigger leads_before_update
  before update on public.leads
  for each row execute function public.leads_before_update();

-- ---------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------
alter table public.staff enable row level security;
alter table public.leads enable row level security;
alter table public.lead_activities enable row level security;

-- Website visitors may only submit the form fields, and never read anything back
revoke all on public.leads from anon;
grant insert (name, phone, location, consent, email, property_type, monthly_bill,
              system_size, system_type, wants_subsidy, preferred_call_time)
  on public.leads to anon;

revoke all on public.lead_activities from anon;
revoke all on public.staff from anon;

drop policy if exists "website can submit leads" on public.leads;
create policy "website can submit leads" on public.leads
  for insert to anon
  with check (true);

-- Logged-in staff manage everything
drop policy if exists "staff read leads" on public.leads;
create policy "staff read leads" on public.leads
  for select to authenticated using (public.is_staff());

drop policy if exists "staff update leads" on public.leads;
create policy "staff update leads" on public.leads
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "staff delete leads" on public.leads;
create policy "staff delete leads" on public.leads
  for delete to authenticated using (public.is_staff());

drop policy if exists "staff add leads" on public.leads;
create policy "staff add leads" on public.leads
  for insert to authenticated with check (public.is_staff());

drop policy if exists "staff read activities" on public.lead_activities;
create policy "staff read activities" on public.lead_activities
  for select to authenticated using (public.is_staff());

drop policy if exists "staff add activities" on public.lead_activities;
create policy "staff add activities" on public.lead_activities
  for insert to authenticated
  with check (public.is_staff() and created_by = auth.jwt() ->> 'email');

drop policy if exists "staff read staff" on public.staff;
create policy "staff read staff" on public.staff
  for select to authenticated using (public.is_staff());

-- ---------------------------------------------------------------
-- Your team: replace with the real login emails, then run
-- ---------------------------------------------------------------
insert into public.staff (email, name, role) values
  ('dinesh190297@gmail.com', 'Dinesh', 'owner')
on conflict (email) do nothing;
