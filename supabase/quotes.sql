-- Sun Power Solar CRM: quotations
-- Run once in Supabase (SQL Editor → New query → paste → Run), after minutes_meetings.sql.

-- ---------------------------------------------------------------
-- Quote settings (one row): prices, components, terms, business details
-- ---------------------------------------------------------------
create table if not exists public.quote_settings (
  id         int primary key default 1 check (id = 1),
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into public.quote_settings (id, settings) values (1, '{}'::jsonb)
on conflict (id) do nothing;

alter table public.quote_settings enable row level security;
revoke all on public.quote_settings from anon;

drop policy if exists "staff read quote settings" on public.quote_settings;
create policy "staff read quote settings" on public.quote_settings
  for select to authenticated using (public.is_staff());

drop policy if exists "staff update quote settings" on public.quote_settings;
create policy "staff update quote settings" on public.quote_settings
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- ---------------------------------------------------------------
-- Quotations
-- ---------------------------------------------------------------
create sequence if not exists public.quote_number_seq;
grant usage on sequence public.quote_number_seq to authenticated;

create table if not exists public.quotes (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references public.leads (id) on delete cascade,
  created_at     timestamptz not null default now(),
  created_by     text,
  quote_number   text not null unique
                 default ('SP-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY') || '-' ||
                          lpad(nextval('public.quote_number_seq')::text, 4, '0')),
  system_type    text not null,
  system_size_kw numeric(6, 2) not null check (system_size_kw > 0),
  items          jsonb not null default '[]'::jsonb,
  subtotal       numeric(12, 2) not null,
  gst_amount     numeric(12, 2) not null default 0,
  total          numeric(12, 2) not null,
  subsidy        numeric(12, 2) not null default 0,
  net_payable    numeric(12, 2) not null,
  valid_until    date not null,
  pdf_path       text,
  status         text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected')),
  sent_at        timestamptz
);

create index if not exists quotes_lead_idx on public.quotes (lead_id, created_at desc);

alter table public.quotes enable row level security;
revoke all on public.quotes from anon;

drop policy if exists "staff manage quotes" on public.quotes;
create policy "staff manage quotes" on public.quotes
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- ---------------------------------------------------------------
-- Private storage for quotation PDFs (shared with customers via expiring links)
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('quotes', 'quotes', false)
on conflict (id) do nothing;

drop policy if exists "staff read quote pdfs" on storage.objects;
create policy "staff read quote pdfs" on storage.objects
  for select to authenticated using (bucket_id = 'quotes' and public.is_staff());

drop policy if exists "staff upload quote pdfs" on storage.objects;
create policy "staff upload quote pdfs" on storage.objects
  for insert to authenticated with check (bucket_id = 'quotes' and public.is_staff());

drop policy if exists "staff replace quote pdfs" on storage.objects;
create policy "staff replace quote pdfs" on storage.objects
  for update to authenticated using (bucket_id = 'quotes' and public.is_staff());
