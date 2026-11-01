// Money and people: technician hours & pay (Team), PM Surya Ghar subsidy paperwork (Subsidy),
// and the costs / profit / subsidy blocks inside an order
(() => {
  const { sb, state, esc, toast, todayISO, fmtDay, staffName, registerView, viewOpen } = window.CRM;
  const $ = (id) => document.getElementById(id);

  const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
  const num = (n, d = 2) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d }));
  const monthStart = (m) => `${m}-01`;

  // ================================================================
  // Team: hours and pay (owner and managers)
  // ================================================================
  let teamMonth = null;
  let pay = [];
  let logs = [];

  async function loadTeam() {
    teamMonth = teamMonth || todayISO().slice(0, 7);
    $("teamMonth").value = teamMonth;
    const end = window.CRM.addDays(monthStart(teamMonth), 40).slice(0, 7) + "-01";
    const [{ data: p, error }, { data: l }] = await Promise.all([
      sb.rpc("technician_pay", { p_month: monthStart(teamMonth) }),
      sb.from("work_logs").select("*, orders(order_number), service_tickets(ticket_number)")
        .gte("work_date", monthStart(teamMonth)).lt("work_date", end).order("work_date", { ascending: false }),
    ]);
    if (error) return ($("teamBody").innerHTML = `<p class="empty">Team pay isn't set up yet (run finance.sql). ${esc(error.message)}</p>`);
    pay = p || [];
    logs = l || [];
    renderTeam();
  }

  function renderTeam() {
    const total = pay.reduce((a, r) => a + Number(r.total), 0);
    const paid = pay.reduce((a, r) => a + Number(r.paid || 0), 0);
    const hours = pay.reduce((a, r) => a + Number(r.hours), 0);
    $("teamBody").innerHTML = `
      <div class="dtiles">
        <div class="dtile"><span class="dtile__label">Pay this month</span><strong>${esc(inr(total))}</strong><span class="dtile__sub">${pay.length} technician${pay.length === 1 ? "" : "s"}</span></div>
        <div class="dtile"><span class="dtile__label">Paid so far</span><strong>${esc(inr(paid))}</strong><span class="dtile__sub">${esc(inr(total - paid))} still to pay</span></div>
        <div class="dtile"><span class="dtile__label">Hours on jobs</span><strong>${esc(num(hours, 1))} h</strong><span class="dtile__sub">from installation and service forms</span></div>
      </div>
      <section class="card dcard">
        <h3>Pay sheet</h3>
        <div class="table-wrap"><table class="dtable">
          <thead><tr><th>Technician</th><th class="right">Hours</th><th class="right">Installs</th><th class="right">Visits</th><th class="right">Salary</th>
            <th class="right">Bonuses</th><th class="right">Total</th><th class="right">Paid</th><th></th></tr></thead>
          <tbody>${pay.map((r) => `<tr data-email="${esc(r.staff_email)}">
            <td><b>${esc(r.name || r.staff_email)}</b><span class="sub">${esc(inr(r.cost_per_hour))}/h cost</span></td>
            <td class="right">${esc(num(r.hours, 2))}</td><td class="right">${esc(r.installs)}</td><td class="right">${esc(r.visits)}</td>
            <td class="right">${esc(inr(r.monthly_salary))}</td>
            <td class="right">${esc(inr(Number(r.install_pay) + Number(r.visit_pay) + Number(r.hourly_pay)))}</td>
            <td class="right"><b>${esc(inr(r.total))}</b></td>
            <td class="right">${r.paid !== null ? `${esc(inr(r.paid))}<span class="sub">${esc(fmtDay(r.paid_on))}</span>` : `<span class="muted">—</span>`}</td>
            <td class="right nowrap">
              <button type="button" class="btn btn--ghost btn--sm" data-rates>Rates</button>
              ${r.paid === null ? `<button type="button" class="btn btn--primary btn--sm" data-pay>Record pay</button>` : ""}
            </td>
          </tr>`).join("") || `<tr><td colspan="9" class="muted">No technicians on the staff list yet.</td></tr>`}</tbody>
        </table></div>
        <p class="muted">Total = monthly salary + per-installation bonus + per-visit bonus + hourly pay. Set each person's rates with “Rates”.</p>
      </section>
      <section class="card dcard">
        <div class="section-head"><h3>Hours on jobs</h3><button type="button" class="btn btn--ghost btn--sm" id="teamAddLog">+ Add hours</button></div>
        <form class="manage" id="teamLogForm" hidden>
          <label><span>Technician</span><select name="staff_email">${pay.map((r) => `<option value="${esc(r.staff_email)}">${esc(r.name || r.staff_email)}</option>`).join("")}</select></label>
          <label><span>Date</span><input type="date" name="work_date" value="${esc(todayISO())}" required></label>
          <label><span>Hours</span><input type="number" name="hours" min="0.25" max="16" step="0.25" required></label>
          <label><span>Note</span><input name="notes" placeholder="e.g. warehouse help, training"></label>
          <div class="form-foot span-2"><button type="submit" class="btn btn--primary btn--sm">Save hours</button></div>
        </form>
        <div class="table-wrap"><table class="dtable">
          <thead><tr><th>Date</th><th>Technician</th><th>Work</th><th class="right">Hours</th><th></th></tr></thead>
          <tbody>${logs.map((w) => `<tr data-log="${w.id}">
            <td>${esc(fmtDay(w.work_date))}</td><td>${esc(staffName(w.staff_email))}</td>
            <td>${w.kind === "install" ? `Installation ${esc(w.orders?.order_number || "")}` : w.kind === "service" ? `Service ${esc(w.service_tickets?.ticket_number || "")}` : esc(w.notes || "Other")}
              ${w.source === "manual" ? `<span class="sub">added by hand</span>` : ""}</td>
            <td class="right"><input type="number" class="hours-input" data-hours min="0" max="16" step="0.25" value="${esc(Number(w.hours))}" aria-label="Hours"></td>
            <td class="right"><button type="button" class="icon-btn" data-del-log aria-label="Delete">✕</button></td>
          </tr>`).join("") || `<tr><td colspan="5" class="muted">No hours this month yet. They appear automatically when installations and service visits are completed.</td></tr>`}</tbody>
        </table></div>
      </section>`;
  }

  $("teamMonth").addEventListener("change", (e) => { if (e.target.value) { teamMonth = e.target.value; loadTeam(); } });
  $("teamBody").addEventListener("click", async (e) => {
    const tr = e.target.closest("tr[data-email]");
    const r = tr && pay.find((x) => x.staff_email === tr.dataset.email);
    if (e.target.closest("[data-rates]")) return openRates(r);
    if (e.target.closest("[data-pay]")) {
      const amount = prompt(`Pay ${r.name || r.staff_email} for ${new Date(monthStart(teamMonth) + "T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" })}: amount (₹)`, Math.round(r.total));
      if (amount === null) return;
      const reference = prompt("How / reference (e.g. NEFT UTR, cash):", "") ?? "";
      const { error } = await sb.from("technician_payouts").insert({
        month: monthStart(teamMonth), staff_email: r.staff_email, amount: Number(amount) || 0, method: reference ? "bank" : "cash",
        reference: reference.trim() || null, created_by: state.me.email,
      });
      if (error) return toast("Couldn't record: " + error.message);
      toast("Pay recorded");
      return loadTeam();
    }
    if (e.target.closest("#teamAddLog")) return ($("teamLogForm").hidden = !$("teamLogForm").hidden);
    const del = e.target.closest("[data-del-log]");
    if (del) {
      if (!confirm("Delete these hours?")) return;
      const { error } = await sb.from("work_logs").delete().eq("id", del.closest("tr").dataset.log);
      if (error) return toast(error.message);
      return loadTeam();
    }
  });
  $("teamBody").addEventListener("change", async (e) => {
    if (!e.target.matches("[data-hours]")) return;
    const { error } = await sb.from("work_logs").update({ hours: Number(e.target.value) || 0 }).eq("id", e.target.closest("tr").dataset.log);
    if (error) return toast("Couldn't save: " + error.message);
    toast("Hours updated");
    loadTeam();
  });
  $("teamBody").addEventListener("submit", async (e) => {
    if (e.target.id !== "teamLogForm") return;
    e.preventDefault();
    const f = e.target;
    const { error } = await sb.from("work_logs").insert({
      staff_email: f.staff_email.value, work_date: f.work_date.value, kind: "other", hours: Number(f.hours.value),
      source: "manual", notes: f.notes.value.trim() || null, created_by: state.me.email,
    });
    if (error) return toast("Couldn't save: " + error.message);
    toast("Hours added");
    loadTeam();
  });

  // Rates: what an hour costs the company (for job profit) and how the person is paid
  let ratesFor = null;
  async function openRates(r) {
    ratesFor = r;
    const { data } = await sb.from("technician_rates").select("*").ilike("staff_email", r.staff_email).maybeSingle();
    const f = $("ratesForm");
    $("ratesTitle").textContent = `Rates · ${r.name || r.staff_email}`;
    ["cost_per_hour", "monthly_salary", "per_install", "per_visit", "hourly_rate"].forEach((k) => (f[k].value = data?.[k] ?? (k === "cost_per_hour" ? r.cost_per_hour : 0)));
    $("ratesError").textContent = "";
    $("ratesModal").hidden = false;
  }
  $("ratesForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const row = { staff_email: ratesFor.staff_email, updated_at: new Date().toISOString() };
    ["cost_per_hour", "monthly_salary", "per_install", "per_visit", "hourly_rate"].forEach((k) => (row[k] = Number(f[k].value) || 0));
    const { error } = await sb.from("technician_rates").upsert(row);
    if (error) return ($("ratesError").textContent = error.message);
    $("ratesModal").hidden = true;
    toast("Rates saved");
    loadTeam();
  });
  document.querySelectorAll("[data-close-rates]").forEach((el) => el.addEventListener("click", () => ($("ratesModal").hidden = true)));
  registerView("team", loadTeam);

  // ================================================================
  // Subsidy paperwork (PM Surya Ghar)
  // ================================================================
  const STEPS = [
    ["registration", "Registered", "registered_on"], ["feasibility", "Feasibility approved", "feasibility_on"],
    ["installation", "Installed", "installed_on"], ["inspection", "DISCOM inspection / net meter", "inspection_on"],
    ["claim", "Subsidy claimed", "claim_on"], ["credited", "Credited to customer", "credited_on"],
  ];
  const DOCS = [["aadhaar", "Aadhaar"], ["electricity_bill", "Latest electricity bill"], ["bank_passbook", "Bank passbook / cancelled cheque"],
    ["ownership_proof", "Ownership proof"], ["site_photo", "Photo with the installed system"], ["net_meter_agreement", "Net-metering agreement"]];
  let cases = [];
  let subTab = "open";
  let subSearch = "";

  async function loadSubsidy() {
    const { data, error } = await sb.from("subsidy_cases").select("*, leads(name, client_code, location, phone), orders(order_number, status)")
      .order("updated_at", { ascending: true });
    if (error) return ($("subBody").innerHTML = `<p class="empty">Subsidy tracking isn't set up yet (run finance.sql).</p>`);
    cases = data;
    renderSubsidy();
  }

  const stale = (c) => !["credited", "rejected"].includes(c.step) && Date.now() - new Date(c.updated_at) > 21 * 864e5;
  function progress(c) {
    const at = STEPS.findIndex(([k]) => k === c.step);
    return `<span class="steps-mini" title="${esc(c.step)}">${STEPS.map(([k, label], i) =>
      `<i class="${c.step === "rejected" ? "is-bad" : i <= at ? "is-done" : ""}" title="${esc(label)}"></i>`).join("")}</span>`;
  }

  function renderSubsidy() {
    const q = subSearch.toLowerCase();
    const base = cases.filter((c) => !q || [c.leads?.name, c.leads?.client_code, c.orders?.order_number, c.application_no].some((v) => (v || "").toLowerCase().includes(q)));
    const tabs = [["open", "In progress", (c) => !["credited", "rejected"].includes(c.step)], ["stuck", "No progress 3+ weeks", stale],
      ...STEPS.map(([k, label]) => [k, label, (c) => c.step === k]), ["rejected", "Rejected", (c) => c.step === "rejected"], ["all", "All", () => true]];
    $("subTabs").innerHTML = tabs.map(([k, label, fn]) => `<button data-tab="${k}" class="${subTab === k ? "is-active" : ""}">${esc(label)} <em class="${k === "stuck" && base.some(stale) ? "alert" : ""}">${base.filter(fn).length}</em></button>`).join("");
    const rows = base.filter(tabs.find(([k]) => k === subTab)[2]);
    const pending = cases.filter((c) => !["credited", "rejected"].includes(c.step)).reduce((a, c) => a + Number(c.amount), 0);
    $("subSub").textContent = `${inr(pending)} of subsidy still to reach customers · ${cases.filter(stale).length} case(s) with no progress for 3+ weeks`;
    $("subBody").innerHTML = rows.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Customer</th><th>Progress</th><th>Application</th><th class="right">Subsidy</th><th class="right">Last update</th></tr></thead>
      <tbody>${rows.map((c) => {
        const label = c.step === "rejected" ? "Rejected" : STEPS.find(([k]) => k === c.step)?.[1];
        return `<tr data-case="${c.id}">
        <td><span class="name">${esc(c.leads?.name || "")}</span><span class="code">${esc(c.leads?.client_code || "")}</span><span class="sub">${esc(c.orders?.order_number || "")} · ${esc(c.discom)}</span></td>
        <td>${progress(c)}<span class="sub${c.step === "rejected" ? " overdue" : ""}">${esc(label)}</span></td>
        <td>${esc(c.application_no || "—")}${c.net_meter_no ? `<span class="sub">Net meter ${esc(c.net_meter_no)}</span>` : ""}</td>
        <td class="right">${esc(inr(c.credited_amount ?? c.amount))}</td>
        <td class="right"><span class="when${stale(c) ? " overdue" : ""}">${esc(window.CRM.relTime(c.updated_at))}</span></td>
      </tr>`;
      }).join("")}</tbody></table></div>` : `<p class="empty">No subsidy cases here. A case opens by itself when an order with a subsidy is confirmed.</p>`;
  }

  $("subTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) { subTab = b.dataset.tab; renderSubsidy(); } });
  $("subSearch").addEventListener("input", (e) => { subSearch = e.target.value.trim(); renderSubsidy(); });
  $("subBody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-case]"); if (tr) openCase(tr.dataset.case); });
  registerView("subsidy", loadSubsidy);

  let editing = null;
  let onCaseSaved = null;
  async function openCase(id, after) {
    const { data: c, error } = await sb.from("subsidy_cases").select("*, leads(name, client_code, location), orders(order_number)").eq("id", id).single();
    if (error) return toast(error.message);
    editing = c;
    onCaseSaved = after || null;
    const f = $("subForm");
    $("subTitle").textContent = `Subsidy · ${c.leads?.name || ""}`;
    $("subMeta").textContent = `${c.leads?.client_code || ""} · ${c.orders?.order_number || ""} · ${c.scheme} · ${inr(c.amount)}`;
    ["application_no", "discom", "net_meter_no", "credited_amount", "notes", ...STEPS.map(([, , d]) => d)].forEach((k) => (f[k].value = c[k] ?? ""));
    f.rejected.checked = c.step === "rejected";
    $("subDocs").innerHTML = DOCS.map(([k, label]) => `<label class="check"><input type="checkbox" name="doc_${k}" ${c.documents?.[k] ? "checked" : ""}> ${esc(label)}</label>`).join("");
    $("subError").textContent = "";
    $("subModal").hidden = false;
  }
  $("subForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const patch = {
      application_no: f.application_no.value.trim() || null, discom: f.discom.value.trim() || "TGSPDCL", net_meter_no: f.net_meter_no.value.trim() || null,
      credited_amount: f.credited_amount.value === "" ? null : Number(f.credited_amount.value), notes: f.notes.value.trim() || null,
      documents: Object.fromEntries(DOCS.map(([k]) => [k, f[`doc_${k}`].checked])),
      // The step follows the dates; "rejected" overrides, and unticking it lets the dates decide again
      step: f.rejected.checked ? "rejected" : "registration",
    };
    STEPS.forEach(([, , d]) => (patch[d] = f[d].value || null));
    if (patch.credited_on && !patch.credited_amount) patch.credited_amount = editing.amount;
    const { error } = await sb.from("subsidy_cases").update(patch).eq("id", editing.id);
    if (error) return ($("subError").textContent = error.message);
    $("subModal").hidden = true;
    toast("Subsidy updated");
    if (viewOpen("subsidy")) loadSubsidy();
    onCaseSaved?.();
  });
  document.querySelectorAll("[data-close-sub]").forEach((el) => el.addEventListener("click", () => ($("subModal").hidden = true)));

  // ================================================================
  // Inside an order: costs & profit, subsidy
  // ================================================================
  const EXPENSES = { transport: "Transport", discom_fees: "DISCOM / net-meter fees", civil_work: "Civil work", extra_material: "Extra material",
    subcontract: "Subcontractor", other: "Other" };

  async function orderExtras(o, reopen) {
    const costsEl = $("oCosts"), subEl = $("oSubsidy");
    if (!costsEl) return;
    const [{ data: jp, error }, { data: exp }, { data: sc }] = await Promise.all([
      sb.rpc("job_profit", { p_order_ids: [o.id] }),
      sb.from("job_expenses").select("*").eq("order_id", o.id).order("spent_on"),
      sb.from("subsidy_cases").select("*").eq("order_id", o.id).maybeSingle(),
    ]);
    if (error) return; // finance.sql not run yet
    const p = jp?.[0];
    costsEl.innerHTML = `
      <h3 class="form-section">Costs &amp; profit</h3>
      ${p ? `<div class="o-sum o-sum--5">
        <div><span>Revenue (excl. GST)</span><b>${esc(inr(p.revenue))}</b></div>
        <div><span>Parts at cost</span><b>${esc(inr(p.parts_cost))}</b></div>
        <div><span>Crew (${esc(num(p.labour_hours, 1))} h)</span><b>${esc(inr(p.labour_cost))}</b></div>
        <div><span>Other costs${Number(p.warranty_cost) > 0 ? " + free repairs" : ""}</span><b>${esc(inr(Number(p.expenses) + Number(p.warranty_cost)))}</b></div>
        <div><span>Profit</span><b class="${Number(p.profit) < 0 ? "overdue" : "profit"}">${esc(inr(p.profit))}${p.margin_pct !== null ? ` <small>${esc(p.margin_pct)}%</small>` : ""}</b></div>
      </div>` : ""}
      <ul class="exp-list">${(exp || []).map((x) => `<li data-exp="${x.id}"><span>${esc(EXPENSES[x.category])}${x.note ? ` · ${esc(x.note)}` : ""}</span><b>${esc(inr(x.amount))}</b>
        <button type="button" class="icon-btn" data-del-exp aria-label="Delete">✕</button></li>`).join("")}</ul>
      <form class="exp-form" id="expForm">
        <select name="category">${Object.entries(EXPENSES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
        <input type="number" name="amount" min="1" step="1" placeholder="₹" required>
        <input name="note" placeholder="Note (optional)">
        <button type="submit" class="btn btn--ghost btn--sm">Add cost</button>
      </form>`;
    costsEl.onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const { error: err } = await sb.from("job_expenses").insert({ order_id: o.id, category: f.category.value, amount: Number(f.amount.value), note: f.note.value.trim() || null, created_by: state.me.email });
      if (err) return toast(err.message);
      orderExtras(o, reopen);
    };
    costsEl.onclick = async (e) => {
      const d = e.target.closest("[data-del-exp]");
      if (!d || !confirm("Delete this cost?")) return;
      await sb.from("job_expenses").delete().eq("id", d.closest("li").dataset.exp);
      orderExtras(o, reopen);
    };

    subEl.innerHTML = sc ? `<h3 class="form-section">Subsidy</h3>
      <div class="m-actions">${progress(sc)} <span>${esc(sc.step === "rejected" ? "Rejected" : STEPS.find(([k]) => k === sc.step)?.[1])}${sc.application_no ? ` · ${esc(sc.application_no)}` : ""} · ${esc(inr(sc.amount))}</span>
        <button type="button" class="btn btn--ghost btn--sm" data-open-case>Update</button></div>` : "";
    subEl.onclick = (e) => { if (e.target.closest("[data-open-case]")) openCase(sc.id, () => orderExtras(o, reopen)); };
  }

  window.Finance = { orderExtras, openCase };
})();
