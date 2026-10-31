-- Sun Power Solar CRM: AI calling with Bolna
-- Run this once in Supabase (SQL Editor → New query → paste → Run), AFTER schema.sql
-- and AFTER deploying the call-lead Edge Function (deployed as "clever-task").

create extension if not exists pg_net;

-- ---------------------------------------------------------------
-- AI call state on each lead (for the CRM table)
-- ---------------------------------------------------------------
alter table public.leads
  add column if not exists ai_call_status       text,
  add column if not exists ai_call_execution_id text,
  add column if not exists ai_call_scheduled_at timestamptz;

create index if not exists leads_ai_call_execution_idx on public.leads (ai_call_execution_id);

-- ---------------------------------------------------------------
-- Every AI call attempt, with Bolna's results
-- ---------------------------------------------------------------
create table if not exists public.lead_calls (
  execution_id       text primary key,
  lead_id            uuid not null references public.leads (id) on delete cascade,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  scheduled_at       timestamptz,
  status             text not null,
  termination_reason text,
  duration_seconds   numeric,
  cost_cents         numeric,
  summary            text,
  transcript         text,
  recording_url      text,
  extracted_data     jsonb,
  raw                jsonb
);

create index if not exists lead_calls_lead_idx on public.lead_calls (lead_id, created_at desc);

alter table public.lead_calls enable row level security;
revoke all on public.lead_calls from anon;

drop policy if exists "staff read calls" on public.lead_calls;
create policy "staff read calls" on public.lead_calls
  for select to authenticated using (public.is_staff());

-- ---------------------------------------------------------------
-- When a lead with consent arrives, ask the call-lead function to call them.
-- The function re-reads the lead with the service role and only calls once,
-- so this request carries nothing but the lead id.
-- ---------------------------------------------------------------
create or replace function public.request_ai_call()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform net.http_post(
    url     := 'https://iekfgtyfwmplsauutegs.supabase.co/functions/v1/clever-task',
    body    := jsonb_build_object('lead_id', new.id),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  return new;
end;
$$;

drop trigger if exists leads_after_insert_ai_call on public.leads;
create trigger leads_after_insert_ai_call
  after insert on public.leads
  for each row
  when (new.consent)
  execute function public.request_ai_call();
