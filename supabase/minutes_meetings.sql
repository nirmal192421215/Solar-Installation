-- Sun Power Solar CRM: minutes of meeting, requirements and follow-up meetings
-- Run once in Supabase (SQL Editor → New query → paste → Run), after ai_calls.sql.

-- ---------------------------------------------------------------
-- Customer requirements captured on calls (editable in the CRM)
-- ---------------------------------------------------------------
alter table public.leads
  add column if not exists owns_property     text,
  add column if not exists roof_type         text,
  add column if not exists roof_area         text,
  add column if not exists shading           text,
  add column if not exists install_timeline  text,
  add column if not exists requirement_notes text;

-- ---------------------------------------------------------------
-- Minutes of meeting for each AI call
-- ---------------------------------------------------------------
alter table public.lead_calls
  add column if not exists outcome text,
  add column if not exists minutes jsonb;

-- ---------------------------------------------------------------
-- Meetings: site surveys, callbacks and other follow-ups
-- ---------------------------------------------------------------
create table if not exists public.meetings (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid not null references public.leads (id) on delete cascade,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  type              text not null default 'meeting'
                    check (type in ('site_survey', 'callback', 'meeting')),
  scheduled_date    date not null,
  time_slot         text check (time_slot is null or char_length(time_slot) <= 60),
  status            text not null default 'scheduled'
                    check (status in ('scheduled', 'done', 'cancelled', 'no_show')),
  agenda            text check (agenda is null or char_length(agenda) <= 2000),
  minutes           text check (minutes is null or char_length(minutes) <= 10000),
  source            text not null default 'staff' check (source in ('ai_call', 'staff')),
  call_execution_id text,
  created_by        text,
  -- One meeting per type from each AI call, so webhook retries don't duplicate it
  unique (call_execution_id, type)
);

create index if not exists meetings_date_idx on public.meetings (scheduled_date, status);
create index if not exists meetings_lead_idx on public.meetings (lead_id, scheduled_date desc);

create or replace function public.meetings_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists meetings_touch on public.meetings;
create trigger meetings_touch
  before update on public.meetings
  for each row execute function public.meetings_touch();

alter table public.meetings enable row level security;
revoke all on public.meetings from anon;

drop policy if exists "staff manage meetings" on public.meetings;
create policy "staff manage meetings" on public.meetings
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());
