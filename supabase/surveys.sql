-- Sun Power Solar CRM: estimates, site surveys, manager approval and final quotes
-- Run once in Supabase (SQL Editor → New query → paste → Run), after auto_quotes.sql.

-- ---------------------------------------------------------------
-- Roles: owner and manager approve surveys; engineers do the surveys
-- ---------------------------------------------------------------
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check
  check (role in ('owner', 'manager', 'engineer', 'staff'));

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff
    where lower(email) = lower(auth.jwt() ->> 'email') and role in ('owner', 'manager')
  );
$$;

-- ---------------------------------------------------------------
-- New pipeline stage after the engineer's visit
-- ---------------------------------------------------------------
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check
  check (status in ('new', 'ai_called', 'interested', 'survey_booked', 'survey_done', 'quote_sent', 'won', 'lost'));

-- Which engineer does each site survey
alter table public.meetings add column if not exists assigned_to text;

-- ---------------------------------------------------------------
-- Site surveys filled in by engineers
-- ---------------------------------------------------------------
create table if not exists public.surveys (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid not null references public.leads (id) on delete cascade,
  meeting_id         uuid references public.meetings (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  engineer_email     text,
  visited_at         date,
  status             text not null default 'draft'
                     check (status in ('draft', 'submitted', 'approved', 'changes_requested')),

  -- Roof
  roof_direction     text,
  roof_tilt          text,
  roof_type          text,
  roof_condition     text,
  usable_area_sqft   numeric,
  structure_height   text,
  shading            text,

  -- Electrical
  dc_cable_m         numeric,
  ac_cable_m         numeric,
  inverter_location  text,
  earthing_location  text,
  sanctioned_load_kw numeric,
  phase              text,

  -- Recommendation
  system_type        text,
  panel_count        int check (panel_count is null or panel_count > 0),
  recommended_kw     numeric,
  notes              text check (notes is null or char_length(notes) <= 5000),
  photos             jsonb not null default '[]'::jsonb,

  -- Manager review
  manager_notes      text,
  reviewed_by        text,
  reviewed_at        timestamptz
);

create index if not exists surveys_lead_idx on public.surveys (lead_id, created_at desc);
create index if not exists surveys_status_idx on public.surveys (status);

-- Only managers/owner can approve or send back a survey; everyone else can only draft and submit
create or replace function public.surveys_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.status in ('approved', 'changes_requested')
     and (tg_op = 'INSERT' or new.status is distinct from old.status)
     and not public.is_manager() then
    raise exception 'Only a manager can approve a survey or request changes';
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' and not public.is_manager() then
    raise exception 'This survey is approved; only a manager can change it';
  end if;
  return new;
end;
$$;

drop trigger if exists surveys_before_write on public.surveys;
create trigger surveys_before_write
  before insert or update on public.surveys
  for each row execute function public.surveys_before_write();

alter table public.surveys enable row level security;
revoke all on public.surveys from anon;

drop policy if exists "staff manage surveys" on public.surveys;
create policy "staff manage surveys" on public.surveys
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- Private storage for survey photos
insert into storage.buckets (id, name, public)
values ('survey-photos', 'survey-photos', false)
on conflict (id) do nothing;

drop policy if exists "staff read survey photos" on storage.objects;
create policy "staff read survey photos" on storage.objects
  for select to authenticated using (bucket_id = 'survey-photos' and public.is_staff());

drop policy if exists "staff upload survey photos" on storage.objects;
create policy "staff upload survey photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'survey-photos' and public.is_staff());

drop policy if exists "staff delete survey photos" on storage.objects;
create policy "staff delete survey photos" on storage.objects
  for delete to authenticated using (bucket_id = 'survey-photos' and public.is_staff());

-- ---------------------------------------------------------------
-- Quotes: approximate estimates vs final quotes
-- ---------------------------------------------------------------
alter table public.quotes
  add column if not exists kind      text not null default 'quote',
  add column if not exists survey_id uuid references public.surveys (id) on delete set null,
  add column if not exists range     jsonb;

alter table public.quotes drop constraint if exists quotes_kind_check;
alter table public.quotes add constraint quotes_kind_check check (kind in ('estimate', 'final', 'quote'));
