-- Localhost users: once an order is completed (fully paid), the customer gets a login (phone number + password)
-- to their passport: warranty cards per unit, installation record, documents, subsidy and service history.
--
-- Customers are NOT Supabase Auth users. They sign in only through the customer-portal Edge Function, so a customer
-- login can never open the CRM. Passwords are stored as bcrypt hashes (pgcrypto), sessions as SHA-256 hashes,
-- and every function here is callable by the service role (the Edge Functions) only.
--
-- Run after extras.sql. Safe to run again.

-- ---------- Accounts and sessions ----------
create table if not exists public.customer_accounts (
  lead_id          uuid primary key references public.leads(id) on delete cascade,
  phone            text not null,
  password_hash    text not null,
  must_change      boolean not null default true,   -- the first password comes on WhatsApp; the customer sets their own
  failed_attempts  int not null default 0,
  locked_until     timestamptz,
  created_at       timestamptz not null default now(),
  password_set_at  timestamptz not null default now(),
  password_set_by  text,
  last_login_at    timestamptz
);
create index if not exists customer_accounts_phone_idx on public.customer_accounts (phone);
alter table public.customer_accounts enable row level security;

-- The office can see whether a customer has a login (never the password hash)
revoke all on public.customer_accounts from anon, authenticated;
grant select (lead_id, phone, must_change, created_at, password_set_at, password_set_by, last_login_at, locked_until)
  on public.customer_accounts to authenticated;
drop policy if exists "Office reads customer logins" on public.customer_accounts;
create policy "Office reads customer logins" on public.customer_accounts
  for select to authenticated using (public.is_office());

create table if not exists public.customer_sessions (
  token_hash  text primary key,
  lead_id     uuid not null references public.leads(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists customer_sessions_lead_idx on public.customer_sessions (lead_id);
alter table public.customer_sessions enable row level security;
revoke all on public.customer_sessions from anon, authenticated;

alter table public.orders add column if not exists passport_sent_at timestamptz;

-- ---------- Set or reset a password (Edge Functions only) ----------
create or replace function public.set_customer_password(p_lead_id uuid, p_password text, p_must_change boolean, p_by text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.leads;
begin
  select * into l from public.leads where id = p_lead_id;
  if not found then
    raise exception 'Customer not found';
  end if;
  if length(coalesce(p_password, '')) < 8 or length(p_password) > 72 then
    raise exception 'The password must be 8 to 72 characters';
  end if;
  insert into public.customer_accounts (lead_id, phone, password_hash, must_change, password_set_by)
  values (l.id, l.phone, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), p_must_change, p_by)
  on conflict (lead_id) do update
    set phone = excluded.phone, password_hash = excluded.password_hash, must_change = excluded.must_change,
        password_set_at = now(), password_set_by = excluded.password_set_by, failed_attempts = 0, locked_until = null;
  -- A new password signs out every device, except when the customer changes it themselves
  if p_must_change then
    delete from public.customer_sessions where lead_id = l.id;
  end if;
end;
$$;

-- ---------- Sign in: phone number (or client ID) + password ----------
-- Returns { ok, lead_id, must_change } or { ok: false, error }. Never raises after counting a wrong attempt,
-- so the count is kept. Five wrong passwords lock the login for 15 minutes.
create or replace function public.customer_login(p_username text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user text := upper(regexp_replace(coalesce(p_username, ''), '\s', '', 'g'));
  v_digits text;
  a record;
  v_found boolean := false;
  v_locked boolean := false;
begin
  v_digits := right(regexp_replace(v_user, '\D', '', 'g'), 10);
  for a in
    select ca.* from public.customer_accounts ca join public.leads l on l.id = ca.lead_id
    where (v_user ~ '^SPC-\d+$' and upper(l.client_code) = v_user)
       or (v_user !~ '^SPC-' and length(v_digits) = 10 and right(regexp_replace(ca.phone, '\D', '', 'g'), 10) = v_digits)
  loop
    v_found := true;
    if a.locked_until is not null and a.locked_until > now() then
      v_locked := true;
      continue;
    end if;
    if extensions.crypt(coalesce(p_password, ''), a.password_hash) = a.password_hash then
      update public.customer_accounts set failed_attempts = 0, locked_until = null, last_login_at = now() where lead_id = a.lead_id;
      return jsonb_build_object('ok', true, 'lead_id', a.lead_id, 'must_change', a.must_change);
    end if;
  end loop;

  if v_found then
    update public.customer_accounts ca
    set failed_attempts = case when ca.failed_attempts + 1 >= 5 then 0 else ca.failed_attempts + 1 end,
        locked_until = case when ca.failed_attempts + 1 >= 5 then now() + interval '15 minutes' else ca.locked_until end
    from public.leads l
    where l.id = ca.lead_id
      and (ca.locked_until is null or ca.locked_until <= now())
      and ((v_user ~ '^SPC-\d+$' and upper(l.client_code) = v_user)
        or (v_user !~ '^SPC-' and length(v_digits) = 10 and right(regexp_replace(ca.phone, '\D', '', 'g'), 10) = v_digits));
  end if;
  if v_locked then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong passwords. Try again in 15 minutes, or call us for a new password.');
  end if;
  return jsonb_build_object('ok', false, 'error', 'Wrong phone number or password.');
end;
$$;

-- ---------- The customer changes their own password ----------
create or replace function public.customer_change_password(p_lead_id uuid, p_current text, p_new text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.customer_accounts;
begin
  select * into a from public.customer_accounts where lead_id = p_lead_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'No login for this customer.');
  end if;
  if extensions.crypt(coalesce(p_current, ''), a.password_hash) <> a.password_hash then
    return jsonb_build_object('ok', false, 'error', 'Your current password is wrong.');
  end if;
  if length(coalesce(p_new, '')) < 8 or length(p_new) > 72 then
    return jsonb_build_object('ok', false, 'error', 'Choose a password of at least 8 characters.');
  end if;
  if p_new = p_current then
    return jsonb_build_object('ok', false, 'error', 'Choose a password different from the one we sent you.');
  end if;
  perform public.set_customer_password(p_lead_id, p_new, false, 'customer');
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.set_customer_password(uuid, text, boolean, text) from public, anon, authenticated;
revoke all on function public.customer_login(text, text) from public, anon, authenticated;
revoke all on function public.customer_change_password(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_customer_password(uuid, text, boolean, text) to service_role;
grant execute on function public.customer_login(text, text) to service_role;
grant execute on function public.customer_change_password(uuid, text, text) to service_role;

-- ---------- When an order is completed: create the login and send it on WhatsApp ----------
-- The send-whatsapp function makes the password, stores only its hash and sends it once (orders.passport_sent_at).
create or replace function public.orders_after_complete_passport()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' and new.passport_sent_at is null then
    perform net.http_post(
      url     := 'https://iekfgtyfwmplsauutegs.supabase.co/functions/v1/send-whatsapp',
      body    := jsonb_build_object('kind', 'passport', 'order_id', new.id),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  end if;
  return new;
end;
$$;

drop trigger if exists orders_zz_passport on public.orders;
create trigger orders_zz_passport
  after update of status on public.orders
  for each row execute function public.orders_after_complete_passport();
