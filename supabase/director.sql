-- =================================================================
-- Sun Power: director's month-end dashboard. One function returns every figure for a month
-- (India time), with the previous month for comparison. Owner and managers only.
-- Run after service.sql. Safe to run again.
-- =================================================================

-- Headline figures for one month: [p_from, p_to) in India time
create or replace function public.month_kpis(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with b as (
    select (p_from::timestamp at time zone 'Asia/Kolkata') as t0, (p_to::timestamp at time zone 'Asia/Kolkata') as t1
  ),
  booked as (
    select o.* from public.orders o, b where o.created_at >= b.t0 and o.created_at < b.t1 and o.status <> 'cancelled'
  ),
  installed as (
    select j.*, o.system_size_kw, o.confirmed_at from public.install_jobs j join public.orders o on o.id = j.order_id, b
    where j.status = 'done' and j.finished_at >= b.t0 and j.finished_at < b.t1
  ),
  items as (
    select oi.amount, oi.qty, coalesce(p.cost_price, 0) as cost
    from public.order_items oi join booked o on o.id = oi.order_id left join public.products p on p.id = oi.product_id
  ),
  tk as (
    select t.* from public.service_tickets t, b where t.created_at >= b.t0 and t.created_at < b.t1
  ),
  fixed as (
    select t.* from public.service_tickets t, b where t.resolved_at >= b.t0 and t.resolved_at < b.t1
  )
  select jsonb_build_object(
    'leads',            (select count(*) from public.leads l, b where l.created_at >= b.t0 and l.created_at < b.t1),
    'ai_calls',         (select count(*) from public.lead_calls c, b where c.created_at >= b.t0 and c.created_at < b.t1),
    'surveys_approved', (select count(*) from public.surveys s, b where s.status = 'approved' and s.reviewed_at >= b.t0 and s.reviewed_at < b.t1),
    'quotes_sent',      (select count(*) from public.quotes q, b where q.kind = 'final' and q.sent_at >= b.t0 and q.sent_at < b.t1),
    'orders',           (select count(*) from booked),
    'order_value',      (select coalesce(sum(total), 0) from booked),
    'kw_sold',          (select coalesce(sum(system_size_kw), 0) from booked),
    'avg_order',        (select coalesce(round(avg(total)), 0) from booked),
    'cash',             (select coalesce(sum(case when p.type = 'refund' then -p.amount else p.amount end), 0)
                         from public.payments p where p.paid_on >= p_from and p.paid_on < p_to),
    'installs',         (select count(*) from installed),
    'kw_installed',     (select coalesce(sum(system_size_kw), 0) from installed),
    'days_to_install',  (select round(avg(extract(epoch from finished_at - confirmed_at) / 86400)::numeric, 1) from installed where confirmed_at is not null),
    'revenue_ex_gst',   (select coalesce(sum(amount), 0) from items),
    'cost',             (select coalesce(sum(qty * cost), 0) from items),
    'tickets',          (select count(*) from tk where kind = 'breakdown'),
    'tickets_resolved', (select count(*) from fixed where kind = 'breakdown'),
    'sla_met_pct',      (select round(100.0 * count(*) filter (where sla_met) / nullif(count(*), 0)) from fixed where kind = 'breakdown'),
    'checkups_done',    (select count(*) from fixed where kind = 'checkup'),
    'service_charges',  (select coalesce(sum(charge_amount), 0) from fixed),
    'rating',           (select round(avg(customer_rating)::numeric, 1) from public.service_tickets t, b
                         where t.customer_rating is not null and t.closed_at >= b.t0 and t.closed_at < b.t1)
  );
$$;

create or replace function public.director_dashboard(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_prev date := (date_trunc('month', p_month) - interval '1 month')::date;
  t0 timestamptz := v_from::timestamp at time zone 'Asia/Kolkata';
  t1 timestamptz := v_to::timestamp at time zone 'Asia/Kolkata';
  v jsonb;
begin
  if not public.is_manager() then
    raise exception 'Only the owner and managers can see the director''s dashboard';
  end if;

  select jsonb_build_object(
    'month', v_from,
    'now', public.month_kpis(v_from, v_to),
    'prev', public.month_kpis(v_prev, v_from),

    -- Funnel for leads that arrived this month: how far each one has got so far
    'funnel', (
      select jsonb_build_object(
        'leads', count(*),
        'survey_booked', count(*) filter (where status in ('survey_booked', 'survey_done', 'survey_approved', 'quote_sent', 'won')),
        'survey_approved', count(*) filter (where status in ('survey_approved', 'quote_sent', 'won')),
        'quote_sent', count(*) filter (where status in ('quote_sent', 'won')),
        'won', count(*) filter (where status = 'won'),
        'lost', count(*) filter (where status = 'lost'))
      from public.leads where created_at >= t0 and created_at < t1),

    'sources', (
      select coalesce(jsonb_agg(jsonb_build_object('source', source, 'leads', n, 'won', w) order by n desc), '[]'::jsonb)
      from (select coalesce(nullif(source, ''), 'other') as source, count(*) as n, count(*) filter (where status = 'won') as w
            from public.leads where created_at >= t0 and created_at < t1 group by 1) s),

    -- Last 6 months, oldest first
    'trend', (
      select jsonb_agg(jsonb_build_object('month', m, 'k', public.month_kpis(m, (m + interval '1 month')::date)) order by m)
      from generate_series(v_from - interval '5 months', v_from, interval '1 month') g(m0), lateral (select m0::date as m) x),

    -- Money still owed by customers today, by how old the order is
    'receivables', (
      select jsonb_build_object(
        'total', coalesce(sum(balance), 0),
        'orders', count(*),
        'd0_30', coalesce(sum(balance) filter (where age <= 30), 0),
        'd31_60', coalesce(sum(balance) filter (where age between 31 and 60), 0),
        'd61_90', coalesce(sum(balance) filter (where age between 61 and 90), 0),
        'd90', coalesce(sum(balance) filter (where age > 90), 0),
        'awaiting_advance', count(*) filter (where status = 'awaiting_payment'))
      from (select balance, status, (current_date - created_at::date) as age from public.orders
            where status <> 'cancelled' and balance > 0) r),

    'stock', (
      select jsonb_build_object(
        'value', coalesce(sum(stock_qty * cost_price), 0),
        'reserved_value', coalesce(sum(reserved_qty * cost_price), 0),
        'low', count(*) filter (where stock_qty - reserved_qty <= low_stock_level))
      from public.products where active and not is_service),

    'crews', (
      select coalesce(jsonb_agg(jsonb_build_object('crew', c.name,
        'installs', (select count(*) from public.install_jobs j where j.crew_id = c.id and j.status = 'done' and j.finished_at >= t0 and j.finished_at < t1),
        'kw', (select coalesce(sum(o.system_size_kw), 0) from public.install_jobs j join public.orders o on o.id = j.order_id
               where j.crew_id = c.id and j.status = 'done' and j.finished_at >= t0 and j.finished_at < t1),
        'visits', (select count(*) from public.service_tickets t where t.crew_id = c.id and t.resolved_at >= t0 and t.resolved_at < t1),
        'rating', (select round(avg(customer_rating)::numeric, 1) from public.service_tickets t
                   where t.crew_id = c.id and t.customer_rating is not null and t.closed_at >= t0 and t.closed_at < t1)
      ) order by c.name), '[]'::jsonb)
      from public.crews c),

    'top_orders', (
      select coalesce(jsonb_agg(x order by x.total desc), '[]'::jsonb) from (
        select o.order_number, l.name, l.client_code, o.system_size_kw, o.system_type, o.total, o.amount_paid, o.status
        from public.orders o join public.leads l on l.id = o.lead_id
        where o.created_at >= t0 and o.created_at < t1 and o.status <> 'cancelled'
        order by o.total desc limit 5) x),

    -- Open now: things the director may want to chase
    'attention', jsonb_build_object(
      'overdue_tickets', (select count(*) from public.service_tickets where status in ('open', 'scheduled', 'in_progress') and sla_due_at < now()),
      'stock_short_orders', (select count(*) from public.orders where stock_short and status in ('confirmed', 'packing')),
      'awaiting_dispatch', (select count(*) from public.orders where status = 'packed'),
      'surveys_waiting', (select count(*) from public.surveys where status = 'submitted'))
  ) into v;
  return v;
end;
$$;

revoke all on function public.month_kpis(date, date) from public, anon, authenticated;
revoke all on function public.director_dashboard(date) from public, anon;
grant execute on function public.director_dashboard(date) to authenticated;
