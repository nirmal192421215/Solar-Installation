-- Sun Power Solar CRM: Client IDs and a locked-down portal for survey engineers
-- Run once in Supabase (SQL Editor → New query → paste → Run), after surveys.sql.
--
-- Engineers only see the site surveys assigned to them (client name + Client ID) and their
-- own survey forms. They cannot read leads, phone numbers, calls, quotes or settings.

-- ---------------------------------------------------------------
-- Client ID on every lead (existing leads are numbered too)
-- ---------------------------------------------------------------
create sequence if not exists public.client_code_seq;
grant usage on sequence public.client_code_seq to authenticated, anon;

alter table public.leads
  add column if not exists client_code text unique
  default ('SPC-' || lpad(nextval('public.client_code_seq')::text, 4, '0'));

-- Website visitors must not be able to choose their own Client ID
revoke insert (client_code) on public.leads from anon;

-- ---------------------------------------------------------------
-- Role helper
-- ---------------------------------------------------------------
create or replace function public.is_engineer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff
    where lower(email) = lower(auth.jwt() ->> 'email') and role = 'engineer'
  );
$$;

-- Office staff (owner, manager, staff): everyone on the staff list except engineers
create or replace function public.is_office()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_staff() and not public.is_engineer();
$$;

-- ---------------------------------------------------------------
-- Leads, calls, activity, quotes, settings: office staff only
-- ---------------------------------------------------------------
drop policy if exists "staff read leads" on public.leads;
create policy "staff read leads" on public.leads for select to authenticated using (public.is_office());
drop policy if exists "staff update leads" on public.leads;
create policy "staff update leads" on public.leads for update to authenticated using (public.is_office()) with check (public.is_office());
drop policy if exists "staff delete leads" on public.leads;
create policy "staff delete leads" on public.leads for delete to authenticated using (public.is_office());
drop policy if exists "staff add leads" on public.leads;
create policy "staff add leads" on public.leads for insert to authenticated with check (public.is_office());

drop policy if exists "staff read activities" on public.lead_activities;
create policy "staff read activities" on public.lead_activities for select to authenticated using (public.is_office());
drop policy if exists "staff add activities" on public.lead_activities;
create policy "staff add activities" on public.lead_activities for insert to authenticated
  with check (public.is_office() and created_by = auth.jwt() ->> 'email');

drop policy if exists "staff read calls" on public.lead_calls;
create policy "staff read calls" on public.lead_calls for select to authenticated using (public.is_office());

drop policy if exists "staff manage quotes" on public.quotes;
create policy "staff manage quotes" on public.quotes for all to authenticated using (public.is_office()) with check (public.is_office());

drop policy if exists "staff read quote settings" on public.quote_settings;
create policy "staff read quote settings" on public.quote_settings for select to authenticated using (public.is_office());
drop policy if exists "staff update quote settings" on public.quote_settings;
create policy "staff update quote settings" on public.quote_settings for update to authenticated using (public.is_office()) with check (public.is_office());

drop policy if exists "staff read quote pdfs" on storage.objects;
create policy "staff read quote pdfs" on storage.objects for select to authenticated using (bucket_id = 'quotes' and public.is_office());
drop policy if exists "staff upload quote pdfs" on storage.objects;
create policy "staff upload quote pdfs" on storage.objects for insert to authenticated with check (bucket_id = 'quotes' and public.is_office());
drop policy if exists "staff replace quote pdfs" on storage.objects;
create policy "staff replace quote pdfs" on storage.objects for update to authenticated using (bucket_id = 'quotes' and public.is_office());

-- ---------------------------------------------------------------
-- Meetings: office staff manage all; engineers only see their assigned site surveys
-- ---------------------------------------------------------------
drop policy if exists "staff manage meetings" on public.meetings;
create policy "staff manage meetings" on public.meetings for all to authenticated
  using (public.is_office()) with check (public.is_office());

drop policy if exists "engineers read assigned surveys" on public.meetings;
create policy "engineers read assigned surveys" on public.meetings for select to authenticated
  using (public.is_engineer() and type = 'site_survey' and lower(assigned_to) = lower(auth.jwt() ->> 'email'));

-- ---------------------------------------------------------------
-- Survey forms: office staff see all; engineers only their own, for meetings assigned to them
-- ---------------------------------------------------------------
drop policy if exists "staff manage surveys" on public.surveys;
create policy "staff manage surveys" on public.surveys for all to authenticated
  using (public.is_office()) with check (public.is_office());

drop policy if exists "engineers manage own surveys" on public.surveys;
create policy "engineers manage own surveys" on public.surveys for all to authenticated
  using (public.is_engineer() and lower(engineer_email) = lower(auth.jwt() ->> 'email'))
  with check (
    public.is_engineer()
    and lower(engineer_email) = lower(auth.jwt() ->> 'email')
    and exists (
      select 1 from public.meetings m
      where m.id = meeting_id and m.lead_id = surveys.lead_id
        and lower(m.assigned_to) = lower(auth.jwt() ->> 'email')
    )
  );

-- ---------------------------------------------------------------
-- An engineer's job list: only what they need (no phone, address or other details)
-- ---------------------------------------------------------------
create or replace function public.my_survey_jobs()
returns table (
  meeting_id uuid, scheduled_date date, time_slot text, meeting_status text,
  lead_id uuid, client_code text, client_name text,
  survey_id uuid, survey_status text, panel_watt numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.scheduled_date, m.time_slot, m.status,
         l.id, l.client_code, l.name,
         s.id, s.status,
         coalesce(nullif(qs.settings ->> 'panel_watt', '')::numeric, 540)
  from public.meetings m
  join public.leads l on l.id = m.lead_id
  left join lateral (
    select id, status from public.surveys x where x.meeting_id = m.id order by x.created_at desc limit 1
  ) s on true
  left join public.quote_settings qs on qs.id = 1
  where public.is_staff()
    and m.type = 'site_survey'
    and m.status <> 'cancelled'
    and lower(m.assigned_to) = lower(auth.jwt() ->> 'email')
  order by m.scheduled_date, m.time_slot;
$$;

revoke all on function public.my_survey_jobs() from public, anon;
grant execute on function public.my_survey_jobs() to authenticated;

-- ---------------------------------------------------------------
-- When a survey is submitted: lead → "Survey done", visit marked done, logged
-- (runs as the database, so engineers don't need access to the lead)
-- ---------------------------------------------------------------
create or replace function public.surveys_after_submit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status is distinct from 'submitted') then
    update public.leads set status = 'survey_done'
      where id = new.lead_id and status in ('new', 'ai_called', 'interested', 'survey_booked');
    if new.meeting_id is not null then
      update public.meetings
        set status = 'done',
            minutes = coalesce(minutes, format('Site survey completed: %s panels, ~%s kW. Submitted for approval.', new.panel_count, new.recommended_kw))
        where id = new.meeting_id and status = 'scheduled';
    end if;
    insert into public.lead_activities (lead_id, type, body, created_by)
    values (new.lead_id, 'note',
      format('Site survey submitted for approval by %s: %s panels (~%s kW), %s-facing %s, %s sq ft usable, cables DC %s m / AC %s m, %s photo(s).',
        coalesce(new.engineer_email, 'engineer'), new.panel_count, new.recommended_kw, new.roof_direction, new.roof_type,
        new.usable_area_sqft, new.dc_cable_m, new.ac_cable_m, jsonb_array_length(new.photos)),
      coalesce(new.engineer_email, 'engineer'));
  end if;
  return new;
end;
$$;

drop trigger if exists surveys_after_submit on public.surveys;
create trigger surveys_after_submit
  after insert or update on public.surveys
  for each row execute function public.surveys_after_submit();
