-- Sun Power Solar CRM: automatic quotes after AI calls
-- Run once in Supabase (SQL Editor → New query → paste → Run), after quotes.sql.

alter table public.quotes
  add column if not exists source            text not null default 'staff',
  add column if not exists call_execution_id text;

-- At most one automatic quote per AI call, even if Bolna resends the call result
create unique index if not exists quotes_call_execution_idx
  on public.quotes (call_execution_id) where call_execution_id is not null;
