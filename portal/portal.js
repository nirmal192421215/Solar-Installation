// Customer portal / Localhost users: a customer's own system, warranty cards, installation record, documents,
// subsidy, payments and service requests.
// Two ways in, both checked by the customer-portal Edge Function on every request:
//   • the private link (?t=…) staff send from the CRM
//   • the Localhost users login (phone number + password) the customer gets on WhatsApp when their order is completed
(() => {
  // Public (anon) key: safe in the browser. The portal function only returns this customer's data.
  const SUPABASE_URL = "https://iekfgtyfwmplsauutegs.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlla2ZndHlmd21wbHNhdXV0ZWdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0MjQ4MjQsImV4cCI6MjEwOTAwMDgyNH0.jNPdk0LeP4bHdyRoRHq-xjYr8EIXvlx3M13X9GugnIY";
  const PORTAL_FUNCTION = "customer-portal";
  const SESSION_KEY = "sunpower_passport_session";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
  const fmtDate = (d) => (d ? new Date(String(d).length === 10 ? d + "T00:00:00" : d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");
  const fmtDay = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

  const SYSTEM_TYPES = { on_grid: "On-grid", hybrid: "Hybrid (with battery)", off_grid: "Off-grid (battery)", panel_set: "Solar panel set" };
  const CATEGORIES = [
    ["no_generation", "No power from the system", "🔌"],
    ["low_generation", "Generating less than usual", "📉"],
    ["inverter_error", "Inverter error or beeping", "⚠️"],
    ["tripping", "Breaker keeps tripping", "⚡"],
    ["water_leak", "Water leak / water in the inverter or boxes", "💧"],
    ["physical_damage", "Storm or physical damage", "🌪️"],
    ["wiring", "Loose or damaged wiring", "🧵"],
    ["safety", "Sparks, smoke, burning smell or shock", "🔥"],
    ["other", "Something else", "💬"],
  ];
  const CATEGORY = Object.fromEntries(CATEGORIES.map(([k, l]) => [k, l]));
  CATEGORY.checkup = "Pre-monsoon checkup";
  const STATUS = {
    open: ["Received", "o-wait"], scheduled: ["Visit booked", "o-confirmed"], in_progress: ["Technician on site", "o-packing"],
    resolved: ["Resolved", "o-installed"], closed: ["Closed", "o-done"], cancelled: ["Cancelled", "o-cancelled"],
  };
  const SUBSIDY_STEPS = [["registration", "Registered"], ["feasibility", "Feasibility approved"], ["installation", "Installed"],
    ["inspection", "DISCOM inspection / net meter"], ["claim", "Subsidy claimed"], ["credited", "Credited to you"]];
  const PHOTO_LABEL = { after: "Finished system", panels: "Panels & structure", inverter: "Inverter" };
  const SAFETY = "For your safety: switch OFF the AC breaker and the DC isolator, keep children away and don't touch the panels or wires. We treat this as urgent.";

  const params = new URLSearchParams(location.search);
  const token = params.get("t") || "";
  const store = {
    get() { try { return localStorage.getItem(SESSION_KEY) || ""; } catch { return ""; } },
    set(v) { try { v ? localStorage.setItem(SESSION_KEY, v) : localStorage.removeItem(SESSION_KEY); } catch { /* private window: this visit only */ } },
  };
  let session = token ? "" : store.get();
  let data = null;

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 3200);
  }

  async function call(body) {
    const auth = session ? { session } : token ? { token } : {};
    const { data: res, error } = await sb.functions.invoke(PORTAL_FUNCTION, { body: { ...auth, ...body } });
    if (error) {
      let msg = error.message;
      let signedOut = false;
      try {
        const j = await error.context.json();
        msg = j.error || msg;
        signedOut = Boolean(j.signed_out);
      } catch {}
      const err = new Error(msg);
      err.signedOut = signedOut;
      throw err;
    }
    return res;
  }

  async function load() {
    if (!token && !session) return showLogin();
    try {
      data = await call({ action: "get" });
      $("signOutBtn").hidden = data.access.via !== "session";
      if (data.access.must_change) return showSetPassword("");
      render();
    } catch (err) {
      if (err.signedOut) {
        session = "";
        store.set("");
        return showLogin("Please sign in again.");
      }
      $("app").innerHTML = `<div class="card portal-card"><h1>${token ? "Link not working" : "Couldn't open Localhost users"}</h1><p class="muted">${esc(err.message)}</p>
        <p><a class="btn btn--primary" href="tel:+919342626096">Call Sun Power</a></p></div>`;
    }
  }

  // ---------- Sign in ----------
  function showLogin(note = "") {
    $("signOutBtn").hidden = true;
    $("app").innerHTML = `
      <section class="card portal-card passport-login">
        <p class="pp-eyebrow">Sun Power · My Solar</p>
        <h1>Localhost users</h1>
        <p class="muted">Your warranty cards, serial numbers, installation record, invoices and service requests in one place.</p>
        <form id="loginForm" class="pp-form" novalidate>
          <label><span>Phone number or client ID</span><input name="username" id="ppUser" autocomplete="username" inputmode="tel" placeholder="e.g. 98450 98450" value="${esc(params.get("u") || "")}" required></label>
          <label><span>Password</span><input name="password" id="ppPass" type="password" autocomplete="current-password" required></label>
          <label class="check"><input type="checkbox" id="ppShow"> Show password</label>
          <button type="submit" class="btn btn--primary btn--block">Sign in</button>
          <p class="login__error" id="loginError" role="alert">${esc(note)}</p>
        </form>
        <p class="muted pp-help">Your login comes on WhatsApp when your system is handed over and fully paid. Forgot your password? Call <b>+91 93426 26096</b> and we'll send a new one.</p>
      </section>`;
    $(params.get("u") ? "ppPass" : "ppUser").focus();
  }

  let lastPassword = ""; // the password just used to sign in, so a customer setting their own doesn't type it twice

  // ---------- Set your own password (first sign-in, or any time) ----------
  function showSetPassword(current) {
    $("app").innerHTML = `
      <section class="card portal-card passport-login">
        <p class="pp-eyebrow">Localhost users</p>
        <h1>Set your own password</h1>
        <p class="muted">The password we sent on WhatsApp is for your first sign-in only. Choose one only you know: at least 8 characters.</p>
        <form id="pwForm" class="pp-form" novalidate>
          ${current || lastPassword ? "" : `<label><span>Current password</span><input name="current" type="password" autocomplete="current-password" required></label>`}
          <label><span>New password</span><input name="new" type="password" autocomplete="new-password" minlength="8" required></label>
          <label><span>Type it again</span><input name="again" type="password" autocomplete="new-password" minlength="8" required></label>
          <button type="submit" class="btn btn--primary btn--block">Save password</button>
          ${data && !data.access.must_change ? `<button type="button" class="btn btn--ghost btn--block" id="pwCancel">Cancel</button>` : ""}
          <p class="login__error" id="pwError" role="alert"></p>
        </form>
      </section>`;
  }

  $("app").addEventListener("submit", async (e) => {
    const f = e.target;
    if (f.id === "loginForm") {
      e.preventDefault();
      const btn = f.querySelector('button[type="submit"]');
      $("loginError").textContent = "";
      if (!f.username.value.trim() || !f.password.value) return ($("loginError").textContent = "Enter your phone number and password.");
      btn.disabled = true;
      btn.textContent = "Signing in…";
      try {
        const res = await call({ action: "login", username: f.username.value, password: f.password.value });
        session = res.session;
        store.set(session);
        lastPassword = f.password.value;
        if (params.get("u")) history.replaceState(null, "", location.pathname);
        await load();
      } catch (err) {
        $("loginError").textContent = err.message;
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
      return;
    }
    if (f.id === "pwForm") {
      e.preventDefault();
      const current = f.current ? f.current.value : lastPassword;
      $("pwError").textContent = "";
      if (f.new.value.length < 8) return ($("pwError").textContent = "Choose a password of at least 8 characters.");
      if (f.new.value !== f.again.value) return ($("pwError").textContent = "The two passwords don't match.");
      const btn = f.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await call({ action: "change_password", current, new: f.new.value });
        lastPassword = "";
        toast("Password saved. Use it next time you sign in.");
        await load();
      } catch (err) {
        $("pwError").textContent = err.message;
        btn.disabled = false;
      }
    }
  });

  $("app").addEventListener("change", (e) => {
    if (e.target.id === "ppShow") $("ppPass").type = e.target.checked ? "text" : "password";
  });

  $("signOutBtn").addEventListener("click", async () => {
    try { await call({ action: "logout" }); } catch { /* signed out here either way */ }
    session = "";
    store.set("");
    data = null;
    lastPassword = "";
    showLogin("You're signed out.");
  });

  // ---------- Passport ----------
  function render() {
    const c = data.customer;
    const open = data.tickets.filter((t) => ["open", "scheduled", "in_progress"].includes(t.status));
    const checkup = data.tickets.find((t) => t.kind === "checkup" && t.status === "scheduled");
    $("callBtn").href = `tel:${data.company_phone.replace(/\s/g, "")}`;
    $("app").innerHTML = `
      <section class="portal-hello">
        <p class="pp-eyebrow">Localhost users</p>
        <h1>Hello ${esc((c.name || "").split(/\s+/)[0])}</h1>
        <p class="muted">Client ID <b>${esc(c.client_code || "—")}</b>${c.location ? ` · ${esc(c.location)}` : ""}</p>
      </section>

      <section class="portal-actions">
        <button type="button" class="btn btn--primary" id="reportBtn">Report a problem</button>
        <a class="btn btn--ghost" href="https://wa.me/${esc(data.company_phone.replace(/\D/g, ""))}" target="_blank" rel="noopener">WhatsApp us</a>
      </section>

      ${checkup ? `<section class="card portal-card portal-card--accent">
        <h2>Free pre-monsoon checkup</h2>
        <p><b>${esc(fmtDay(checkup.visit_date))}, ${esc(checkup.visit_slot || "")}</b>${checkup.crew ? ` · ${esc(checkup.crew)}` : ""}</p>
        <p class="muted">We'll clean the panels, test the earthing, check cables and seal junction boxes before the rains.</p>
      </section>` : ""}

      ${data.orders.map(passportCards).join("") || `<section class="card portal-card"><p class="muted">Your system details appear here once your order is confirmed.</p></section>`}

      ${data.tickets.length ? `<section class="card portal-card">
        <h2>Service requests${open.length ? ` <em class="count">${open.length}</em>` : ""}</h2>
        <ol class="portal-tickets">${data.tickets.map(ticketCard).join("")}</ol>
      </section>` : ""}

      ${data.access.via === "session" ? `<section class="card portal-card pp-account">
        <h2>Your login</h2>
        <p class="muted">You sign in with your phone number <b>${esc(c.phone)}</b> and your own password.</p>
        <p><button type="button" class="btn btn--ghost btn--sm" id="changePwBtn">Change password</button></p>
      </section>` : ""}
    `;
  }

  // Months left (or ago) as "1 yr 11 mo"
  function span(fromISO, toISO) {
    const a = new Date(fromISO + "T00:00:00"), b = new Date(toISO + "T00:00:00");
    let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() < a.getDate()) m -= 1;
    m = Math.max(0, m);
    const y = Math.floor(m / 12), r = m % 12;
    return [y ? `${y} yr${y > 1 ? "s" : ""}` : "", r ? `${r} mo` : "", !y && !r ? "under a month" : ""].filter(Boolean).join(" ");
  }

  function warrantyCard(w) {
    const today = todayIST();
    const active = w.until && w.until >= today;
    const total = w.from && w.until ? new Date(w.until) - new Date(w.from) : 0;
    const used = total ? Math.min(100, Math.max(0, ((new Date(today) - new Date(w.from)) / total) * 100)) : 0;
    const serials = w.serials || [];
    const length = w.months % 12 === 0 ? `${w.months / 12}-year` : `${w.months}-month`;
    return `<li class="wcard ${active ? "" : "is-expired"}">
      <div class="wcard__head"><span class="wcard__what">${esc(w.what)}</span>
        <span class="badge ${active ? "w-ok" : "w-bad"}">${active ? "✓ Active" : "✕ Expired"}</span></div>
      <div class="m-meta">${w.category !== "workmanship" ? `${esc(w.qty)} ${esc(w.unit || "")} · ` : ""}${esc(length)} warranty${active ? ` · <b>${esc(span(today, w.until))} left</b>` : ""}</div>
      ${serials.length ? `<div class="wcard__serials"><span class="wcard__label">Serial no${serials.length > 1 ? "s" : ""}</span>
        <div class="wcard__chips">${serials.slice(0, 2).map((s) => `<code>${esc(s)}</code>`).join("")}${serials.length > 2 ? `<details><summary>+${serials.length - 2} more</summary><div class="wcard__chips">${serials.slice(2).map((s) => `<code>${esc(s)}</code>`).join("")}</div></details>` : ""}</div></div>` : ""}
      <div class="wcard__foot">
        ${w.from && w.until ? `<div class="wcard__bar" role="img" aria-label="${Math.round(used)}% of the warranty period used"><span style="width:${used.toFixed(1)}%"></span></div>
        <div class="wcard__dates"><span>From <b>${esc(fmtDate(w.from))}</b></span><span>${active ? "Until" : "Ended"} <b>${esc(fmtDate(w.until))}</b></span></div>` : `<div class="m-meta">Starts when your system is delivered.</div>`}
      </div>
    </li>`;
  }

  // Main units first, workmanship last
  const CARD_ORDER = ["panel", "inverter", "battery", "charge_controller"];
  const cardRank = (w) => (w.category === "workmanship" ? 99 : CARD_ORDER.includes(w.category) ? CARD_ORDER.indexOf(w.category) : 50);

  const docRow = (label, url, amount, date) => `<li>
      <span class="doc__name">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label)}
        <small>${esc(fmtDate(date))}${url ? " · PDF" : ""}</small></span>
      <b>${amount !== null ? esc(inr(amount)) : ""}</b>
    </li>`;

  function passportCards(o) {
    const handed = o.status === "completed";
    const inst = o.installation;
    const docs = [
      o.quote_pdf ? docRow("Quotation", o.quote_pdf, null, null) : "",
      ...o.invoices.map((i) => docRow(`Tax invoice ${i.invoice_number}`, i.url, i.total, i.invoice_date)),
      ...o.receipts.map((r) => docRow(`Receipt ${r.receipt_number}`, r.url, r.amount, r.paid_on)),
    ].filter(Boolean);
    const cards = [...o.cards].sort((a, b) => cardRank(a) - cardRank(b));
    const sc = o.subsidy_case;
    const at = sc ? SUBSIDY_STEPS.findIndex(([k]) => k === sc.step) : -1;
    return `
      <section class="card portal-card pp-hero">
        <div class="pp-hero__main">
          <p class="pp-eyebrow">${handed ? "Handed over" : esc((o.status || "").replace(/_/g, " "))}</p>
          <p class="portal-big">${esc(o.system_size_kw)} kW ${esc(SYSTEM_TYPES[o.system_type] || o.system_type || "")}</p>
          <p class="muted">Order <b>${esc(o.order_number)}</b></p>
          <p class="muted">${o.installed_at ? `Installed ${esc(fmtDate(o.installed_at))}${inst?.crew ? ` by ${esc(inst.crew)}` : ""}` : o.install ? `Installation ${esc(fmtDay(o.install.date))}, ${esc(o.install.slot)}` : "Installation date coming soon"}</p>
          <div class="pp-chips">
            ${handed ? `<span class="badge w-ok">✓ Fully paid</span>` : Number(o.balance) > 0 ? `<span class="badge o-wait">${esc(inr(o.balance))} due</span>` : ""}
            ${o.cards.some((w) => w.until && w.until >= todayIST()) ? `<span class="badge w-ok">✓ Warranty active</span>` : ""}
            ${inst?.installed_kw ? `<span class="badge">${esc(inst.installed_kw)} kW installed</span>` : ""}
          </div>
        </div>
        ${handed ? `<figure class="pp-qr"><div data-qr="${esc(data.customer.client_code || "")}"></div><figcaption>Scan to open Localhost users</figcaption></figure>` : ""}
      </section>

      ${o.cards.length ? `<section class="card portal-card">
        <div class="pp-head"><h2>Warranty cards</h2>
          <button type="button" class="btn btn--ghost btn--sm" data-card-pdf="${esc(o.order_number)}">Download warranty card (PDF)</button></div>
        <ul class="wcards">${cards.map(warrantyCard).join("")}</ul>
        <p class="m-meta">Each unit's warranty starts on the day it was delivered to you. Keep this page: it's your proof of purchase.</p>
      </section>` : ""}

      ${inst ? `<section class="card portal-card">
        <h2>Installation record</h2>
        <dl class="pp-facts">
          ${inst.finished_at ? `<div><dt>Completed</dt><dd>${esc(fmtDate(inst.finished_at))}</dd></div>` : ""}
          ${inst.crew ? `<div><dt>Installed by</dt><dd>${esc(inst.crew)}</dd></div>` : ""}
          ${inst.installed_kw ? `<div><dt>System size</dt><dd>${esc(inst.installed_kw)} kW</dd></div>` : ""}
          ${inst.generation_kwh !== null ? `<div><dt>Generation at handover</dt><dd>${esc(inst.generation_kwh)} kWh</dd></div>` : ""}
          ${inst.signed_by ? `<div><dt>Signed off by</dt><dd>${esc(inst.signed_by)}</dd></div>` : ""}
        </dl>
        ${inst.photos.length ? `<div class="pp-photos">${inst.photos.map((p) => `<figure><a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="${esc(PHOTO_LABEL[p.slot] || "Site photo")}" loading="lazy"></a><figcaption>${esc(PHOTO_LABEL[p.slot] || "Site photo")}</figcaption></figure>`).join("")}</div>` : ""}
      </section>` : ""}

      ${sc ? `<section class="card portal-card">
        <h2>PM Surya Ghar subsidy</h2>
        <p class="muted">${esc(inr(sc.amount))} is paid by the Government to your bank account.${sc.application_no ? ` Application ${esc(sc.application_no)}.` : ""}</p>
        <ol class="pp-steps">${SUBSIDY_STEPS.map(([k, label], i) => `<li class="${sc.step === "rejected" ? "" : i < at ? "is-done" : i === at ? "is-now" : ""}">${esc(label)}</li>`).join("")}</ol>
        ${sc.step === "rejected" ? `<p class="quote-warn">The application needs attention. We'll call you about it.</p>` : ""}
      </section>` : ""}

      <section class="card portal-card">
        <h2>Payments &amp; documents</h2>
        <div class="o-sum portal-sum">
          <div><span>Total</span><b>${esc(inr(o.total))}</b></div>
          <div><span>Paid</span><b>${esc(inr(o.amount_paid))}</b></div>
          <div><span>Balance</span><b class="${o.balance > 0 ? "due" : ""}">${esc(inr(o.balance))}</b></div>
        </div>
        ${o.upi_link ? `<p><a class="btn btn--primary" href="${esc(o.upi_link)}">Pay ${esc(inr(o.balance))} by UPI</a> <span class="muted">to ${esc(o.upi_id)}, note ${esc(o.order_number)}</span></p>` : ""}
        ${docs.length ? `<ul class="docs">${docs.join("")}</ul>` : ""}
      </section>`;
  }

  // Warranty of the unit a request is about, as one clean row
  function ticketWarranty(t) {
    if (t.kind === "checkup" || !t.warranty_status || t.warranty_status === "unknown") return "";
    const ok = t.warranty_status === "in_warranty";
    const u = t.unit;
    const what = u ? `${esc(u.what || "Unit")} <code>${esc(u.serial_no)}</code>` : esc(t.warranty_note || "");
    const when = u?.warranty_end ? `${ok ? "valid until" : "ended"} ${esc(fmtDate(u.warranty_end))}` : "";
    return `<div class="tk-warranty ${ok ? "is-ok" : "is-bad"}">
        <span class="tk-warranty__icon" aria-hidden="true">${ok ? "✓" : "!"}</span>
        <div><b>${ok ? "Covered by warranty" : t.warranty_status === "not_covered" ? "Not covered by warranty" : "Warranty expired"}</b>
          <span>${what}${when ? ` · ${when}` : ""}</span></div>
      </div>`;
  }

  function ticketCard(t) {
    const [label, cls] = STATUS[t.status] || [t.status, ""];
    const steps = ["open", "scheduled", "in_progress", "resolved"];
    const at = t.status === "closed" ? steps.length : Math.max(0, steps.indexOf(t.status) + 1);
    const charged = Number(t.charge_amount) > 0;
    const visit = t.visit_date ? `${fmtDay(t.visit_date)}${t.visit_slot ? `, ${t.visit_slot}` : ""}${t.crew ? ` · ${t.crew}` : ""}` : "";
    return `<li class="tk" data-ticket="${t.id}">
      <div class="tk__head">
        <div class="tk__title"><span class="m-title">${esc(t.kind === "checkup" ? "Pre-monsoon checkup" : CATEGORY[t.category] || t.category)}</span>
          <span class="tk__meta">${esc(t.ticket_number)} · reported ${esc(fmtDate(t.created_at))}</span></div>
        <span class="badge ${cls}">${esc(label)}</span>
      </div>
      ${t.status !== "cancelled" ? `<ol class="tk-steps" aria-label="Progress">${steps.map((s, i) =>
        `<li class="${i < at ? "is-done" : i === at ? "is-now" : ""}"><span class="tk-steps__dot" aria-hidden="true">${i < at ? "✓" : ""}</span><span class="tk-steps__label">${["Received", "Visit booked", "On site", "Resolved"][i]}</span></li>`).join("")}</ol>` : ""}
      ${t.visit_date && ["scheduled", "in_progress"].includes(t.status) ? `<p class="tk-next">Technician visit: <b>${esc(visit)}</b></p>` : ""}
      ${t.description && t.kind !== "checkup" ? `<blockquote class="tk-said"><span>You told us</span>${esc(t.description)}</blockquote>` : ""}
      ${ticketWarranty(t)}
      ${t.resolved_at ? `<div class="tk-fix">
          <h3>What we did</h3>
          <dl class="portal-fix">
            ${visit ? `<div><dt>Visit</dt><dd>${esc(visit)}</dd></div>` : ""}
            ${t.cause ? `<div><dt>Found</dt><dd>${esc(t.cause)}</dd></div>` : ""}
            ${t.work_done ? `<div><dt>Work done</dt><dd>${esc(t.work_done)}</dd></div>` : ""}
            ${t.generation_kwh !== null ? `<div><dt>Generation after</dt><dd>${esc(t.generation_kwh)} kWh</dd></div>` : ""}
            <div><dt>Charges</dt><dd>${charged ? `<b>${esc(inr(t.charge_amount))}</b> + GST <span class="tk-sub">· see your tax invoice under Payments &amp; documents</span>` : `<span class="badge w-ok">Free</span>`}</dd></div>
          </dl>
        </div>` : ""}
      ${t.status === "resolved" ? `<p class="tk-next">Is everything working now? Rate the visit to confirm and close this request.</p>` : ""}
      ${t.status === "resolved" ? `<form class="rate" data-rate="${t.id}">
          <span class="field-label">How was our service?</span>
          <div class="stars">${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="rating" value="${n}"><span aria-label="${n} star${n > 1 ? "s" : ""}">★</span></label>`).join("")}</div>
          <input name="feedback" placeholder="Anything to tell us? (optional)">
          <button type="submit" class="btn btn--primary btn--sm">Send rating</button>
        </form>` : ""}
      ${t.status === "closed" && !t.customer_rating && t.confirmed_at ? `<div class="tk-rated"><span>✓ You confirmed it's working${t.confirmed_via === "phone" ? " (on a call with us)" : ""} · ${esc(fmtDate(t.confirmed_at))}</span></div>` : ""}
      ${t.customer_rating ? `<div class="tk-rated"><span>Your rating</span><span class="stars-static" aria-label="${t.customer_rating} out of 5">${"★".repeat(t.customer_rating)}${"☆".repeat(5 - t.customer_rating)}</span>${t.customer_feedback ? `<q>${esc(t.customer_feedback)}</q>` : ""}</div>` : ""}
    </li>`;
  }

  // QR codes are drawn after each render (the link to the Localhost users sign-in page with the client ID filled in)
  const passportLink = (code) => `${location.origin}${location.pathname}?u=${encodeURIComponent(code)}`;
  new MutationObserver(() => {
    document.querySelectorAll("[data-qr]:empty").forEach((el) => {
      if (!window.qrcode) return;
      const qr = window.qrcode(0, "M");
      qr.addData(passportLink(el.dataset.qr));
      qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 1, scalable: true, alt: "QR code for Localhost users" });
    });
  }).observe($("app"), { childList: true });

  // ---------- Warranty card PDF (made on the phone; nothing is uploaded) ----------
  function cardPdf(o) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const W = 210, M = 16;
    const c = data.customer;
    doc.setFillColor(242, 98, 15).rect(0, 0, W, 30, "F");
    doc.setTextColor(255, 255, 255).setFont("helvetica", "bold").setFontSize(18).text("LOCALHOST USERS", M, 14);
    doc.setFont("helvetica", "normal").setFontSize(10).text("Warranty card · Sun Power Solar Solutions", M, 21);
    doc.text(`Client ID ${c.client_code || ""}`, W - M, 14, { align: "right" });
    doc.text(o.order_number, W - M, 21, { align: "right" });

    doc.setTextColor(14, 34, 51).setFont("helvetica", "bold").setFontSize(12).text(c.name || "", M, 42);
    doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(90, 100, 110);
    doc.text([c.location || "", `Phone ${c.phone || ""}`], M, 48);
    const inst = o.installation;
    const facts = [
      ["System", `${o.system_size_kw} kW ${SYSTEM_TYPES[o.system_type] || o.system_type || ""}`],
      ["Installed", `${o.installed_at ? fmtDate(o.installed_at) : "-"}${inst?.crew ? ` by ${inst.crew}` : ""}`],
      ["Installed size", inst?.installed_kw ? `${inst.installed_kw} kW` : "-"],
      ["Generation at handover", inst?.generation_kwh !== null && inst?.generation_kwh !== undefined ? `${inst.generation_kwh} kWh` : "-"],
      ["Status", o.status === "completed" ? `Fully paid, handed over${o.completed_at ? ` ${fmtDate(o.completed_at)}` : ""}` : (o.status || "").replace(/_/g, " ")],
    ];
    let y = 62;
    doc.setFontSize(9.5);
    facts.forEach(([k, v]) => {
      doc.setTextColor(110, 120, 130).text(k, M, y);
      doc.setTextColor(14, 34, 51).text(String(v), M + 46, y);
      y += 6;
    });

    // QR to Localhost users, top right of the details
    if (window.qrcode && c.client_code) {
      const qr = window.qrcode(0, "M");
      qr.addData(passportLink(c.client_code));
      qr.make();
      const n = qr.getModuleCount(), size = 34, cell = size / n, x0 = W - M - size, y0 = 38;
      doc.setFillColor(14, 34, 51);
      for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) doc.rect(x0 + col * cell, y0 + r * cell, cell, cell, "F");
      doc.setFontSize(7.5).setTextColor(110, 120, 130).text("Scan to open Localhost users", x0 + size / 2, y0 + size + 4, { align: "center" });
    }

    const today = todayIST();
    doc.autoTable({
      startY: y + 6,
      margin: { left: M, right: M },
      head: [["Unit", "Serial numbers", "Warranty from", "Valid until", "Status"]],
      body: [...o.cards].sort((a, b) => cardRank(a) - cardRank(b)).map((w) => [
        `${w.what}${w.category !== "workmanship" ? ` (${w.qty} ${w.unit || ""})` : ""}`,
        (w.serials || []).join("\n") || "-",
        w.from ? fmtDate(w.from) : "-",
        w.until ? fmtDate(w.until) : "-",
        w.until && w.until >= today ? "Active" : "Expired",
      ]),
      styles: { font: "helvetica", fontSize: 9, cellPadding: 2.4, textColor: [24, 33, 43], lineColor: [222, 219, 213], lineWidth: 0.2 },
      headStyles: { fillColor: [14, 34, 51], textColor: 255, fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 52 }, 1: { cellWidth: 46, font: "courier" }, 4: { fontStyle: "bold" } },
      didParseCell: (h) => { if (h.section === "body" && h.column.index === 4) h.cell.styles.textColor = h.cell.raw === "Active" ? [27, 127, 59] : [198, 40, 40]; },
    });

    doc.setFontSize(9).setTextColor(90, 100, 110);
    const terms = doc.splitTextToSize([
      "How to claim: call +91 93426 26096 or tap 'Report a problem' in Localhost users, and quote your client ID and the unit's serial number.",
      "Each unit's warranty starts on the day it was delivered to you. Manufacturer terms apply to panels, inverters and batteries; Sun Power covers the installation workmanship. Damage from fire, flood, lightning beyond the arrestor's rating, or work done by others is not covered.",
    ].join("\n\n"), W - 2 * M);
    doc.text(terms, M, doc.lastAutoTable.finalY + 10);
    doc.setDrawColor(222, 219, 213).line(M, 282, W - M, 282);
    doc.setFontSize(8).text(`Issued ${fmtDate(today)} from Sun Power Localhost users. This is a computer-generated document.`, M, 287);
    return doc;
  }

  $("app").addEventListener("click", async (e) => {
    if (e.target.closest("#reportBtn")) return openReport();
    if (e.target.closest("#changePwBtn")) {
      lastPassword = ""; // changing it later always asks for the current password
      return showSetPassword("");
    }
    if (e.target.closest("#pwCancel")) return render();
    const b = e.target.closest("[data-card-pdf]");
    if (b) {
      const o = data.orders.find((x) => x.order_number === b.dataset.cardPdf);
      try {
        const doc = cardPdf(o);
        window.__pdf = doc.output("blob"); // tests read it
        doc.save(`Localhost-users-${data.customer.client_code || o.order_number}.pdf`);
      } catch (err) {
        toast("Couldn't make the PDF: " + err.message);
      }
    }
  });

  // ---------- Rating ----------
  $("app").addEventListener("submit", async (e) => {
    const f = e.target.closest("form[data-rate]");
    if (!f) return;
    e.preventDefault();
    const rating = Number(f.rating.value);
    if (!rating) return toast("Tap the stars to rate.");
    const btn = f.querySelector("button");
    btn.disabled = true;
    try {
      await call({ action: "rate", ticket_id: f.dataset.rate, rating, feedback: f.feedback.value });
      toast("Thank you for your feedback!");
      await load();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });

  // ---------- Report a problem ----------
  let files = [];

  function openReport() {
    const f = $("reportForm");
    f.reset();
    files = [];
    $("catList").innerHTML = CATEGORIES.map(([k, label, icon]) =>
      `<label class="cat"><input type="radio" name="category" value="${k}" required><span>${icon}</span> ${esc(label)}</label>`).join("");
    $("safetyNote").hidden = true;
    $("reportError").textContent = "";
    renderFiles();
    $("reportModal").hidden = false;
  }
  document.querySelectorAll("[data-close-report]").forEach((el) => el.addEventListener("click", () => ($("reportModal").hidden = true)));

  $("catList").addEventListener("change", (e) => {
    const urgent = ["safety", "water_leak", "tripping"].includes(e.target.value);
    $("safetyNote").hidden = !urgent;
    $("safetyNote").textContent = SAFETY;
  });

  function renderFiles() {
    $("reportPhotos").innerHTML = files.map((f, i) => `<figure><img src="${URL.createObjectURL(f)}" alt="Photo ${i + 1}">
      <button type="button" class="icon-btn" data-rm="${i}" aria-label="Remove photo">✕</button></figure>`).join("");
    $("reportPhotoAdd").hidden = files.length >= 4;
  }
  $("reportPhotoInput").addEventListener("change", async (e) => {
    for (const file of [...e.target.files].slice(0, 4 - files.length)) {
      try { files.push(await compress(file)); } catch { toast("Couldn't read that photo"); }
    }
    e.target.value = "";
    renderFiles();
  });
  $("reportPhotos").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    files.splice(Number(b.dataset.rm), 1);
    renderFiles();
  });

  // Shrink camera photos so they upload quickly on mobile data
  function compress(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read the photo"))), "image/jpeg", 0.82);
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => reject(new Error("Couldn't read the photo"));
      img.src = URL.createObjectURL(file);
    });
  }

  let sending = false; // a double tap must not create two requests
  $("reportForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending) return;
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    $("reportError").textContent = "";
    if (!f.category.value) return ($("reportError").textContent = "Choose what the problem is.");
    sending = true;
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const res = await call({ action: "create_ticket", category: f.category.value, description: f.description.value, photos: files.length });
      const uploaded = [];
      for (const [i, u] of (res.uploads || []).entries()) {
        const { error } = await sb.storage.from("service-photos").uploadToSignedUrl(u.path, u.token, files[i], { contentType: "image/jpeg" });
        if (!error) uploaded.push(u.path);
      }
      if (uploaded.length) await call({ action: "attach_photos", ticket_id: res.ticket.id, paths: uploaded });
      $("reportModal").hidden = true;
      toast(`Request ${res.ticket.ticket_number} sent. We'll reply on WhatsApp.`);
      await load();
    } catch (err) {
      $("reportError").textContent = err.message;
    } finally {
      sending = false;
      btn.disabled = false;
      btn.textContent = "Send to Sun Power";
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("reportModal").hidden = true;
  });

  load();
})();
