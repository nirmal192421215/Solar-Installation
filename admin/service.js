// After-sales service: breakdown tickets (rainy season), warranty + SLA, visits, pre-monsoon checkup campaigns
(() => {
  const { sb, state, esc, toast, todayISO, fmtDay, fmtDateTime, relTime, openDrawer, staffName, registerView, viewOpen, loadTiles } = window.CRM;
  const $ = (id) => document.getElementById(id);

  const CATEGORY = {
    safety: "Sparks / smoke / shock", no_generation: "No generation", low_generation: "Low generation", inverter_error: "Inverter error",
    tripping: "Tripping", water_leak: "Water leak", physical_damage: "Storm / physical damage", wiring: "Wiring", checkup: "Pre-monsoon checkup", other: "Other",
  };
  const PRIORITY = { urgent: ["Urgent", "p-urgent"], high: ["High", "p-high"], normal: ["Normal", "p-normal"], low: ["Low", "p-low"] };
  const STATUS = {
    open: ["Open", "o-wait"], scheduled: ["Visit booked", "o-confirmed"], in_progress: ["On site", "o-packing"],
    resolved: ["Resolved", "o-installed"], closed: ["Closed", "o-done"], cancelled: ["Cancelled", "o-cancelled"],
  };
  const WARRANTY = { in_warranty: ["In warranty", "w-ok"], out_of_warranty: ["Warranty expired", "w-bad"], not_covered: ["Not covered", "w-bad"], unknown: ["Warranty unknown", ""] };
  const SLOTS = ["Morning 9–1", "Afternoon 2–6"];
  const ACTIVE = ["open", "scheduled", "in_progress"];

  const badge = (map, k) => {
    const [label, cls] = map[k] || [k, ""];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  };
  const isOverdue = (t) => ACTIVE.includes(t.status) && t.sla_due_at && new Date(t.sla_due_at) < new Date();
  // "due in 3h" / "overdue by 2h"
  function slaText(t) {
    if (!t.sla_due_at) return "";
    if (!ACTIVE.includes(t.status)) return t.sla_met === false ? "missed deadline" : t.sla_met ? "within deadline" : "";
    const mins = Math.round((new Date(t.sla_due_at) - Date.now()) / 60000);
    const span = (m) => (Math.abs(m) >= 1440 ? `${Math.round(Math.abs(m) / 1440)}d` : Math.abs(m) >= 60 ? `${Math.round(Math.abs(m) / 60)}h` : `${Math.abs(m)}m`);
    return mins < 0 ? `overdue by ${span(mins)}` : `due in ${span(mins)}`;
  }

  let tickets = [];
  let campaigns = [];
  let crews = [];
  let filter = "active";
  let kind = "all";
  let search = "";
  let current = null;

  // ---------- Service screen ----------
  async function load() {
    const since = new Date(Date.now() - 60 * 864e5).toISOString();
    const [{ data, error }, { data: camps }, { data: c }] = await Promise.all([
      sb.from("service_tickets").select("*, leads(name, client_code, location, phone), crews(name)")
        .or(`status.in.(open,scheduled,in_progress),created_at.gte.${since},resolved_at.gte.${since}`)
        .order("created_at", { ascending: false }).limit(2000),
      sb.from("service_campaigns").select("*").order("created_at", { ascending: false }).limit(5),
      sb.from("crews").select("*").order("name"),
    ]);
    if (error) {
      $("svcDash").innerHTML = "";
      $("svcRows").innerHTML = "";
      $("svcEmpty").hidden = false;
      $("svcEmpty").textContent = "Service isn't set up yet (run service.sql).";
      return;
    }
    tickets = data;
    campaigns = camps || [];
    crews = c || [];
    renderDash();
    renderList();
  }

  function renderDash() {
    const active = tickets.filter((t) => ACTIVE.includes(t.status));
    const overdue = active.filter(isOverdue);
    const today = todayISO();
    const dueToday = active.filter((t) => t.sla_due_at && new Date(t.sla_due_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) <= today && !isOverdue(t));
    const weekAgo = Date.now() - 7 * 864e5;
    const resolved = tickets.filter((t) => t.resolved_at && new Date(t.resolved_at).getTime() >= weekAgo);
    const fixed = tickets.filter((t) => t.kind === "breakdown" && t.resolved_at);
    const avgHours = fixed.length ? Math.round(fixed.reduce((a, t) => a + (new Date(t.resolved_at) - new Date(t.created_at)) / 36e5, 0) / fixed.length) : null;
    const rated = tickets.filter((t) => t.customer_rating);
    const rating = rated.length ? (rated.reduce((a, t) => a + t.customer_rating, 0) / rated.length).toFixed(1) : null;
    const camp = campaigns[0];
    const campTickets = camp ? tickets.filter((t) => t.campaign_id === camp.id) : [];
    const campDone = campTickets.filter((t) => ["resolved", "closed"].includes(t.status)).length;

    const breakdowns = tickets.filter((t) => t.kind === "breakdown");
    const count = (list, key) => Object.entries(list.reduce((m, t) => ((m[key(t)] = (m[key(t)] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const bars = (rows) => {
      const max = Math.max(1, ...rows.map(([, n]) => n));
      return rows.length ? rows.map(([k, n]) => `<li><span>${esc(k)}</span><i style="width:${Math.max(6, (n / max) * 100)}%"></i><b>${n}</b></li>`).join("") : `<li class="m-empty">Nothing yet.</li>`;
    };

    $("svcDash").innerHTML = `
      <div class="svc-tiles">
        <button type="button" class="tile" data-f="active"><span>Open</span><strong>${active.length}</strong></button>
        <button type="button" class="tile${overdue.length ? " is-alert" : ""}" data-f="overdue"><span>Overdue</span><strong>${overdue.length}</strong></button>
        <button type="button" class="tile" data-f="active"><span>Due today</span><strong>${dueToday.length}</strong></button>
        <button type="button" class="tile" data-f="resolved"><span>Resolved (7 days)</span><strong>${resolved.length}</strong></button>
        <div class="tile"><span>Avg. time to fix</span><strong>${avgHours === null ? "—" : avgHours < 48 ? `${avgHours} h` : `${Math.round(avgHours / 24)} d`}</strong></div>
        <div class="tile"><span>Customer rating</span><strong>${rating ? `${rating} ★` : "—"}</strong></div>
      </div>
      <div class="svc-panels">
        <section class="card svc-panel"><h3>Breakdowns by problem (60 days)</h3><ul class="bars">${bars(count(breakdowns, (t) => CATEGORY[t.category] || t.category))}</ul></section>
        <section class="card svc-panel"><h3>Breakdowns by area</h3><ul class="bars">${bars(count(breakdowns, (t) => (t.leads?.location || "—").replace(/\s*\d{6}$/, "")))}</ul></section>
        <section class="card svc-panel">
          <h3>Pre-monsoon checkups</h3>
          ${camp ? `<p class="m-meta"><b>${esc(camp.name)}</b> · ${esc(fmtDay(camp.start_date))} – ${esc(fmtDay(camp.end_date))}</p>
            <div class="progress"><i style="width:${campTickets.length ? (campDone / campTickets.length) * 100 : 0}%"></i></div>
            <p class="m-meta">${campDone} of ${campTickets.length} done · ${campTickets.filter((t) => t.status === "open").length} not yet scheduled</p>
            <button type="button" class="link-btn" data-kind="checkup">Show checkups</button>`
          : `<p class="m-meta">No campaign yet. Before the rains, book a free checkup for every installed customer in one click.</p>`}
        </section>
      </div>`;
  }

  function renderList() {
    const q = search.toLowerCase();
    let rows = tickets.filter((t) => (kind === "all" || t.kind === kind)
      && (!q || [t.ticket_number, t.leads?.name, t.leads?.client_code, t.leads?.phone, t.leads?.location].some((v) => (v || "").toLowerCase().includes(q))));
    const tabs = [
      ["active", "Open", (t) => ACTIVE.includes(t.status)],
      ["overdue", "Overdue", isOverdue],
      ["unscheduled", "Not scheduled", (t) => t.status === "open"],
      ["resolved", "Resolved", (t) => t.status === "resolved"],
      ["closed", "Closed", (t) => ["closed", "cancelled"].includes(t.status)],
      ["all", "All", () => true],
    ];
    $("svcTabs").innerHTML = tabs.map(([k, label, fn]) =>
      `<button data-tab="${k}" class="${filter === k ? "is-active" : ""}">${label} <em class="${k === "overdue" && rows.some(isOverdue) ? "alert" : ""}">${rows.filter(fn).length}</em></button>`).join("");
    rows = rows.filter(tabs.find(([k]) => k === filter)[2]);
    // Most urgent first: overdue, then by deadline
    rows.sort((a, b) => (isOverdue(b) - isOverdue(a)) || String(a.sla_due_at || "9").localeCompare(String(b.sla_due_at || "9")));
    $("svcEmpty").hidden = rows.length > 0;
    $("svcEmpty").textContent = "No tickets here.";
    $("svcRows").innerHTML = rows.map((t) => `<tr data-id="${t.id}">
        <td><span class="name">${esc(t.ticket_number)}</span><span class="sub">${esc(CATEGORY[t.category] || t.category)}</span></td>
        <td>${esc(t.leads?.name || "—")}${t.leads?.client_code ? `<span class="code">${esc(t.leads.client_code)}</span>` : ""}<span class="sub">${esc(t.leads?.location || "")}</span></td>
        <td>${badge(PRIORITY, t.priority)}<span class="sub${isOverdue(t) ? " overdue" : ""}">${esc(slaText(t))}</span></td>
        <td>${badge(STATUS, t.status)}<span class="sub">${t.visit_date ? `${esc(fmtDay(t.visit_date))} · ${esc(t.crews?.name || "")}` : ""}</span></td>
        <td>${badge(WARRANTY, t.warranty_status)}</td>
        <td class="right"><span class="when">${esc(relTime(t.created_at))}</span><span class="sub">${esc(t.source)}</span></td>
      </tr>`).join("");
  }

  $("svcTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    filter = b.dataset.tab;
    renderList();
  });
  $("svcKind").addEventListener("change", (e) => { kind = e.target.value; renderList(); });
  $("svcSearch").addEventListener("input", (e) => { search = e.target.value.trim(); renderList(); });

  // Find a customer and their units by serial number, phone, client ID or name, with each unit's warranty
  let findTimer = null;
  $("svcFind").addEventListener("input", (e) => {
    clearTimeout(findTimer);
    const q = e.target.value.trim();
    if (q.length < 3) return ($("svcFound").innerHTML = "");
    findTimer = setTimeout(async () => {
      const { data, error } = await sb.rpc("search_serials", { p_query: q });
      if (error) return ($("svcFound").innerHTML = `<p class="muted">${esc(error.message)}</p>`);
      $("svcFound").innerHTML = data.length ? `<div class="table-wrap"><table class="dtable found">
        <thead><tr><th>Unit</th><th>Serial no</th><th>Customer</th><th>Warranty</th><th></th></tr></thead>
        <tbody>${data.map((u) => `<tr>
          <td>${esc(u.product)}</td><td><b>${esc(u.serial_no)}</b></td>
          <td>${esc(u.client_name)} <span class="code">${esc(u.client_code || "")}</span><span class="sub">${esc(u.phone)} · ${esc(u.location || "")} · ${esc(u.order_number)}</span></td>
          <td>${u.warranty_end ? `<span class="badge ${u.in_warranty ? "w-ok" : "w-bad"}">${u.in_warranty ? "✓ In warranty" : "✕ Expired"}</span><span class="sub">${u.in_warranty ? "until" : "ended"} ${esc(fmtDay(u.warranty_end))}</span>` : `<span class="badge">Not delivered yet</span>`}</td>
          <td class="right"><button type="button" class="btn btn--primary btn--sm" data-new-for='${esc(JSON.stringify({ id: u.lead_id, name: u.client_name, client_code: u.client_code, location: u.location, phone: u.phone, serial: u.serial_id, unitCategory: u.category }))}'>New ticket</button>
            ${u.open_tickets ? `<span class="sub overdue">${u.open_tickets} open ticket${u.open_tickets > 1 ? "s" : ""}</span>` : ""}</td>
        </tr>`).join("")}</tbody></table></div>` : `<p class="muted">No unit or customer matches “${esc(q)}”.</p>`;
    }, 250);
  });
  $("svcFound").addEventListener("click", (e) => {
    const b = e.target.closest("[data-new-for]");
    if (!b) return;
    const u = JSON.parse(b.dataset.newFor);
    openNew(u, u.serial);
  });
  $("svcDash").addEventListener("click", (e) => {
    const f = e.target.closest("[data-f]");
    if (f) { filter = f.dataset.f; renderList(); }
    const k = e.target.closest("[data-kind]");
    if (k) { kind = k.dataset.kind; $("svcKind").value = kind; filter = "all"; renderList(); }
  });
  $("svcRows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openTicket(tr.dataset.id);
  });
  $("svcRefresh").addEventListener("click", async () => { await load(); toast("Service refreshed"); });

  registerView("service", async () => {
    if (state.viewFilter?.service) {
      filter = state.viewFilter.service;
      state.viewFilter = null;
    }
    await load();
  });

  // ---------- One ticket ----------
  async function openTicket(id) {
    const { data: t, error } = await sb.from("service_tickets").select("*, leads(name, client_code, location, phone), crews(name)").eq("id", id).single();
    if (error) return toast("Couldn't open the ticket: " + error.message);
    if (!crews.length) crews = (await sb.from("crews").select("*").order("name")).data || [];
    current = t;
    renderTicket();
    $("ticketModal").hidden = false;
    loadTicketPhotos();
  }

  function renderTicket() {
    const t = current;
    const l = t.leads || {};
    const locked = !ACTIVE.includes(t.status);
    $("tkTitle").innerHTML = `${esc(t.ticket_number)} ${badge(STATUS, t.status)} ${badge(PRIORITY, t.priority)}`;
    $("tkMeta").textContent = [l.name, l.client_code, l.phone, l.location].filter(Boolean).join(" · ");
    $("tkBody").innerHTML = `
      ${isOverdue(t) ? `<p class="quote-warn">Overdue: the response deadline was ${esc(fmtDateTime(t.sla_due_at))}.</p>` : ""}
      <div class="manage">
        <label><span>Problem</span><select name="category" ${locked || t.kind === "checkup" ? "disabled" : ""}>${Object.entries(CATEGORY).filter(([k]) => k !== "checkup" || t.kind === "checkup")
          .map(([k, v]) => `<option value="${k}"${k === t.category ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
        <label><span>Priority</span><select name="priority" ${locked ? "disabled" : ""}>${Object.entries(PRIORITY).map(([k, [v]]) => `<option value="${k}"${k === t.priority ? " selected" : ""}>${v}</option>`).join("")}</select></label>
      </div>
      <p class="m-meta">Deadline ${esc(t.sla_due_at ? fmtDateTime(t.sla_due_at) : "—")} · <b class="${isOverdue(t) ? "overdue" : ""}">${esc(slaText(t))}</b> · opened ${esc(fmtDateTime(t.created_at))} by ${esc(t.created_by || "")} (${esc(t.source)})</p>
      ${t.description ? `<p class="m-text">${esc(t.description)}</p>` : ""}
      <p class="m-meta">${badge(WARRANTY, t.warranty_status)} ${esc(t.warranty_note || "")}</p>
      <label class="check"><input type="checkbox" name="chargeable" ${t.chargeable ? "checked" : ""} ${locked ? "disabled" : ""}> Chargeable visit (out of warranty / not covered)</label>

      <label class="tk-unit" hidden><span>Unit with the problem (its own warranty decides free or chargeable)</span><select name="serial_id" ${locked ? "disabled" : ""}></select></label>

      <h3 class="form-section">Visit</h3>
      <div class="modal__grid modal__grid--3">
        <label><span>Crew</span><select name="crew_id" ${locked ? "disabled" : ""}><option value="">Not assigned</option>${crews.filter((c) => c.active || c.id === t.crew_id)
          .map((c) => `<option value="${c.id}"${c.id === t.crew_id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
        <label><span>Date</span><input type="date" name="visit_date" value="${esc(t.visit_date || "")}" ${locked ? "disabled" : ""}></label>
        <label><span>Slot</span><select name="visit_slot" ${locked ? "disabled" : ""}><option value="">—</option>${SLOTS.map((s) => `<option${s === t.visit_slot ? " selected" : ""}>${s}</option>`).join("")}</select></label>
      </div>
      <p class="quote-warn" id="tkWarn" hidden></p>
      ${locked ? "" : `<div class="m-actions"><button type="button" class="btn btn--primary btn--sm" data-tk="save">Save</button>
        <span class="muted">Booking a crew and date sends the customer a WhatsApp.</span></div>`}

      <h3 class="form-section">Photos</h3>
      <div class="photos" id="tkPhotos"><p class="muted">No photos.</p></div>

      ${t.resolved_at || t.cause || t.work_done ? `<h3 class="form-section">Resolution</h3>
        <div class="portal-fix">
          ${t.cause ? `<div><b>Found:</b> ${esc(t.cause)}</div>` : ""}
          ${t.work_done ? `<div><b>Work done:</b> ${esc(t.work_done)}</div>` : ""}
          ${t.parts?.length ? `<div><b>Parts:</b> ${t.parts.map((p) => `${esc(p.description)} × ${esc(p.qty)}`).join(", ")}</div>` : ""}
          ${t.generation_kwh !== null ? `<div><b>Generation after:</b> ${esc(t.generation_kwh)} kWh</div>` : ""}
          ${t.resolved_at ? `<div><b>Resolved:</b> ${esc(fmtDateTime(t.resolved_at))}${t.resolved_by ? ` by ${esc(staffName(t.resolved_by))}` : ""} · ${t.sla_met ? "within deadline" : t.sla_met === false ? "<span class=\"overdue\">after the deadline</span>" : ""}</div>` : ""}
          ${t.signed_by_name ? `<div><b>Signed by:</b> ${esc(t.signed_by_name)}</div>` : ""}
          <div><b>Charges:</b> ${Number(t.charge_amount) > 0 ? `₹${esc(Number(t.charge_amount).toLocaleString("en-IN"))} + GST` : "free"}</div>
          ${t.customer_rating ? `<div><b>Customer rating:</b> <span class="stars-static">${"★".repeat(t.customer_rating)}${"☆".repeat(5 - t.customer_rating)}</span>${t.customer_feedback ? ` “${esc(t.customer_feedback)}”` : ""}</div>` : ""}
        </div>` : ""}

      <div id="tkInvoice"></div>

      ${locked ? "" : `<details class="tk-office-fix"><summary>Resolve without a visit (fixed over the phone)</summary>
        <div class="manage">
          <label class="span-2"><span>What was wrong</span><input name="cause"></label>
          <label class="span-2"><span>What was done</span><input name="work_done" placeholder="e.g. Customer reset the inverter on our call; generating again"></label>
        </div>
        <button type="button" class="btn btn--ghost btn--sm" data-tk="resolve">Mark resolved</button>
      </details>`}

      <div class="m-actions">
        <button type="button" class="btn btn--ghost btn--sm" data-tk="lead">Open lead</button>
        ${t.status === "resolved" ? `<button type="button" class="btn btn--ghost btn--sm" data-tk="close"
          title="Only when the customer has told you everything works">Customer confirmed it works</button>` : ""}
        ${ACTIVE.includes(t.status) && t.status !== "in_progress" ? `<button type="button" class="danger-link" data-tk="cancel">Cancel ticket</button>` : ""}
      </div>`;
    if (!locked) checkVisit();
    loadUnits({ id: t.lead_id, client_code: l.client_code, phone: l.phone }, $("tkBody").querySelector('[name="serial_id"]'), t.serial_id);
    // Out-of-warranty repairs get a tax invoice automatically when resolved (finance.sql)
    if (t.chargeable && ["resolved", "closed"].includes(t.status)) {
      window.Invoices?.section($("tkInvoice"), { ticketId: t.id, leadId: t.lead_id, canIssue: false, onChange: afterChange });
    }
  }

  async function loadTicketPhotos() {
    const t = current;
    const paths = [...(t.photos || []), ...(t.signature_path ? [t.signature_path] : [])];
    if (!paths.length) return;
    const { data } = await sb.storage.from("service-photos").createSignedUrls(paths, 3600);
    const label = (p) => (p === t.signature_path ? "Customer signature" : { customer: "From customer", before: "Before", after: "After", other: "Other" }[(p.split("/")[1] || "").split("-")[0]] || "Photo");
    $("tkPhotos").innerHTML = (data || []).map((p) => `<figure${p.path === t.signature_path ? ` class="sig"` : ""}>
        <a href="${esc(p.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(p.signedUrl)}" alt="${esc(label(p.path))}" loading="lazy"></a>
        <figcaption>${esc(label(p.path))}</figcaption></figure>`).join("");
  }

  // Warn (don't block) when the crew is already full that day
  async function checkVisit() {
    const f = $("tkBody");
    const crew = f.querySelector('[name="crew_id"]').value;
    const date = f.querySelector('[name="visit_date"]').value;
    const msgs = [];
    if (date && new Date(date + "T00:00:00Z").getUTCDay() === 0) msgs.push("That's a Sunday.");
    if (date && date < todayISO()) msgs.push("That date is in the past.");
    if (crew && date) {
      const { data: load } = await sb.rpc("crew_day_load", { p_crew_id: crew, p_date: date, p_exclude_job: current.id });
      const units = current.kind === "checkup" ? 0.5 : 1;
      if (Number(load || 0) + units > 2) msgs.push(`${crews.find((c) => c.id === crew)?.name || "This crew"} is already full on ${fmtDay(date)}.`);
    }
    $("tkWarn").hidden = !msgs.length;
    $("tkWarn").textContent = msgs.join(" ");
  }
  $("tkBody").addEventListener("change", (e) => {
    if (e.target.matches('[name="crew_id"], [name="visit_date"]')) checkVisit();
  });

  $("tkBody").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-tk]");
    if (!b || !current) return;
    const f = $("tkBody");
    const val = (n) => f.querySelector(`[name="${n}"]`)?.value;
    const act = b.dataset.tk;
    if (act === "lead") {
      $("ticketModal").hidden = true;
      return openDrawer(current.lead_id);
    }
    let patch = null;
    if (act === "save") {
      patch = {
        category: current.kind === "checkup" ? "checkup" : val("category"), priority: val("priority"),
        chargeable: f.querySelector('[name="chargeable"]').checked,
        // keep the unit already on the ticket if the list hasn't loaded yet
        serial_id: f.querySelector('[name="serial_id"]').options.length ? val("serial_id") || null : current.serial_id,
        crew_id: val("crew_id") || null, visit_date: val("visit_date") || null, visit_slot: val("visit_slot") || null,
      };
      if ((patch.crew_id || patch.visit_date) && !(patch.crew_id && patch.visit_date && patch.visit_slot)) return toast("Choose the crew, date and slot together.");
      if (!patch.crew_id && current.status === "scheduled") patch.status = "open";
    }
    if (act === "resolve") {
      if (!val("cause")?.trim() || !val("work_done")?.trim()) return toast("Write what was wrong and what was done.");
      patch = { status: "resolved", cause: val("cause").trim(), work_done: val("work_done").trim(), resolved_by: state.me.email, charge_amount: 0 };
    }
    if (act === "close") {
      if (!confirm("Did the customer confirm (on the phone) that everything works now? This closes the ticket.")) return;
      patch = { status: "closed", customer_confirmed_at: new Date().toISOString(), confirmed_via: "phone" };
    }
    if (act === "cancel") {
      const why = prompt(`Cancel ${current.ticket_number}? Reason:`);
      if (why === null) return;
      if (!why.trim()) return toast("Give a reason.");
      patch = { status: "cancelled", work_done: `Cancelled: ${why.trim()}` };
    }
    if (!patch) return;
    b.disabled = true;
    const { error } = await sb.from("service_tickets").update(patch).eq("id", current.id);
    b.disabled = false;
    if (error) return toast("Couldn't save: " + error.message);
    toast({ save: "Saved", resolve: "Marked resolved", close: "Ticket closed", cancel: "Ticket cancelled" }[act]);
    await openTicket(current.id);
    afterChange();
  });

  document.querySelectorAll("[data-close-ticket]").forEach((el) => el.addEventListener("click", () => ($("ticketModal").hidden = true)));

  function afterChange() {
    if (viewOpen("service")) load();
    if (viewOpen("schedule")) window.Schedule?.reload?.();
    if (state.current) renderLead(state.current);
    loadTiles();
  }

  // ---------- New ticket ----------
  let picked = null;

  // The customer's serial-numbered units with their warranty (extras.sql); pick the one with the problem
  async function loadUnits(lead, selectEl, selected) {
    const { data, error } = await sb.rpc("search_serials", { p_query: lead.client_code || lead.phone || "" });
    const units = error ? [] : (data || []).filter((u) => u.lead_id === lead.id);
    selectEl.innerHTML = `<option value="">Not a specific unit</option>` + units.map((u) =>
      `<option value="${u.serial_id}"${u.serial_id === selected ? " selected" : ""}>${esc(u.product)} · S/N ${esc(u.serial_no)} · ${u.warranty_end ? `${u.in_warranty ? "warranty until" : "warranty ended"} ${esc(fmtDay(u.warranty_end))}` : "warranty not started"}</option>`).join("");
    selectEl.closest("label").hidden = !units.length;
    return units;
  }

  async function openNew(lead, serialId) {
    picked = lead || null;
    const f = $("newTicketForm");
    f.reset();
    // No default problem: a wrong default (e.g. sparks = urgent) would mislead the crew
    f.category.innerHTML = `<option value="">Choose the problem…</option>` +
      Object.entries(CATEGORY).filter(([k]) => k !== "checkup").map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
    if (lead?.unitCategory === "inverter") f.category.value = "inverter_error";
    $("ntCustomer").innerHTML = picked ? `<b>${esc(picked.name)}</b> ${esc(picked.client_code || "")} · ${esc(picked.location || "")}` : "";
    $("ntPick").hidden = Boolean(picked);
    $("ntResults").innerHTML = "";
    $("ntError").textContent = "";
    f.serial_id.closest("label").hidden = true;
    $("newTicketModal").hidden = false;
    if (picked) loadUnits(picked, f.serial_id, serialId);
    else f.q.focus();
  }

  $("ntQuery").addEventListener("input", async (e) => {
    const q = e.target.value.trim();
    if (q.length < 2) return ($("ntResults").innerHTML = "");
    const like = `%${q.replace(/[%_,()]/g, "")}%`;
    const { data } = await sb.from("leads").select("id, name, client_code, location, phone, status")
      .or(`name.ilike.${like},client_code.ilike.${like},phone.ilike.${like}`).order("created_at", { ascending: false }).limit(8);
    $("ntResults").innerHTML = (data || []).map((l) => `<li><button type="button" data-pick='${esc(JSON.stringify(l))}'>
      <b>${esc(l.name)}</b> ${esc(l.client_code || "")}<small>${esc([l.phone, l.location].filter(Boolean).join(" · "))}</small></button></li>`).join("")
      || `<li class="m-empty">No customer found.</li>`;
  });
  $("ntResults").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if (!b) return;
    picked = JSON.parse(b.dataset.pick);
    $("ntCustomer").innerHTML = `<b>${esc(picked.name)}</b> ${esc(picked.client_code || "")} · ${esc(picked.location || "")}`;
    $("ntPick").hidden = true;
    loadUnits(picked, $("newTicketForm").serial_id);
  });

  $("newTicketForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!picked) return ($("ntError").textContent = "Choose the customer first.");
    if (!f.category.value) return ($("ntError").textContent = "Choose what the problem is.");
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    const { data, error } = await sb.from("service_tickets").insert({
      lead_id: picked.id, category: f.category.value, priority: f.priority.value || null, serial_id: f.serial_id.value || null,
      description: f.description.value.trim() || null, source: "crm", created_by: state.me.email,
    }).select("id, ticket_number").single();
    btn.disabled = false;
    if (error) return ($("ntError").textContent = error.message);
    $("newTicketModal").hidden = true;
    toast(`${data.ticket_number} opened. The customer gets a WhatsApp.`);
    afterChange();
    openTicket(data.id);
  });
  document.querySelectorAll("[data-close-new-ticket]").forEach((el) => el.addEventListener("click", () => ($("newTicketModal").hidden = true)));
  $("svcNewBtn").addEventListener("click", () => openNew(null));

  // ---------- Pre-monsoon campaign ----------
  $("svcCampaignBtn").addEventListener("click", async () => {
    const f = $("campaignForm");
    f.reset();
    const year = new Date().getFullYear();
    f.name.value = `Pre-monsoon checkup ${year}`;
    f.start_date.value = window.CRM.addDays(todayISO(), 1);
    f.end_date.value = window.CRM.addDays(todayISO(), 21);
    $("campError").textContent = "";
    $("campPreview").textContent = "Counting installed customers…";
    $("campaignModal").hidden = false;
    const [{ data: orders }, { data: open }] = await Promise.all([
      sb.from("orders").select("id").in("status", ["installed", "completed"]),
      sb.from("service_tickets").select("order_id").eq("kind", "checkup").in("status", ACTIVE),
    ]);
    const busy = new Set((open || []).map((t) => t.order_id));
    const n = (orders || []).filter((o) => !busy.has(o.id)).length;
    $("campPreview").textContent = `${n} installed customer${n === 1 ? "" : "s"} will get a free checkup (customers with a checkup already booked are skipped). Up to 4 checkups per crew per day, around installations.`;
  });

  $("campaignForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!confirm("Create the checkups and WhatsApp every customer their date?")) return;
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    const { data, error } = await sb.rpc("create_checkup_campaign", { p_name: f.name.value.trim(), p_start: f.start_date.value, p_end: f.end_date.value });
    btn.disabled = false;
    if (error) return ($("campError").textContent = error.message);
    $("campaignModal").hidden = true;
    toast(`${data.tickets} checkups created: ${data.scheduled} booked${data.unscheduled ? `, ${data.unscheduled} need a date (no room left)` : ""}.`);
    kind = "checkup";
    $("svcKind").value = "checkup";
    filter = data.unscheduled ? "unscheduled" : "active";
    afterChange();
  });
  document.querySelectorAll("[data-close-campaign]").forEach((el) => el.addEventListener("click", () => ($("campaignModal").hidden = true)));

  // ---------- Lead page: service requests + portal link ----------
  async function renderLead(l) {
    const { data, error } = await sb.from("service_tickets").select("*").eq("lead_id", l.id).order("created_at", { ascending: false });
    $("leadServiceBlock").hidden = Boolean(error);
    if (error) return;
    $("leadTickets").innerHTML = data.length
      ? data.map((t) => `<li data-ticket="${t.id}">
          <div class="m-head"><span class="m-title">${esc(t.ticket_number)} · ${esc(CATEGORY[t.category] || t.category)}</span>${badge(STATUS, t.status)}</div>
          <div class="m-meta">${badge(PRIORITY, t.priority)} ${esc(slaText(t))}${t.visit_date ? ` · visit ${esc(fmtDay(t.visit_date))}` : ""}</div>
          <div class="m-actions"><button type="button" class="btn btn--ghost btn--sm" data-open-ticket>Open</button></div>
        </li>`).join("")
      : `<li class="m-empty">No service requests.</li>`;
  }
  $("leadTickets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-open-ticket]");
    if (b) openTicket(b.closest("li").dataset.ticket);
  });
  $("leadNewTicket").addEventListener("click", () => state.current && openNew(state.current));

  // A private portal link: the customer opens it to see their system and report problems
  $("dPortal").addEventListener("click", async () => {
    const l = state.current;
    if (!l) return;
    if (!confirm(`Create a customer portal link for ${l.name}? Any earlier link stops working.`)) return;
    const { data: token, error } = await sb.rpc("issue_portal_token", { p_lead_id: l.id });
    if (error) return toast("Couldn't create the link: " + error.message);
    const link = new URL(`../portal/?t=${token}`, location.href).href;
    const message = [
      `Hello ${(l.name || "").split(/\s+/)[0]}, this is Sun Power Solar Solutions.`,
      "Here is your private link to see your solar system, warranty and payments, and to report any problem:",
      link,
      "Please keep this link to yourself.",
    ].join("\n");
    $("portalLink").value = link;
    $("portalWa").href = `https://wa.me/${String(l.phone).replace(/\D/g, "")}?text=${encodeURIComponent(message)}`;
    $("portalModal").hidden = false;
    window.CRM.loadActivity(l.id);
  });
  $("portalCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("portalLink").value);
      toast("Link copied");
    } catch {
      $("portalLink").select();
    }
  });
  document.querySelectorAll("[data-close-portal]").forEach((el) => el.addEventListener("click", () => ($("portalModal").hidden = true)));

  // Localhost users login: made automatically when the order is completed (passport.sql); staff can send a new password
  async function openPassport(fresh) {
    const l = state.current;
    if (!l) return;
    const [{ data: acc, error }, { data: done }] = await Promise.all([
      sb.from("customer_accounts").select("phone, must_change, password_set_at, password_set_by, last_login_at, locked_until").eq("lead_id", l.id).maybeSingle(),
      sb.from("orders").select("order_number").eq("lead_id", l.id).eq("status", "completed").limit(1),
    ]);
    if (error) return toast("Run passport.sql first: " + error.message);
    const locked = acc?.locked_until && new Date(acc.locked_until) > new Date();
    $("passportBody").innerHTML = `
      ${fresh ? `<div class="pp-new">
          <p>New password for <b>${esc(fresh.username)}</b></p>
          <p class="pp-pass"><code>${esc(fresh.password)}</code></p>
          <p class="muted">WhatsApp: ${esc(fresh.whatsapp)}. This is the only time it's shown: read it out if the customer asks. They choose their own password when they sign in.</p>
        </div>` : ""}
      <p class="muted">The customer signs in with their phone number and password to see their warranty cards, serial numbers, installation record, invoices, subsidy progress and service requests.</p>
      ${acc ? `<dl class="pp-facts">
          <div><dt>Username</dt><dd>${esc(String(acc.phone).replace(/^\+91/, ""))}</dd></div>
          <div><dt>Status</dt><dd>${locked ? `<span class="overdue">Locked after wrong passwords until ${esc(fmtDateTime(acc.locked_until))}</span>` : acc.must_change ? "Waiting for the first sign-in" : "Using their own password"}</dd></div>
          <div><dt>Last sign-in</dt><dd>${acc.last_login_at ? esc(fmtDateTime(acc.last_login_at)) : "Never"}</dd></div>
          <div><dt>Password set</dt><dd>${esc(fmtDateTime(acc.password_set_at))}${acc.password_set_by ? ` · ${esc(acc.password_set_by === "customer" ? "by the customer" : acc.password_set_by)}` : ""}</dd></div>
        </dl>`
      : done?.length ? `<p>No login yet.</p>` : `<p class="quote-warn">The Localhost users opens once this customer's order is completed (fully paid).</p>`}
      ${done?.length ? `<div class="m-actions"><button type="button" class="btn btn--primary btn--sm" id="passportNew">${acc ? "Send a new password" : "Create the login and send it"}</button>
        <span class="muted">Sent to ${esc(l.phone)} on WhatsApp.</span></div>` : ""}
      <p class="login__error" id="passportError" role="alert"></p>`;
    $("passportModal").hidden = false;
  }
  $("dPassport").addEventListener("click", () => openPassport());
  $("passportBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("#passportNew");
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = "Sending…";
    const { data, error } = await sb.functions.invoke("send-whatsapp", { body: { kind: "passport_reset", lead_id: state.current.id } });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch {}
      $("passportError").textContent = msg;
      btn.disabled = false;
      btn.textContent = "Try again";
      return;
    }
    await openPassport(data);
    window.CRM.loadActivity(state.current.id);
  });
  document.querySelectorAll("[data-close-passport]").forEach((el) => el.addEventListener("click", () => {
    $("passportModal").hidden = true;
    $("passportBody").innerHTML = ""; // don't leave a password on screen
  }));

  // New tickets from the portal appear without a reload
  setInterval(() => {
    if (viewOpen("service") && $("ticketModal").hidden && $("newTicketModal").hidden && $("campaignModal").hidden) load();
  }, 30000);

  window.Service = { openTicket, renderLead, isOverdue, CATEGORY };
})();
