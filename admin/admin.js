(() => {
  // Public (anon) key: safe in the browser. Data access is enforced by row-level security.
  const SUPABASE_URL = "https://iekfgtyfwmplsauutegs.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlla2ZndHlmd21wbHNhdXV0ZWdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0MjQ4MjQsImV4cCI6MjEwOTAwMDgyNH0.jNPdk0LeP4bHdyRoRHq-xjYr8EIXvlx3M13X9GugnIY";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const STATUSES = [
    ["new", "New"],
    ["ai_called", "AI called"],
    ["interested", "Interested"],
    ["survey_booked", "Survey booked"],
    ["survey_done", "Survey done"],
    ["survey_approved", "Survey approved"],
    ["quote_sent", "Quote sent"],
    ["won", "Won"],
    ["lost", "Lost"],
  ];
  const STATUS_LABEL = Object.fromEntries(STATUSES);

  const state = {
    me: null,
    staff: [],
    leads: [],
    status: "all",
    search: "",
    days: "all",
    current: null,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tz = { timeZone: "Asia/Kolkata" };
  const fmtDateTime = (iso) => new Date(iso).toLocaleString("en-IN", { ...tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const todayISO = () => new Date().toLocaleDateString("en-CA", tz); // YYYY-MM-DD in IST
  const fmtDuration = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);

  // AI call state shown in the table
  const AI_STATES = {
    queuing: ["wait", "Placing call"],
    scheduled: ["wait", "Scheduled"],
    queued: ["wait", "Queued"],
    initiated: ["live", "Dialling"],
    ringing: ["live", "Ringing"],
    "in-progress": ["live", "On call"],
    "call-disconnected": ["live", "Wrapping up"],
    completed: ["done", "Completed"],
    "no-answer": ["fail", "No answer"],
    busy: ["fail", "Busy"],
    failed: ["fail", "Failed"],
    canceled: ["fail", "Canceled"],
    stopped: ["fail", "Stopped"],
    error: ["fail", "Error"],
    "balance-low": ["fail", "Bolna balance low"],
  };
  function aiBadge(l) {
    if (!l.ai_call_status) return `<span class="ai ai--none">—</span>`;
    const [kind, label] = AI_STATES[l.ai_call_status] || ["wait", l.ai_call_status];
    const when = l.ai_call_status === "scheduled" && l.ai_call_scheduled_at
      ? `<span class="sub">${esc(fmtDateTime(l.ai_call_scheduled_at))}</span>` : "";
    return `<span class="ai ai--${kind}">${esc(label)}</span>${when}`;
  }

  const statusOptions = (selected) =>
    STATUSES.map(([v, l]) => `<option value="${v}"${v === selected ? " selected" : ""}>${l}</option>`).join("");

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 2600);
  }

  // ---------- Auth ----------
  function showLogin(message = "") {
    $("appView").hidden = true;
    $("engineerView").hidden = true;
    $("techView").hidden = true;
    $("loginView").hidden = false;
    $("loginError").textContent = message;
  }

  async function enterApp(session) {
    const { data: staff, error } = await sb.from("staff").select("email, name, role").order("name");
    const email = session.user.email.toLowerCase();
    if (error || !staff.some((s) => s.email.toLowerCase() === email)) {
      await sb.auth.signOut();
      showLogin("This account isn't on the staff list. Ask the owner to add your email.");
      return;
    }
    state.me = session.user;
    state.staff = staff;
    state.role = staff.find((s) => s.email.toLowerCase() === email)?.role || "staff";
    state.isManager = ["owner", "manager"].includes(state.role);
    if (state.role === "engineer") {
      $("loginView").hidden = true;
      $("appView").hidden = true;
      $("engineerView").hidden = false;
      $("engUser").textContent = session.user.email;
      await window.Surveys.engineerHome();
      return;
    }
    if (state.role === "technician") {
      $("loginView").hidden = true;
      $("appView").hidden = true;
      $("techView").hidden = false;
      $("techUser").textContent = session.user.email;
      await window.Schedule.technicianHome();
      return;
    }
    $("userEmail").textContent = session.user.email;
    $("dAssigned").innerHTML =
      `<option value="">Unassigned</option>` +
      staff.map((s) => `<option value="${esc(s.email)}">${esc(s.name || s.email)}</option>`).join("");
    $("dStatus").innerHTML = statusOptions("new");

    // The warehouse only gets the Warehouse screen; office roles get everything
    const allowed = VIEWS_BY_ROLE[state.role] || VIEWS_BY_ROLE.office;
    document.querySelectorAll(".topnav [data-view]").forEach((b) => (b.hidden = !allowed.includes(b.dataset.view)));
    document.querySelector('.topnav [data-view="director"]').hidden = !state.isManager; // owner and managers only
    document.querySelector('.topnav [data-view="team"]').hidden = !state.isManager; // pay is for the owner and managers
    $("surveysBtn").hidden = $("settingsBtn").hidden = state.role === "warehouse";
    $("loginView").hidden = true;
    $("appView").hidden = false;
    await showView(allowed[0]);
    if (state.role !== "warehouse") window.Surveys?.refreshCount();
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    $("loginError").textContent = "";
    const { data, error } = await sb.auth.signInWithPassword({
      email: e.target.email.value.trim(),
      password: e.target.password.value,
    });
    btn.disabled = false;
    if (error) return ($("loginError").textContent = error.message);
    await enterApp(data.session);
  });

  $("engLogout").addEventListener("click", async () => {
    await sb.auth.signOut();
    state.me = null;
    showLogin();
  });
  $("engRefresh").addEventListener("click", () => window.Surveys.engineerHome());
  $("techLogout").addEventListener("click", async () => {
    await sb.auth.signOut();
    state.me = null;
    showLogin();
  });

  $("logoutBtn").addEventListener("click", async () => {
    await sb.auth.signOut();
    state.leads = [];
    showLogin();
  });

  // ---------- Screens (top nav) ----------
  // Surveys and Quote settings open as panels over whichever screen is showing
  const VIEWS_BY_ROLE = {
    office: ["leads", "orders", "warehouse", "schedule", "service", "subsidy", "director", "team", "products", "kits"],
    warehouse: ["warehouse"],
  };
  const views = {}; // name → load function, registered by orders.js, warehouse.js, schedule.js, products.js

  async function showView(name) {
    state.view = name;
    document.querySelectorAll(".topnav [data-view]").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.view === name);
      if (b.dataset.view === name) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    document.querySelectorAll("#appView .view").forEach((v) => (v.hidden = v.dataset.view !== name));
    window.scrollTo(0, 0);
    if (name === "leads") await loadLeads();
    else await views[name]?.();
  }
  document.querySelector(".topnav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) showView(b.dataset.view);
  });
  const viewOpen = (name) => !$("appView").hidden && state.view === name;

  // ---------- Data ----------
  async function loadLeads() {
    const { data, error } = await sb.from("leads").select("*").order("created_at", { ascending: false }).limit(5000);
    if (error) return toast("Couldn't load leads: " + error.message);
    state.leads = data;
    await Promise.all([loadUpcoming(), loadTiles()]);
    render();
  }

  // Week helpers (Mon–Sun, IST dates as YYYY-MM-DD)
  const addDays = (iso, n) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const mondayOf = (iso) => {
    const dow = new Date(iso + "T00:00:00Z").getUTCDay();
    return addDays(iso, dow === 0 ? -6 : 1 - dow);
  };
  const isLowStock = (p) => Number(p.stock_qty) - Number(p.reserved_qty) <= Number(p.low_stock_level);

  // Tiles on the Leads screen, and the red badges on Warehouse / Products
  async function loadTiles() {
    const monday = mondayOf(todayISO());
    const [awaiting, toPack, installs, products, tickets] = await Promise.all([
      sb.from("orders").select("id", { count: "exact", head: true }).eq("status", "awaiting_payment"),
      sb.from("orders").select("id, stock_short").in("status", ["confirmed", "packing"]),
      sb.from("install_jobs").select("id", { count: "exact", head: true })
        .gte("scheduled_date", monday).lte("scheduled_date", addDays(monday, 6)).neq("status", "cancelled"),
      sb.from("products").select("stock_qty, reserved_qty, low_stock_level").eq("active", true).eq("is_service", false),
      sb.from("service_tickets").select("id", { count: "exact", head: true })
        .in("status", ["open", "scheduled", "in_progress"]).lt("sla_due_at", new Date().toISOString()),
    ]);
    if (awaiting.error) return ($("tiles").hidden = true); // orders.sql not run yet
    const low = (products.data || []).filter(isLowStock).length;
    const short = (toPack.data || []).some((o) => o.stock_short);
    $("tiles").hidden = false;
    $("tAwaiting").textContent = awaiting.count || 0;
    $("tPack").textContent = toPack.data?.length || 0;
    $("tInstalls").textContent = installs.count || 0;
    $("tLow").textContent = low;
    $("tLow").closest(".tile").classList.toggle("is-alert", low > 0);
    $("tPack").closest(".tile").classList.toggle("is-alert", short);
    setNavCount("products", low);
    setNavCount("warehouse", toPack.data?.length || 0, short);
    // Service tickets past their response deadline (service.sql)
    $("tOverdue").closest(".tile").hidden = Boolean(tickets.error);
    $("tOverdue").textContent = tickets.count || 0;
    $("tOverdue").closest(".tile").classList.toggle("is-alert", tickets.count > 0);
    setNavCount("service", tickets.count || 0);
  }

  function setNavCount(view, n, alert = true) {
    const el = document.querySelector(`.topnav [data-view="${view}"] .count`);
    if (!el) return;
    el.textContent = n;
    el.hidden = !n;
    el.classList.toggle("count--alert", Boolean(n && alert));
  }

  document.querySelector("#tiles").addEventListener("click", (e) => {
    const t = e.target.closest("button[data-go]");
    if (!t) return;
    if (t.dataset.filter) state.viewFilter = { [t.dataset.go]: t.dataset.filter };
    showView(t.dataset.go);
  });

  // Scheduled meetings from today onwards, for the dashboard
  async function loadUpcoming() {
    const { data, error } = await sb.from("meetings").select("*")
      .eq("status", "scheduled").gte("scheduled_date", todayISO())
      .order("scheduled_date").limit(50);
    state.upcoming = error ? null : data;
  }

  async function updateLead(id, patch) {
    const { data, error } = await sb.from("leads").update(patch).eq("id", id).select().single();
    if (error) {
      toast("Couldn't save: " + error.message);
      return null;
    }
    const i = state.leads.findIndex((l) => l.id === id);
    if (i > -1) state.leads[i] = data;
    if (state.current?.id === id && !$("drawer").hidden) setStageBadge(data.status);
    render();
    return data;
  }

  // ---------- Filtering ----------
  function baseFiltered() {
    const q = state.search.toLowerCase();
    const since = state.days === "all" ? null : Date.now() - Number(state.days) * 864e5;
    return state.leads.filter((l) => {
      if (since && new Date(l.created_at).getTime() < since) return false;
      if (!q) return true;
      return [l.name, l.phone, l.location, l.email, l.client_code].some((v) => (v || "").toLowerCase().includes(q));
    });
  }

  // ---------- Render ----------
  function render() {
    const all = state.leads;
    const today = todayISO();
    const weekAgo = Date.now() - 7 * 864e5;
    const won = all.filter((l) => l.status === "won").length;
    $("sTotal").textContent = all.length;
    $("sNew").textContent = all.filter((l) => l.status === "new").length;
    $("sWeek").textContent = all.filter((l) => new Date(l.created_at).getTime() >= weekAgo).length;
    renderUpcoming(today);
    $("sWon").textContent = won;
    $("sConv").textContent = all.length ? Math.round((won / all.length) * 100) + "%" : "0%";

    const base = baseFiltered();
    const counts = Object.fromEntries(STATUSES.map(([v]) => [v, 0]));
    base.forEach((l) => counts[l.status]++);
    $("pipeline").innerHTML =
      `<button data-status="all" class="${state.status === "all" ? "is-active" : ""}">All <em>${base.length}</em></button>` +
      STATUSES.map(([v, label]) =>
        `<button data-status="${v}" class="${state.status === v ? "is-active" : ""}">${label} <em>${counts[v]}</em></button>`
      ).join("");

    const rows = state.status === "all" ? base : base.filter((l) => l.status === state.status);
    $("emptyState").hidden = rows.length > 0;
    $("rows").innerHTML = rows.map((l) => {
      const sizeType = [l.system_size, l.system_type].filter(Boolean).join(" · ");
      return `<tr data-id="${l.id}">
        <td><span class="name">${esc(l.name)}</span>${l.client_code ? `<span class="code">${esc(l.client_code)}</span>` : ""}<span class="sub">${esc([l.phone, l.location].filter(Boolean).join(" · "))}</span></td>
        <td>${esc(l.monthly_bill || "—")}${sizeType ? `<span class="sub">${esc(sizeType)}</span>` : ""}</td>
        <td><span class="badge s-${esc(l.status)}">${esc(STATUS_LABEL[l.status] || l.status)}</span></td>
        <td>${aiBadge(l)}</td>
        <td>${nextStep(l, today)}</td>
        <td class="right"><span class="when">${esc(relTime(l.created_at))}</span><span class="sub">${esc(l.source)}</span></td>
      </tr>`;
    }).join("");
  }

  function relTime(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  }

  function nextStep(l, today) {
    const m = (state.upcoming || []).find((x) => x.lead_id === l.id);
    if (m) {
      const when = m.scheduled_date === today ? "Today" : fmtDay(m.scheduled_date);
      return `<span class="next">${esc(MEETING_TYPE[m.type])}</span><span class="sub">${esc(when)}${m.time_slot ? " · " + esc(m.time_slot) : ""}</span>`;
    }
    if (l.follow_up_date && !["won", "lost"].includes(l.status)) {
      const due = l.follow_up_date <= today;
      return `<span class="next${due ? " overdue" : ""}">Follow up</span><span class="sub${due ? " overdue" : ""}">${esc(fmtDay(l.follow_up_date))}${due ? " · due" : ""}</span>`;
    }
    return `<span class="sub none">—</span>`;
  }

  const MEETING_TYPE = { site_survey: "Site survey", callback: "Callback", meeting: "Meeting" };
  const MEETING_STATUS = { scheduled: "Scheduled", done: "Done", cancelled: "Cancelled", no_show: "No-show" };
  const fmtDay = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

  function renderUpcoming(today) {
    const list = state.upcoming;
    $("sMeetToday").textContent = list ? list.filter((m) => m.scheduled_date === today).length : 0;
    $("upcomingCount").textContent = list?.length ? `${list.length} scheduled` : "";
    if (!list || !list.length) {
      $("upcomingList").innerHTML = `<li class="u-empty">No meetings scheduled.</li>`;
      return;
    }
    $("upcomingList").innerHTML = list.slice(0, 10).map((m) => {
      const lead = state.leads.find((l) => l.id === m.lead_id);
      const isToday = m.scheduled_date === today;
      return `<li data-lead="${m.lead_id}">
        <span class="u-when${isToday ? " is-today" : ""}">${isToday ? "Today" : esc(fmtDay(m.scheduled_date))}${m.time_slot ? `<small>${esc(m.time_slot)}</small>` : ""}</span>
        <span class="u-who">${esc(lead ? lead.name : "Lead")}<small>${esc(MEETING_TYPE[m.type])}${lead?.location ? " · " + esc(lead.location) : ""}</small></span>
      </li>`;
    }).join("");
  }
  $("upcomingList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-lead]");
    if (li) openDrawer(li.dataset.lead);
  });

  // ---------- Table interactions ----------
  $("pipeline").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-status]");
    if (!btn) return;
    state.status = btn.dataset.status;
    render();
  });
  $("search").addEventListener("input", (e) => { state.search = e.target.value.trim(); render(); });
  $("dateFilter").addEventListener("change", (e) => { state.days = e.target.value; render(); });
  $("refreshBtn").addEventListener("click", async () => { await loadLeads(); toast("Leads refreshed"); });

  $("rows").addEventListener("click", (e) => {
    if (e.target.closest("a, select")) return;
    const tr = e.target.closest("tr[data-id]");
    if (tr) openDrawer(tr.dataset.id);
  });

  // ---------- Drawer ----------
  function setStageBadge(status) {
    $("dStage").className = `badge s-${status}`;
    $("dStage").textContent = STATUS_LABEL[status] || status;
  }

  function showPane(name) {
    document.querySelectorAll("#dTabs button").forEach((b) => b.classList.toggle("is-active", b.dataset.pane === name));
    document.querySelectorAll(".drawer__body .pane").forEach((p) => (p.hidden = p.dataset.pane !== name));
    document.querySelector(".drawer__body").scrollTop = 0;
  }
  $("dTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pane]");
    if (b) showPane(b.dataset.pane);
  });
  async function openDrawer(id) {
    const l = state.leads.find((x) => x.id === id);
    if (!l) return;
    state.current = l;
    $("dName").textContent = l.name;
    $("dMeta").textContent = [l.client_code ? `Client ID ${l.client_code}` : "", l.phone, l.location, `received ${relTime(l.created_at)} via ${l.source}`].filter(Boolean).join(" · ");
    setStageBadge(l.status);
    showPane("overview");

    const digits = l.phone.replace(/\D/g, "");
    $("dCall").href = `tel:${l.phone}`;
    $("dWhatsApp").href = `https://wa.me/${digits}`;
    $("dEmail").hidden = !l.email;
    if (l.email) $("dEmail").href = `mailto:${l.email}`;

    const fields = [
      ["Phone", l.phone], ["City / pincode", l.location], ["Address", l.address], ["Email", l.email],
      ["Property type", l.property_type], ["Monthly bill", l.monthly_bill], ["System size", l.system_size],
      ["System type", l.system_type], ["Wants subsidy", l.wants_subsidy], ["Preferred call time", l.preferred_call_time],
      ["Consent to AI call", l.consent ? "Yes" : "No"],
    ];
    $("dDetails").innerHTML = fields.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v || "—")}</dd></div>`).join("");

    const f = $("manageForm");
    f.status.value = l.status;
    f.follow_up_date.value = l.follow_up_date || "";
    f.assigned_to.value = l.assigned_to || "";
    f.deal_value.value = l.deal_value ?? "";
    $("savedMsg").textContent = "";

    const r = $("reqForm");
    ["owns_property", "roof_type", "roof_area", "shading", "install_timeline", "requirement_notes", "grid_ok", "address"].forEach((k) => {
      r[k].value = l[k] || "";
    });
    if (l.owns_property && ![...r.owns_property.options].some((o) => o.value === l.owns_property)) {
      r.owns_property.add(new Option(l.owns_property, l.owns_property, true, true));
    }
    $("reqSaved").textContent = "";
    $("meetingForm").hidden = true;

    $("drawer").hidden = false;
    document.body.style.overflow = "hidden";
    await Promise.all([loadActivity(l.id), loadCalls(l.id), loadMeetings(l.id), window.Quotes?.open(l), window.Surveys?.renderLead(l),
      window.Orders?.renderLead(l), window.Service?.renderLead(l)]);
  }

  // ---------- Requirements ----------
  $("reqForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.current) return;
    const f = e.target;
    const patch = {};
    ["owns_property", "roof_type", "roof_area", "shading", "install_timeline", "requirement_notes", "grid_ok", "address"].forEach((k) => {
      patch[k] = f[k].value.trim() || null;
    });
    const updated = await updateLead(state.current.id, patch);
    if (updated) {
      state.current = updated;
      $("reqSaved").textContent = "Saved";
    }
  });

  // ---------- Meetings ----------
  async function loadMeetings(leadId) {
    const { data, error } = await sb.from("meetings").select("*").eq("lead_id", leadId).order("scheduled_date", { ascending: false });
    if (error) return ($("meetings").innerHTML = `<li class="m-empty">Meetings aren't set up yet.</li>`);
    $("meetings").innerHTML = data.length
      ? data.map((m) => `<li class="is-${m.status}" data-id="${m.id}">
          <div class="m-head">
            <span class="m-title">${MEETING_TYPE[m.type]} · ${esc(fmtDay(m.scheduled_date))}${m.time_slot ? " · " + esc(m.time_slot) : ""}</span>
            <span class="m-badge ${m.status}">${MEETING_STATUS[m.status]}</span>
          </div>
          <div class="m-meta">${m.source === "ai_call" ? "Booked by AI advisor" : `Added by ${esc(m.created_by || "staff")}`}</div>
          ${m.type === "site_survey" ? `<div class="m-actions survey-row">
            ${state.isManager
              ? `<label class="assign">Engineer <select data-assign>${engineerOptions(m.assigned_to)}</select></label>`
              : `<span class="m-meta">Engineer: ${esc(staffName(m.assigned_to) || "not assigned")}</span>`}
            <button type="button" class="btn btn--dark btn--sm" data-survey="${m.id}">Survey form</button>
          </div>` : ""}
          ${m.agenda ? `<div class="m-text"><b>Agenda:</b> ${esc(m.agenda)}</div>` : ""}
          ${m.minutes ? `<div class="m-text"><b>Minutes:</b> ${esc(m.minutes)}</div>` : ""}
          <details>
            <summary>${m.minutes ? "Edit minutes" : "Record minutes"}</summary>
            <textarea rows="4" placeholder="What was discussed, what the customer needs, and what happens next">${esc(m.minutes || "")}</textarea>
            <div class="m-actions">
              <button type="button" class="btn btn--primary btn--sm" data-act="done">Save as done</button>
              ${m.status === "scheduled" ? `<button type="button" class="btn btn--ghost btn--sm" data-act="no_show">No-show</button>
              <button type="button" class="btn btn--ghost btn--sm" data-act="cancelled">Cancel meeting</button>` : ""}
            </div>
          </details>
        </li>`).join("")
      : `<li class="m-empty">No meetings yet.</li>`;
  }

  const staffName = (email) => {
    if (!email) return "";
    const s = state.staff.find((x) => x.email.toLowerCase() === email.toLowerCase());
    return s ? s.name || s.email : email;
  };
  // Engineers first, then everyone else (a manager may do a survey too)
  const engineerOptions = (selected) => `<option value="">Not assigned</option>` +
    [...state.staff].sort((a, b) => (a.role === "engineer" ? 0 : 1) - (b.role === "engineer" ? 0 : 1))
      .map((s) => `<option value="${esc(s.email)}"${s.email === selected ? " selected" : ""}>${esc(s.name || s.email)}${s.role === "engineer" ? "" : ` (${esc(s.role)})`}</option>`).join("");

  $("meetings").addEventListener("change", async (e) => {
    if (!e.target.matches("select[data-assign]") || !state.current) return;
    const id = e.target.closest("li[data-id]").dataset.id;
    const { error } = await sb.from("meetings").update({ assigned_to: e.target.value || null }).eq("id", id);
    if (error) return toast("Couldn't assign: " + error.message);
    if (e.target.value) {
      await sb.from("lead_activities").insert({
        lead_id: state.current.id, type: "note", created_by: state.me.email,
        body: `Site survey assigned to ${staffName(e.target.value)}.`,
      });
      loadActivity(state.current.id);
    }
    toast(e.target.value ? `Assigned to ${staffName(e.target.value)}` : "Engineer removed");
  });

  $("meetings").addEventListener("click", async (e) => {
    const surveyBtn = e.target.closest("button[data-survey]");
    if (surveyBtn && state.current) return window.Surveys?.openForMeeting(surveyBtn.dataset.survey, state.current);
    const btn = e.target.closest("button[data-act]");
    if (!btn || !state.current) return;
    const li = btn.closest("li[data-id]");
    const status = btn.dataset.act;
    const minutes = li.querySelector("textarea").value.trim();
    if (status === "done" && !minutes) return toast("Write the minutes before marking it done.");
    const patch = { status };
    if (minutes) patch.minutes = minutes;
    const { error } = await sb.from("meetings").update(patch).eq("id", li.dataset.id);
    if (error) return toast("Couldn't save: " + error.message);
    if (status === "done") {
      await sb.from("lead_activities").insert({
        lead_id: state.current.id, type: "note", body: `Meeting minutes:\n${minutes}`, created_by: state.me.email,
      });
    }
    toast(status === "done" ? "Minutes saved" : `Meeting marked ${MEETING_STATUS[status].toLowerCase()}`);
    await loadUpcoming();
    render();
    await Promise.all([loadMeetings(state.current.id), loadActivity(state.current.id)]);
  });

  $("addMeetingBtn").addEventListener("click", () => {
    const f = $("meetingForm");
    f.hidden = !f.hidden;
    if (!f.hidden) f.scheduled_date.value = state.current?.follow_up_date || todayISO();
  });

  $("meetingForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.current) return;
    const f = e.target;
    const { error } = await sb.from("meetings").insert({
      lead_id: state.current.id,
      type: f.type.value,
      scheduled_date: f.scheduled_date.value,
      time_slot: f.time_slot.value.trim() || null,
      agenda: f.agenda.value.trim() || null,
      source: "staff",
      created_by: state.me.email,
    });
    if (error) return toast("Couldn't save: " + error.message);
    // Keep the lead's follow-up date pointing at the next meeting
    const current = state.current.follow_up_date;
    if (!current || current < todayISO() || f.scheduled_date.value < current) {
      const updated = await updateLead(state.current.id, { follow_up_date: f.scheduled_date.value });
      if (updated) state.current = updated;
    }
    f.reset();
    f.hidden = true;
    toast("Meeting scheduled");
    await loadUpcoming();
    render();
    await loadMeetings(state.current.id);
  });

  // Minutes of meeting written by Gemini after the call
  function renderMinutes(c) {
    const m = c.minutes || {};
    const list = (title, items) => (Array.isArray(items) && items.length
      ? `<h4>${title}</h4><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");
    const req = Object.entries(m.requirements || {}).filter(([, v]) => v);
    const nm = m.next_meeting;
    return `<div class="mom">
      ${m.outcome ? `<div><span class="outcome ${esc(m.outcome)}">${esc(m.outcome.replace(/_/g, " "))}</span></div>` : ""}
      ${m.summary ? `<div class="c-summary">${esc(m.summary)}</div>` : ""}
      ${req.length ? `<h4>Requirements</h4><div class="req">${req.map(([k, v]) => `<div><span>${esc(k.replace(/_/g, " "))}:</span> ${esc(v)}</div>`).join("")}</div>` : ""}
      ${list("Customer needs", m.customer_requirements)}
      ${list("Concerns", m.concerns)}
      ${list("Agreed next steps", m.agreed_next_steps)}
      ${nm && nm.type !== "none" ? `<h4>Next meeting</h4><div>${MEETING_TYPE[nm.type] || esc(nm.type)}${nm.date ? " · " + esc(fmtDay(nm.date)) : " · date not fixed"}${nm.time_slot ? " · " + esc(nm.time_slot) : ""}</div>` : ""}
    </div>`;
  }

  async function loadCalls(leadId) {
    const { data, error } = await sb.from("lead_calls").select("*").eq("lead_id", leadId).order("created_at", { ascending: false });
    if (error) return ($("calls").innerHTML = `<li class="c-empty">AI calling isn't set up yet.</li>`);
    $("calls").innerHTML = data.length
      ? data.map((c) => {
          const [kind, label] = AI_STATES[c.status] || ["wait", c.status];
          const when = c.status === "scheduled" && c.scheduled_at ? `for ${fmtDateTime(c.scheduled_at)}` : fmtDateTime(c.created_at);
          const meta = [c.duration_seconds ? fmtDuration(c.duration_seconds) : "", c.termination_reason ? c.termination_reason.replace(/_/g, " ") : ""]
            .filter(Boolean).join(" · ");
          return `<li>
            <div class="c-head"><span class="ai ai--${kind}">${esc(label)}</span><span>${esc(when)}${meta ? " · " + esc(meta) : ""}</span></div>
            ${c.minutes ? renderMinutes(c) : c.summary ? `<div class="c-summary">${esc(c.summary)}</div>` : ""}
            ${c.recording_url && /^https:\/\//.test(c.recording_url) ? `<audio controls preload="none" src="${esc(c.recording_url)}"></audio>` : ""}
            ${c.transcript ? `<details><summary>Transcript</summary><pre>${esc(c.transcript)}</pre></details>` : ""}
            ${c.status === "completed" && c.transcript ? `<div><button type="button" class="btn btn--ghost btn--sm" data-regen="${esc(c.execution_id)}">${c.minutes ? "Regenerate minutes" : "Generate minutes"}</button></div>` : ""}
          </li>`;
        }).join("")
      : `<li class="c-empty">No AI calls yet.</li>`;
  }

  // Re-run Gemini on a finished call (e.g. if Google was busy when the call ended)
  $("calls").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-regen]");
    if (!btn || !state.current) return;
    btn.disabled = true;
    btn.textContent = "Writing minutes… (up to 2 min)";
    const { data, error } = await sb.functions.invoke("hyper-action", { body: { execution_id: btn.dataset.regen } });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.text()) || msg; } catch {}
      btn.disabled = false;
      btn.textContent = "Generate minutes";
      return toast("Couldn't generate minutes: " + msg);
    }
    toast(data?.outcome ? "Minutes updated" : "Done, but Gemini didn't return minutes. See the activity log.");
    await loadLeads();
    const fresh = state.leads.find((x) => x.id === state.current.id);
    if (fresh) await openDrawer(fresh.id);
  });

  $("aiCallBtn").addEventListener("click", async () => {
    const l = state.current;
    if (!l || !confirm(`Ask the AI advisor to call ${l.name} (${l.phone}) now?`)) return;
    const btn = $("aiCallBtn");
    btn.disabled = true;
    const { data, error } = await sb.functions.invoke("clever-task", { body: { lead_id: l.id, force: true } });
    btn.disabled = false;
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch {}
      return toast("Couldn't start the call: " + msg);
    }
    if (data?.skipped) return toast("A call for this lead is already in progress.");
    toast(data?.scheduled_at ? "Outside calling hours, so the call has been scheduled" : "AI call placed");
    await loadLeads();
    const fresh = state.leads.find((x) => x.id === l.id);
    if (fresh) state.current = fresh;
    await Promise.all([loadActivity(l.id), loadCalls(l.id)]);
  });

  function closeDrawer() {
    $("drawer").hidden = true;
    document.body.style.overflow = "";
    state.current = null;
  }
  document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeDrawer));

  async function loadActivity(leadId) {
    const { data, error } = await sb.from("lead_activities").select("*").eq("lead_id", leadId).order("created_at", { ascending: false });
    if (error) return ($("timeline").innerHTML = `<li class="t-empty">Couldn't load activity.</li>`);
    const typeLabel = { note: "Note", call: "Call", status: "Status" };
    $("timeline").innerHTML = data.length
      ? data.map((a) => `<li class="t-${a.type}">
          <div class="t-head"><span>${typeLabel[a.type]} · ${esc(a.created_by || "system")}</span><span>${esc(fmtDateTime(a.created_at))}</span></div>
          <div class="t-body">${esc(a.type === "status" ? a.body.replace(/\b[a-z_]+\b/g, (s) => STATUS_LABEL[s] || s) : a.body)}</div>
        </li>`).join("")
      : `<li class="t-empty">No activity yet.</li>`;
  }

  $("manageForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.current) return;
    const f = e.target;
    const updated = await updateLead(state.current.id, {
      status: f.status.value,
      follow_up_date: f.follow_up_date.value || null,
      assigned_to: f.assigned_to.value || null,
      deal_value: f.deal_value.value === "" ? null : Number(f.deal_value.value),
    });
    if (updated) {
      state.current = updated;
      $("savedMsg").textContent = "Saved";
      await loadActivity(updated.id);
    }
  });

  $("noteForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.current) return;
    const f = e.target;
    const { error } = await sb.from("lead_activities").insert({
      lead_id: state.current.id,
      type: f.type.value,
      body: f.body.value.trim(),
      created_by: state.me.email,
    });
    if (error) return toast("Couldn't add: " + error.message);
    f.body.value = "";
    await loadActivity(state.current.id);
  });

  $("deleteBtn").addEventListener("click", async () => {
    const l = state.current;
    if (!l || !confirm(`Delete ${l.name}'s lead and all its activity? This can't be undone.`)) return;
    const { error } = await sb.from("leads").delete().eq("id", l.id);
    if (error) return toast("Couldn't delete: " + error.message);
    state.leads = state.leads.filter((x) => x.id !== l.id);
    closeDrawer();
    render();
    toast("Lead deleted");
  });

  // ---------- Add lead ----------
  const addModal = $("addModal");
  $("addBtn").addEventListener("click", () => { addModal.hidden = false; $("addError").textContent = ""; });
  document.querySelectorAll("[data-close-add]").forEach((el) => el.addEventListener("click", () => (addModal.hidden = true)));

  $("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const digits = f.phone.value.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
    if (!/^[6-9]\d{9}$/.test(digits)) return ($("addError").textContent = "Enter a valid 10-digit mobile number.");
    const { data, error } = await sb.from("leads").insert({
      name: f.name.value.trim(),
      phone: "+91" + digits,
      location: f.location.value.trim(),
      email: f.email.value.trim() || null,
      property_type: f.property_type.value || null,
      monthly_bill: f.monthly_bill.value || null,
      source: f.source.value,
      consent: f.consent.checked,
    }).select().single();
    if (error) return ($("addError").textContent = error.message);
    state.leads.unshift(data);
    f.reset();
    addModal.hidden = true;
    render();
    toast("Lead added");
  });

  // ---------- Export ----------
  $("exportBtn").addEventListener("click", () => {
    const base = baseFiltered();
    const rows = state.status === "all" ? base : base.filter((l) => l.status === state.status);
    const cols = [
      ["Received", (l) => fmtDateTime(l.created_at)], ["Client ID", (l) => l.client_code], ["Name", (l) => l.name], ["Phone", (l) => l.phone],
      ["City / pincode", (l) => l.location], ["Email", (l) => l.email], ["Property type", (l) => l.property_type],
      ["Monthly bill", (l) => l.monthly_bill], ["System size", (l) => l.system_size], ["System type", (l) => l.system_type],
      ["Wants subsidy", (l) => l.wants_subsidy], ["Preferred call time", (l) => l.preferred_call_time],
      ["Status", (l) => STATUS_LABEL[l.status]], ["Follow-up", (l) => l.follow_up_date], ["Assigned to", (l) => l.assigned_to],
      ["Deal value", (l) => l.deal_value], ["Source", (l) => l.source],
    ];
    const cell = (v) => {
      let s = String(v ?? "");
      if (/^[=+\-@]/.test(s) && !/^\+\d+$/.test(s)) s = "'" + s; // stop spreadsheet formula injection
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [cols.map(([h]) => cell(h)).join(","), ...rows.map((l) => cols.map(([, fn]) => cell(fn(l))).join(","))].join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sunpower-leads-${todayISO()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---------- Keyboard & auto-refresh ----------
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("drawer").hidden) closeDrawer();
    addModal.hidden = true;
  });
  setInterval(() => {
    if (viewOpen("leads") && $("drawer").hidden && addModal.hidden) loadLeads();
  }, 60000);

  // ---------- Shared with quotes.js, orders.js, warehouse.js, schedule.js, products.js ----------
  window.CRM = {
    sb, state, esc, toast, todayISO, fmtDateTime, fmtDay, relTime, updateLead, loadActivity, loadMeetings, openDrawer, staffName, showPane,
    showView, viewOpen, addDays, mondayOf, isLowStock, loadTiles, STATUS_LABEL,
    registerView: (name, load) => (views[name] = load),
    refreshLead: async (id) => {
      await loadLeads();
      const fresh = state.leads.find((x) => x.id === id);
      if (fresh && state.current?.id === id) {
        state.current = fresh;
        setStageBadge(fresh.status);
      }
      return fresh;
    },
  };

  // ---------- Start ----------
  // Wait until every CRM script (quotes, surveys) has loaded before deciding which view to show
  window.addEventListener("DOMContentLoaded", () => {
    sb.auth.getSession().then(({ data }) => (data.session ? enterApp(data.session) : showLogin()));
  });
})();
