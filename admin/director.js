// Director's month-end dashboard: headline figures vs last month, funnel, 6-month trends, money owed, crews.
// All figures come from public.director_dashboard() (owner and managers only).
(() => {
  const { sb, esc, toast, todayISO, registerView, viewOpen } = window.CRM;
  const $ = (id) => document.getElementById(id);

  const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
  // ₹12.4 L / ₹1.2 Cr for tiles and chart labels
  const short = (n) => {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2).replace(/\.?0+$/, "")} Cr`;
    if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(1).replace(/\.0$/, "")} L`;
    return inr(v);
  };
  const num = (n, d = 0) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d }));
  const monthName = (iso, style = "long") => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { month: style, year: "numeric" });
  const monthShort = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { month: "short" });
  const SOURCES = { website: "Website", phone: "Phone call", "walk-in": "Walk-in", referral: "Referral", other: "Other" };

  let month = null; // "YYYY-MM"
  let data = null;
  let money = null; // profit per job, unfinished work, invoices, subsidy, payroll (finance.sql)
  let period = "month"; // "today" | "week" | "month": the headline tiles and profit per job follow it
  let per = null; // director_period(): figures for the chosen period and the one before (extras.sql)

  // [from, to) for the chosen period, India dates
  function range() {
    const today = todayISO();
    if (period === "today") return [today, window.CRM.addDays(today, 1)];
    if (period === "week") return [window.CRM.mondayOf(today), window.CRM.addDays(today, 1)];
    const next = new Date(`${month}-01T00:00:00`);
    next.setMonth(next.getMonth() + 1);
    return [`${month}-01`, next.toLocaleDateString("en-CA").slice(0, 10)];
  }
  const prevLabel = () => ({ today: "yesterday", week: "last week" }[period] || monthShort(prevMonth()));
  const periodLabel = () => ({ today: "today", week: "this week" }[period] || `in ${monthName(data.month, "short")}`);

  async function load() {
    month = month || todayISO().slice(0, 7);
    $("dirMonth").value = month;
    document.querySelectorAll("#dirPeriod button").forEach((b) => b.classList.toggle("is-active", b.dataset.period === period));
    $("dirMonthPicker").hidden = period !== "month";
    $("dirBody").classList.add("is-loading"); // keep the previous figures visible while refreshing
    const [from, to] = range();
    const [{ data: d, error }, { data: m }, { data: pp }] = await Promise.all([
      sb.rpc("director_dashboard", { p_month: `${month}-01` }),
      sb.rpc("director_money", { p_month: `${month}-01` }),
      sb.rpc("director_period", { p_from: from, p_to: to }),
    ]);
    money = m || null;
    per = pp || null;
    $("dirBody").classList.remove("is-loading");
    if (error) {
      $("dirBody").innerHTML = `<p class="empty">${/Only the owner/.test(error.message) ? esc(error.message) : `The dashboard isn't set up yet (run director.sql). ${esc(error.message)}`}</p>`;
      return;
    }
    data = d;
    render();
  }

  // ---------- Tiles ----------
  // Change vs last month, as text with an arrow (never colour alone). lowerIsBetter flips good/bad.
  function delta(now, prev, { lowerIsBetter = false, points = false } = {}) {
    if (now === null || now === undefined || prev === null || prev === undefined) return `<span class="delta">—</span>`;
    const a = Number(now), b = Number(prev);
    if (a === b) return `<span class="delta">no change vs ${esc(prevLabel())}</span>`;
    const up = a > b;
    const good = lowerIsBetter ? !up : up;
    const text = points ? `${Math.abs(a - b).toFixed(0)} pts` : b === 0 ? "new" : `${Math.round((Math.abs(a - b) / Math.abs(b)) * 100)}%`;
    return `<span class="delta ${good ? "is-good" : "is-bad"}">${up ? "▲" : "▼"} ${text} vs ${esc(prevLabel())}</span>`;
  }
  const prevMonth = () => {
    const d = new Date(`${month}-01T00:00:00`);
    d.setMonth(d.getMonth() - 1);
    return d.toLocaleDateString("en-CA").slice(0, 10);
  };
  const margin = (k) => (Number(k.revenue_ex_gst) > 0 ? Math.round(((k.revenue_ex_gst - k.cost) / k.revenue_ex_gst) * 100) : null);

  function tile(label, value, sub, extra = "") {
    return `<div class="dtile${extra}"><span class="dtile__label">${esc(label)}</span><strong>${value}</strong>${sub}</div>`;
  }

  // ---------- Charts (plain SVG/HTML, hover + keyboard tooltips, table view) ----------
  // Ordered funnel stages: one blue ramp, light → dark (validated with the dataviz ordinal check)
  const FUNNEL_RAMP = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
  const ACCENT = "#2a78d6";
  const MUTED = "#C9D7EA";

  function funnel(f) {
    const stages = [["Leads", f.leads], ["Survey booked", f.survey_booked], ["Survey approved", f.survey_approved], ["Quote sent", f.quote_sent], ["Won", f.won]];
    const max = Math.max(1, f.leads);
    return `<div class="hbars">${stages.map(([label, n], i) => {
      const pct = f.leads ? Math.round((n / f.leads) * 100) : 0;
      return `<div class="hbar" tabindex="0" data-tip="${esc(`${label}: ${n} of ${f.leads} leads (${pct}%)`)}">
        <span class="hbar__label">${esc(label)}</span>
        <span class="hbar__track"><i style="width:${(n / max) * 100}%;background:${FUNNEL_RAMP[i]}"></i></span>
        <span class="hbar__value">${num(n)}${i ? ` <small>${pct}%</small>` : ""}</span>
      </div>`;
    }).join("")}</div>
    ${tableView(["Stage", "Leads", "% of leads"], stages.map(([l, n]) => [l, num(n), f.leads ? `${Math.round((n / f.leads) * 100)}%` : "—"]))}`;
  }

  // Ranked bars, one hue
  function ranked(rows, fmt) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return `<div class="hbars">${rows.map((r) => `<div class="hbar" tabindex="0" data-tip="${esc(r.tip)}">
        <span class="hbar__label">${esc(r.label)}</span>
        <span class="hbar__track"><i style="width:${(r.value / max) * 100}%;background:${ACCENT}"></i></span>
        <span class="hbar__value">${fmt(r.value)}</span>
      </div>`).join("") || `<p class="muted">No data this month.</p>`}</div>`;
  }

  // 6-month columns: the selected month in the accent colour, earlier months muted (emphasis)
  function columns(title, key, fmt) {
    const pts = data.trend.map((t) => ({ m: t.month, v: Number(t.k[key]) || 0 }));
    const max = Math.max(1, ...pts.map((p) => p.v));
    const W = 300, H = 120, pad = 18, gap = 2;
    const bw = (W - gap * (pts.length - 1)) / pts.length;
    const bars = pts.map((p, i) => {
      const h = Math.max(p.v ? 2 : 0, (p.v / max) * (H - pad));
      const x = i * (bw + gap), y = H - h;
      const last = i === pts.length - 1;
      return `<g class="col" tabindex="0" data-tip="${esc(`${monthName(p.m, "short")}: ${fmt(p.v)}`)}">
        <rect x="${x}" y="0" width="${bw}" height="${H}" fill="transparent"></rect>
        <path d="M${x},${H} V${y + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, h)},-${Math.min(4, h)} H${x + bw - Math.min(4, h)} q${Math.min(4, h)},0 ${Math.min(4, h)},${Math.min(4, h)} V${H} Z" fill="${last ? ACCENT : MUTED}"></path>
        ${last ? `<text x="${x + bw / 2}" y="${Math.max(11, y - 5)}" text-anchor="middle" class="col__val">${esc(fmt(p.v))}</text>` : ""}
        <text x="${x + bw / 2}" y="${H + 14}" text-anchor="middle" class="col__axis">${esc(monthShort(p.m))}</text>
      </g>`;
    }).join("");
    return `<section class="card dcard">
      <h3>${esc(title)}</h3>
      <svg viewBox="0 -4 ${W} ${H + 22}" class="cols" role="img" aria-label="${esc(title)}, last 6 months">
        <line x1="0" x2="${W}" y1="${H}" y2="${H}" class="col__base"></line>${bars}
      </svg>
      ${tableView(["Month", title], pts.map((p) => [monthName(p.m, "short"), fmt(p.v)]))}
    </section>`;
  }

  const tableView = (head, rows) => `<details class="tview"><summary>Show table</summary>
    <table class="dtable"><thead><tr>${head.map((h, i) => `<th${i ? ` class="right"` : ""}>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ` class="right"` : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></details>`;

  // ---------- Page ----------
  function render() {
    // Headline tiles follow the chosen period; funnel, trends and tables stay on the month
    const k = per?.now || data.now, p = per?.prev || data.prev, r = data.receivables, a = data.attention;
    const m = margin(k), mp = margin(p);
    const conv = data.funnel.leads ? Math.round((data.funnel.won / data.funnel.leads) * 100) : null;
    $("dirTitle").textContent = period === "today"
      ? `Today · ${new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}`
      : period === "week" ? `This week · from ${new Date(window.CRM.mondayOf(todayISO()) + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}`
      : `Month-end · ${monthName(data.month)}`;
    $("dirSub").textContent = period === "today" ? "Today's headline figures compared with yesterday; the charts and tables below cover the month."
      : period === "week" ? "This week's headline figures compared with last week; the charts and tables below cover the month."
      : "Sales, money, installations and service for the month, compared with the month before.";
    $("dirBody").innerHTML = `
      ${a.overdue_tickets || a.stock_short_orders || a.awaiting_dispatch || a.surveys_waiting ? `<div class="dattention">
        ${a.overdue_tickets ? `<button type="button" class="chip chip--bad" data-go="service" data-filter="overdue">⚠ ${a.overdue_tickets} overdue service ticket${a.overdue_tickets > 1 ? "s" : ""}</button>` : ""}
        ${a.stock_short_orders ? `<button type="button" class="chip chip--bad" data-go="warehouse">⚠ ${a.stock_short_orders} order${a.stock_short_orders > 1 ? "s" : ""} short of stock</button>` : ""}
        ${a.awaiting_dispatch ? `<button type="button" class="chip" data-go="warehouse">● ${a.awaiting_dispatch} packed, waiting for dispatch</button>` : ""}
        ${a.surveys_waiting ? `<button type="button" class="chip" data-go="surveys">● ${a.surveys_waiting} survey${a.surveys_waiting > 1 ? "s" : ""} to approve</button>` : ""}
      </div>` : ""}

      <div class="dtiles">
        ${tile("Orders booked", short(k.order_value), `<span class="dtile__sub">${num(k.orders)} order${k.orders === 1 ? "" : "s"} · ${num(k.kw_sold, 2)} kW</span>${delta(k.order_value, p.order_value)}`, " dtile--hero")}
        ${tile("Cash collected", short(k.cash), delta(k.cash, p.cash))}
        ${tile("Money owed today", short(r.total), `<span class="dtile__sub">${num(r.orders)} orders · ${num(r.awaiting_advance)} awaiting advance</span>`)}
        ${tile("Gross margin", m === null ? "—" : `${m}%`, `<span class="dtile__sub">on orders booked, before overheads</span>${delta(m, mp, { points: true })}`)}
        ${tile("New leads", num(k.leads), `<span class="dtile__sub">${num(k.ai_calls)} AI calls · ${conv === null ? "—" : `${conv}%`} won so far</span>${delta(k.leads, p.leads)}`)}
        ${tile("Installed", `${num(k.kw_installed, 2)} kW`, `<span class="dtile__sub">${num(k.installs)} installation${k.installs === 1 ? "" : "s"}${k.days_to_install !== null ? ` · ${num(k.days_to_install, 1)} days from confirmation` : ""}</span>${delta(k.kw_installed, p.kw_installed)}`)}
        ${tile("Service tickets", num(k.tickets), `<span class="dtile__sub">${num(k.tickets_resolved)} resolved · ${k.sla_met_pct === null ? "—" : `${k.sla_met_pct}%`} on time · ${num(k.checkups_done)} checkups</span>${delta(k.tickets, p.tickets, { lowerIsBetter: true })}`)}
        ${tile("Customer rating", k.rating === null ? "—" : `${num(k.rating, 1)} ★`, `<span class="dtile__sub">service charges ${short(k.service_charges)}</span>${delta(k.rating, p.rating)}`)}
      </div>

      <div class="dgrid">
        <section class="card dcard dcard--wide">
          <h3>Sales funnel <small class="muted">· leads that arrived in ${esc(monthName(data.month, "short"))}, how far they've got</small></h3>
          ${funnel(data.funnel)}
        </section>
        <section class="card dcard">
          <h3>Leads by source</h3>
          ${ranked(data.sources.map((s) => ({ label: SOURCES[s.source] || s.source, value: s.leads, tip: `${SOURCES[s.source] || s.source}: ${s.leads} leads, ${s.won} won` })), (v) => num(v))}
          ${tableView(["Source", "Leads", "Won"], data.sources.map((s) => [SOURCES[s.source] || s.source, num(s.leads), num(s.won)]))}
        </section>
      </div>

      <div class="dgrid dgrid--3">
        ${columns("Orders booked (₹)", "order_value", short)}
        ${columns("Cash collected (₹)", "cash", short)}
        ${columns("New leads", "leads", (v) => num(v))}
      </div>

      ${money ? moneySections() : ""}

      <div class="dgrid">
        <section class="card dcard">
          <h3>Money owed by customers <small class="muted">· today, by age of the order</small></h3>
          <table class="dtable">
            <tbody>
              ${[["0–30 days", r.d0_30], ["31–60 days", r.d31_60], ["61–90 days", r.d61_90], ["Over 90 days", r.d90]].map(([l, v]) =>
                `<tr><td>${l}</td><td class="right${Number(v) > 0 && l.startsWith("Over") ? " overdue" : ""}">${inr(v)}</td></tr>`).join("")}
              <tr class="total"><td>Total</td><td class="right">${inr(r.total)}</td></tr>
            </tbody>
          </table>
          <p class="muted">Stock on the shelf: ${inr(data.stock.value)} at cost (${inr(data.stock.reserved_value)} reserved for orders) · ${num(data.stock.low)} low-stock item${data.stock.low === 1 ? "" : "s"}</p>
        </section>
        <section class="card dcard">
          <h3>Crews this month</h3>
          <div class="table-wrap"><table class="dtable">
            <thead><tr><th>Crew</th><th class="right">Installs</th><th class="right">kW</th><th class="right">Service visits</th><th class="right">Rating</th></tr></thead>
            <tbody>${data.crews.map((c) => `<tr><td>${esc(c.crew)}</td><td class="right">${num(c.installs)}</td><td class="right">${num(c.kw, 2)}</td><td class="right">${num(c.visits)}</td><td class="right">${c.rating === null ? "—" : `${num(c.rating, 1)} ★`}</td></tr>`).join("")
              || `<tr><td colspan="5" class="muted">No crews.</td></tr>`}</tbody>
          </table></div>
        </section>
      </div>

      <section class="card dcard">
        <h3>Biggest orders this month</h3>
        <div class="table-wrap"><table class="dtable">
          <thead><tr><th>Order</th><th>Customer</th><th class="right">System</th><th class="right">Value</th><th class="right">Paid</th><th class="right">Status</th></tr></thead>
          <tbody>${data.top_orders.map((o) => `<tr><td>${esc(o.order_number)}</td><td>${esc(o.name)} <span class="code">${esc(o.client_code || "")}</span></td>
            <td class="right">${num(o.system_size_kw, 2)} kW</td><td class="right">${inr(o.total)}</td><td class="right">${inr(o.amount_paid)}</td>
            <td class="right">${esc(window.Orders?.ORDER_STATUS[o.status]?.[0] || o.status)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No orders this month.</td></tr>`}</tbody>
        </table></div>
      </section>`;
  }

  // ---------- Profit per job, unfinished work, invoices, subsidy, payroll ----------
  const WAITING_ORDER = ["Advance payment", "Packing", "Dispatch", "Installation", "Balance payment"];
  function moneySections() {
    const jobs = per?.jobs || money.jobs || [];
    const profit = jobs.reduce((a, j) => a + Number(j.profit), 0);
    const losses = jobs.filter((j) => Number(j.profit) < 0);
    const inv = money.invoices, sub = money.subsidy, pay = money.payroll;
    const waiting = WAITING_ORDER.map((w) => [w, money.unfinished.filter((u) => u.waiting_for === w)]).filter(([, l]) => l.length);
    return `
      <div class="dtiles">
        ${tile("Profit on installations", short(profit), `<span class="dtile__sub">${jobs.length} installed ${esc(periodLabel())}${losses.length ? ` · <b class="overdue">${losses.length} lost money</b>` : ""}</span>`)}
        ${per ? tile("Stock purchases", short(per.purchases.total), `<span class="dtile__sub">${num(per.purchases.count)} supplier bill${per.purchases.count === 1 ? "" : "s"} ${esc(periodLabel())} · ${num(per.open_repairs)} repairs open now</span>${delta(per.purchases.total, per.purchases_prev, { lowerIsBetter: true })}`) : ""}
        ${tile("Technician pay", short(pay.total), `<span class="dtile__sub">${num(pay.hours, 1)} h on jobs · ${short(pay.total - pay.paid)} still to pay</span>`)}
        ${tile("Subsidy pending", short(sub.pending_amount), `<span class="dtile__sub">${num(sub.cases)} customers waiting${sub.stuck ? ` · <b class="overdue">${sub.stuck} stuck 3+ weeks</b>` : ""} · ${short(sub.credited_this_month)} credited this month</span>`)}
        ${tile("Invoices", num(inv.to_issue.length), `<span class="dtile__sub">to issue · ${num(inv.not_sent)} not sent · ${short(inv.issued_value)} invoiced this month${Number(inv.unpaid_service) > 0 ? ` · repairs unpaid ${short(inv.unpaid_service)}` : ""}</span>`, inv.to_issue.length ? " dtile--alert" : "")}
      </div>

      <section class="card dcard">
        <h3>Profit per installation <small class="muted">· finished ${esc(periodLabel())}; revenue excl. GST minus parts at cost, crew hours, other costs and free repairs</small></h3>
        ${jobs.length ? `<div class="table-wrap"><table class="dtable">
          <thead><tr><th>Order</th><th>Customer</th><th class="right">kW</th><th class="right">Revenue</th><th class="right">Parts</th><th class="right">Crew</th><th class="right">Other</th><th class="right">Profit</th><th class="right">Margin</th></tr></thead>
          <tbody>${jobs.map((j) => `<tr class="${Number(j.profit) < 0 ? "is-loss" : ""}" data-order="${j.order_id}" tabindex="0">
            <td>${esc(j.order_number)}</td><td>${esc(j.client_name)} <span class="code">${esc(j.client_code || "")}</span></td>
            <td class="right">${num(j.system_size_kw, 2)}</td><td class="right">${inr(j.revenue)}</td><td class="right">${inr(j.parts_cost)}</td>
            <td class="right">${inr(j.labour_cost)}<span class="sub">${num(j.labour_hours, 1)} h</span></td><td class="right">${inr(Number(j.expenses) + Number(j.warranty_cost))}</td>
            <td class="right"><b class="${Number(j.profit) < 0 ? "overdue" : ""}">${Number(j.profit) < 0 ? "▼ " : ""}${inr(j.profit)}</b></td>
            <td class="right">${j.margin_pct === null ? "—" : `${num(j.margin_pct, 1)}%`}</td></tr>`).join("")}</tbody>
        </table></div>` : `<p class="muted">No installations finished this month yet.</p>`}
      </section>

      <div class="dgrid">
        <section class="card dcard">
          <h3>Still unfinished <small class="muted">· ${money.unfinished.length} order${money.unfinished.length === 1 ? "" : "s"}, by what they're waiting for</small></h3>
          ${waiting.length ? waiting.map(([w, list]) => `<details class="unfinished"><summary><b>${esc(w)}</b> <em>${list.length}</em></summary>
            <ul>${list.map((u) => `<li data-order="${u.order_id}" tabindex="0"><span>${esc(u.order_number)} · ${esc(u.client_name)}</span>
              <span class="muted">${u.install_date ? `install ${esc(new Date(u.install_date + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }))} · ` : ""}${Number(u.balance) > 0 ? `owes ${short(u.balance)}` : "paid"}</span></li>`).join("")}</ul>
          </details>`).join("") : `<p class="muted">Nothing unfinished. Every order is completed.</p>`}
        </section>
        <section class="card dcard">
          <h3>Paperwork</h3>
          <table class="dtable"><tbody>
            <tr><td>Tax invoices to issue</td><td class="right${inv.to_issue.length ? " overdue" : ""}">${num(inv.to_issue.length)}</td></tr>
            <tr><td>Invoices not sent yet</td><td class="right">${num(inv.not_sent)}</td></tr>
            <tr><td>Subsidy: registration</td><td class="right">${num(sub.by_step.registration)}</td></tr>
            <tr><td>Subsidy: feasibility</td><td class="right">${num(sub.by_step.feasibility)}</td></tr>
            <tr><td>Subsidy: installed, waiting for inspection</td><td class="right">${num(sub.by_step.installation)}</td></tr>
            <tr><td>Subsidy: inspected, claim to file</td><td class="right">${num(sub.by_step.inspection)}</td></tr>
            <tr><td>Subsidy: claimed, waiting for credit</td><td class="right">${num(sub.by_step.claim)}</td></tr>
          </tbody></table>
          <div class="m-actions"><button type="button" class="btn btn--ghost btn--sm" data-go="subsidy">Subsidy screen</button>
            <button type="button" class="btn btn--ghost btn--sm" data-go="team">Team &amp; pay</button></div>
        </section>
      </div>`;
  }

  // ---------- Tooltip (hover and keyboard focus) ----------
  const tip = $("dirTip");
  function showTip(el) {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - t.width - 8, Math.max(8, r.left + r.width / 2 - t.width / 2))}px`;
    tip.style.top = `${Math.max(8, r.top - t.height - 8)}px`;
  }
  ["mouseover", "focusin"].forEach((ev) => $("dirBody").addEventListener(ev, (e) => {
    const el = e.target.closest("[data-tip]");
    if (el) showTip(el);
  }));
  ["mouseout", "focusout"].forEach((ev) => $("dirBody").addEventListener(ev, (e) => {
    if (e.target.closest("[data-tip]")) tip.hidden = true;
  }));
  $("dirBody").addEventListener("click", (e) => {
    const ord = e.target.closest("[data-order]");
    if (ord) return window.Orders?.openOrder(ord.dataset.order);
    const go = e.target.closest("[data-go]");
    if (!go) return;
    if (go.dataset.go === "surveys") return $("surveysBtn").click();
    if (go.dataset.filter) window.CRM.state.viewFilter = { [go.dataset.go]: go.dataset.filter };
    window.CRM.showView(go.dataset.go);
  });

  // ---------- Month picker (one filter for the whole page) ----------
  $("dirMonth").addEventListener("change", (e) => { if (e.target.value) { month = e.target.value; load(); } });
  const shift = (n) => {
    const d = new Date(`${month}-01T00:00:00`);
    d.setMonth(d.getMonth() + n);
    month = d.toLocaleDateString("en-CA").slice(0, 7);
    load();
  };
  $("dirPrev").addEventListener("click", () => shift(-1));
  $("dirPeriod").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-period]");
    if (!b) return;
    period = b.dataset.period;
    load();
  });
  $("dirNext").addEventListener("click", () => shift(1));

  // ---------- Export ----------
  function kpiRows() {
    const k = data.now, p = data.prev;
    const row = (label, a, b, fmt) => [label, fmt(a), fmt(b)];
    const n = (v) => (v === null || v === undefined ? "-" : String(v));
    const rs = (v) => "Rs. " + Math.round(Number(v) || 0).toLocaleString("en-IN");
    const pc = (v) => (v === null ? "-" : `${v}%`);
    return [
      row("Orders booked (value)", k.order_value, p.order_value, rs),
      row("Orders booked (count)", k.orders, p.orders, n),
      row("kW sold", k.kw_sold, p.kw_sold, n),
      row("Average order", k.avg_order, p.avg_order, rs),
      row("Cash collected", k.cash, p.cash, rs),
      row("Gross margin (before overheads)", margin(k), margin(p), pc),
      row("New leads", k.leads, p.leads, n),
      row("AI calls", k.ai_calls, p.ai_calls, n),
      row("Surveys approved", k.surveys_approved, p.surveys_approved, n),
      row("Final quotes sent", k.quotes_sent, p.quotes_sent, n),
      row("Installations", k.installs, p.installs, n),
      row("kW installed", k.kw_installed, p.kw_installed, n),
      row("Days from confirmation to install", k.days_to_install, p.days_to_install, n),
      row("Service tickets opened", k.tickets, p.tickets, n),
      row("Service tickets resolved", k.tickets_resolved, p.tickets_resolved, n),
      row("Resolved within deadline", k.sla_met_pct, p.sla_met_pct, pc),
      row("Checkups done", k.checkups_done, p.checkups_done, n),
      row("Service charges", k.service_charges, p.service_charges, rs),
      row("Customer rating (out of 5)", k.rating, p.rating, n),
    ];
  }

  $("dirCsv").addEventListener("click", () => {
    if (!data) return;
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Metric", monthName(data.month), monthName(prevMonth())], ...kpiRows()];
    const blob = new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sunpower-month-end-${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("dirPdf").addEventListener("click", async () => {
    if (!data) return;
    await window.Quotes.loadSettings();
    const P = window.Quotes.pdf;
    const { W, M, orange, navy, muted } = P;
    const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    const rs = (v) => "Rs. " + Math.round(Number(v) || 0).toLocaleString("en-IN");
    P.header(doc);
    doc.setTextColor(...navy).setFont("helvetica", "bold").setFontSize(19).text("MONTH-END REPORT", M, 46);
    doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...muted).text(`${monthName(data.month)} · compared with ${monthName(prevMonth())}`, M, 52);
    doc.text(`Prepared ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`, W - M, 46, { align: "right" });
    // Number columns (right-aligned, heading too); every other column reads left to right
    const table = (startY, head, body, right = [1, 2, 3, 4]) => {
      doc.autoTable({
        startY, margin: { left: M, right: M }, head: [head], body, theme: "grid",
        styles: { font: "helvetica", fontSize: 9, cellPadding: 2, lineColor: [230, 225, 218] },
        headStyles: { fillColor: navy, textColor: 255 },
        columnStyles: Object.fromEntries(right.map((i) => [i, { halign: "right" }])),
        didParseCell: (d) => { if (d.section === "head" && right.includes(d.column.index)) d.cell.styles.halign = "right"; },
      });
      return doc.lastAutoTable.finalY;
    };
    // A section heading never sits alone at the bottom of a page: rows = how many table rows follow it
    const heading = (text, y, rows) => {
      if (y + 14 + rows * 7 > 280) { doc.addPage(); y = 20; }
      doc.setTextColor(...orange).setFont("helvetica", "bold").setFontSize(10).text(text, M, y);
      return y + 2;
    };
    let y = table(57, ["Headline", monthName(data.month, "short"), monthName(prevMonth(), "short")], kpiRows());
    const f = data.funnel;
    y = heading("SALES FUNNEL (leads that arrived this month)", y + 8, 6);
    y = table(y + 1, ["Stage", "Leads", "% of leads"], [["Leads", f.leads], ["Survey booked", f.survey_booked], ["Survey approved", f.survey_approved], ["Quote sent", f.quote_sent], ["Won", f.won]]
      .map(([l, n]) => [l, String(n), f.leads ? `${Math.round((n / f.leads) * 100)}%` : "-"]));
    const r = data.receivables;
    y = heading("MONEY OWED BY CUSTOMERS (today)", y + 8, 6);
    y = table(y + 1, ["Age of order", "Amount"], [["0-30 days", rs(r.d0_30)], ["31-60 days", rs(r.d31_60)], ["61-90 days", rs(r.d61_90)], ["Over 90 days", rs(r.d90)], ["Total", rs(r.total)]]);
    y = heading("CREWS", y + 8, data.crews.length + 1);
    y = table(y + 1, ["Crew", "Installs", "kW", "Service visits", "Rating"], data.crews.map((c) => [c.crew, String(c.installs), String(c.kw), String(c.visits), c.rating === null ? "-" : String(c.rating)]));
    if (money?.jobs?.length) {
      y = heading("PROFIT PER INSTALLATION (finished this month)", y + 8, money.jobs.length + 1);
      y = table(y + 1, ["Order", "Revenue", "Parts", "Crew", "Other", "Profit"], money.jobs.map((j) => [`${j.order_number} ${j.client_name}`, rs(j.revenue), rs(j.parts_cost),
        rs(j.labour_cost), rs(Number(j.expenses) + Number(j.warranty_cost)), rs(j.profit)]), [1, 2, 3, 4, 5]);
    }
    y = heading("BIGGEST ORDERS", y + 8, data.top_orders.length + 1);
    table(y + 1, ["Order", "Customer", "kW", "Value", "Paid"], data.top_orders.map((o) => [o.order_number, `${o.name} ${o.client_code || ""}`, String(o.system_size_kw), rs(o.total), rs(o.amount_paid)]), [2, 3, 4]);
    P.footer(doc);
    doc.save(`sunpower-month-end-${month}.pdf`);
  });

  registerView("director", load);

  // Fresh figures while the screen is open
  setInterval(() => { if (viewOpen("director")) load(); }, 120000);
})();
