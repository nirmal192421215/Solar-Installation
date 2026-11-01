// Orders: accepted final quote → payments (receipts, UPI QR) → confirmed → packing → installation
(() => {
  const { sb, state, esc, toast, todayISO, fmtDay, fmtDateTime, relTime, openDrawer, staffName, registerView, viewOpen, loadTiles } = window.CRM;
  const $ = (id) => document.getElementById(id);

  // Supabase Edge Function that sends WhatsApp messages through Twilio (its name as deployed)
  const WHATSAPP_FUNCTION = "send-whatsapp";

  const ORDER_STATUS = {
    awaiting_payment: ["Awaiting payment", "o-wait"],
    confirmed: ["Confirmed", "o-confirmed"],
    packing: ["Packing", "o-packing"],
    packed: ["Packed", "o-packed"],
    dispatched: ["Dispatched", "o-dispatched"],
    installed: ["Installed", "o-installed"],
    completed: ["Completed", "o-done"],
    cancelled: ["Cancelled", "o-cancelled"],
  };
  const SYSTEM_TYPES = { on_grid: "On-grid", hybrid: "Hybrid (with battery)", off_grid: "Off-grid (battery)", panel_set: "Solar panel set" };
  const PAY_TYPES = { advance: "Advance", part: "Part payment", final: "Final payment", full: "Full payment", refund: "Refund" };
  const PAY_METHODS = { upi: "UPI", cash: "Cash", bank_transfer: "Bank transfer", card: "Card", cheque: "Cheque", razorpay_test: "Razorpay (test)" };

  const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
  const rs = (n) => "Rs. " + Math.round(Number(n) || 0).toLocaleString("en-IN"); // PDFs: the built-in font has no ₹
  const round2 = (n) => Math.round(n * 100) / 100;
  const one = (x) => (Array.isArray(x) ? x[0] : x) || null; // embedded one-to-one rows
  const badge = (status) => {
    const [label, cls] = ORDER_STATUS[status] || [status, ""];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  };
  const system = (o) => `${Number(o.system_size_kw) || ""} kW ${SYSTEM_TYPES[o.system_type] || o.system_type || ""}`.trim();

  let orders = [];
  let filter = "all";
  let search = "";
  let current = null; // { order, lead, items, payments, job, quote, log, serials }

  // The technician's checklist (same keys as public.install_checklist_keys)
  const CHECKLIST = {
    panels_mounted: "Panels mounted, structure bolted and level", dc_wiring: "DC wiring and MC4 connectors checked",
    inverter: "Inverter installed and powered on", earthing: "Earthing done and tested", lightning_arrestor: "Lightning arrestor installed",
    acdb_dcdb: "ACDB / DCDB connected", generation: "System generating power", handover: "Site cleaned; customer shown how it works",
  };

  // ---------- Orders screen ----------
  async function loadOrders() {
    const { data, error } = await sb.from("orders")
      .select("*, leads!orders_lead_id_fkey(name, client_code, location), install_jobs!install_jobs_order_id_fkey(scheduled_date, time_slot, status, crews(name))")
      .order("created_at", { ascending: false }).limit(1000);
    if (error) {
      orders = [];
      $("orderRows").innerHTML = "";
      $("orderTabs").innerHTML = "";
      $("ordersEmpty").hidden = false;
      $("ordersEmpty").textContent = "Orders aren't set up yet (run orders.sql).";
      return;
    }
    orders = data;
    renderOrders();
  }

  function renderOrders() {
    const q = search.toLowerCase();
    const base = orders.filter((o) => !q || [o.order_number, o.leads?.client_code, o.leads?.name].some((v) => (v || "").toLowerCase().includes(q)));
    const counts = {};
    base.forEach((o) => (counts[o.status] = (counts[o.status] || 0) + 1));
    $("orderTabs").innerHTML =
      `<button data-status="all" class="${filter === "all" ? "is-active" : ""}">All <em>${base.length}</em></button>` +
      Object.entries(ORDER_STATUS).map(([v, [label]]) =>
        `<button data-status="${v}" class="${filter === v ? "is-active" : ""}">${label} <em>${counts[v] || 0}</em></button>`).join("");

    const rows = filter === "all" ? base : base.filter((o) => o.status === filter);
    $("ordersEmpty").hidden = rows.length > 0;
    $("ordersEmpty").textContent = orders.length ? "No orders match these filters." : "No orders yet. They appear here when a customer accepts a final quote.";
    $("orderRows").innerHTML = rows.map((o) => {
      const job = one(o.install_jobs);
      return `<tr data-id="${o.id}">
        <td><span class="name">${esc(o.order_number)}</span><span class="sub">${esc(relTime(o.created_at))}</span></td>
        <td>${esc(o.leads?.name || "—")}${o.leads?.client_code ? `<span class="code">${esc(o.leads.client_code)}</span>` : ""}<span class="sub">${esc(o.leads?.location || "")}</span></td>
        <td>${esc(system(o))}</td>
        <td>${badge(o.status)}${o.stock_short && ["confirmed", "packing"].includes(o.status) ? `<span class="sub overdue">Stock short</span>` : ""}</td>
        <td>${esc(inr(o.amount_paid))} <span class="sub">of ${esc(inr(o.total))}${Number(o.balance) > 0 ? ` · due ${esc(inr(o.balance))}` : ""}</span></td>
        <td class="right">${job && job.status !== "cancelled" ? `<span class="when">${esc(fmtDay(job.scheduled_date))}</span><span class="sub">${esc(job.time_slot)} · ${esc(job.crews?.name || "no crew")}</span>` : `<span class="sub none">—</span>`}</td>
      </tr>`;
    }).join("");
  }

  $("orderTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-status]");
    if (!b) return;
    filter = b.dataset.status;
    renderOrders();
  });
  $("orderSearch").addEventListener("input", (e) => { search = e.target.value.trim(); renderOrders(); });
  $("ordersRefresh").addEventListener("click", async () => { await loadOrders(); toast("Orders refreshed"); });
  $("orderRows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openOrder(tr.dataset.id);
  });

  registerView("orders", async () => {
    if (state.viewFilter?.orders) {
      filter = state.viewFilter.orders;
      state.viewFilter = null;
    }
    await loadOrders();
  });

  // ---------- One order ----------
  async function openOrder(id) {
    const { data: o, error } = await sb.from("orders").select("*").eq("id", id).single();
    if (error) return toast("Couldn't open the order: " + error.message);
    const [{ data: l }, { data: items }, { data: payments }, { data: job }, { data: quote }, { data: log }, { data: serials }] = await Promise.all([
      sb.from("leads").select("*").eq("id", o.lead_id).single(),
      sb.from("order_items").select("*").eq("order_id", o.id).order("is_service").order("description"),
      sb.from("payments").select("*").eq("order_id", o.id).order("created_at"),
      sb.from("install_jobs").select("*, crews(name)").eq("order_id", o.id).maybeSingle(),
      sb.from("quotes").select("id, quote_number, pdf_path, accepted_at, accepted_via").eq("id", o.quote_id).maybeSingle(),
      sb.from("lead_activities").select("*").eq("lead_id", o.lead_id).ilike("body", `%${o.order_number}%`).order("created_at", { ascending: false }),
      sb.from("order_serials").select("order_item_id, serial_no").eq("order_id", o.id).order("scanned_at"),
    ]);
    await window.Quotes.loadSettings();
    current = { order: o, lead: l || {}, items: items || [], payments: payments || [], job, quote, log: log || [], serials: serials || [] };
    renderOrder();
    $("orderModal").hidden = false;
    loadInstallPhotos();
    // Tax invoice, costs & profit, subsidy (invoices.js / finance.js)
    window.Invoices?.section($("oInvoice"), {
      orderId: o.id, leadId: o.lead_id, canIssue: ["dispatched", "installed", "completed"].includes(o.status), onChange: afterChange,
    });
    window.Finance?.orderExtras(o);
  }

  // Advance first; after that, whatever is still owed
  function suggestedAmount(o) {
    const paid = Number(o.amount_paid) || 0;
    const left = paid < Number(o.advance_required) ? Number(o.advance_required) - paid : Number(o.balance);
    return round2(Math.max(0, left));
  }

  function payTypeFor(o, amount) {
    if (amount >= Number(o.balance) - 0.5) return Number(o.amount_paid) > 0 ? "final" : "full";
    return Number(o.amount_paid) > 0 ? "part" : "advance";
  }

  function renderOrder() {
    const { order: o, lead: l, items, payments, job, quote, log } = current;
    const goods = items.filter((i) => !i.is_service);
    const packed = goods.filter((i) => Number(i.packed_qty) >= Number(i.qty)).length;
    const due = suggestedAmount(o);
    $("oTitle").innerHTML = `${esc(o.order_number)} ${badge(o.status)}`;
    $("oMeta").textContent = [l.name, l.client_code, system(o), quote ? `from ${quote.quote_number}` : ""].filter(Boolean).join(" · ");

    $("oBody").innerHTML = `
      ${o.stock_short && ["confirmed", "packing"].includes(o.status) ? `<p class="quote-warn">Stock short: some items couldn't be reserved. Add stock in <b>Products</b>; the warehouse sees the shortage on the packing list.</p>` : ""}
      <div class="o-sum">
        <div><span>Total (incl. GST)</span><b>${esc(inr(o.total))}</b></div>
        <div><span>Paid</span><b>${esc(inr(o.amount_paid))}</b></div>
        <div><span>Balance</span><b class="${Number(o.balance) > 0 ? "due" : ""}">${esc(inr(o.balance))}</b></div>
        <div><span>Advance to confirm</span><b>${esc(inr(o.advance_required))}</b></div>
      </div>
      ${Number(o.subsidy) > 0 ? `<p class="muted">Subsidy ${esc(inr(o.subsidy))} (credited to customer later). It's information only: the customer pays us the full total.</p>` : ""}

      <h3 class="form-section">Payments</h3>
      <ol class="quotes" id="oPayments">${payments.length ? payments.map(paymentItem).join("") : `<li class="m-empty">No payments yet.</li>`}</ol>
      ${o.status === "cancelled" ? "" : `<form class="manage pay-form" id="payForm">
        <label><span>Amount received (₹)</span><input type="number" name="amount" min="1" step="0.01" value="${due || ""}" required></label>
        <label><span>Type</span><select name="type">${Object.entries(PAY_TYPES).map(([k, v]) => `<option value="${k}"${k === payTypeFor(o, due) ? " selected" : ""}>${v}</option>`).join("")}</select></label>
        <label><span>Method</span><select name="method">${Object.entries(PAY_METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label><span>Reference (UTR / txn ID / cheque no)</span><input name="reference" autocomplete="off" placeholder="needed unless cash"></label>
        <label><span>Paid on</span><input type="date" name="paid_on" value="${todayISO()}" max="${todayISO()}" required></label>
        <label><span>Notes</span><input name="notes"></label>
        <div class="form-foot span-2">
          <button type="submit" class="btn btn--primary btn--sm">Record payment</button>
          <button type="button" class="btn btn--ghost btn--sm" data-o="qr">UPI payment QR</button>
        </div>
        <div class="pay-qr span-2" id="payQr" hidden></div>
      </form>`}

      <h3 class="form-section">Items${goods.length ? ` <small class="muted">· packed ${packed} / ${goods.length}</small>` : ""}</h3>
      <div class="table-wrap"><table class="bom">
        <thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Unit price</th><th class="right">Amount</th><th class="right">Packed</th></tr></thead>
        <tbody>${items.map((i) => `<tr>
          <td>${esc(i.description)}${i.sku ? `<small class="bom-sku">${esc(i.sku)}</small>` : ""}${serialsOf(i).length ? `<small class="bom-sku">S/N ${esc(serialsOf(i).join(", "))}</small>` : ""}</td>
          <td class="right">${esc(i.qty)} ${esc(i.unit || "")}</td>
          <td class="right">${i.unit_price !== null ? esc(inr(i.unit_price)) : ""}</td>
          <td class="right">${esc(inr(i.amount))}</td>
          <td class="right">${i.is_service ? `<span class="muted">service</span>` : `${esc(i.packed_qty)} / ${esc(i.qty)}${Number(i.reserved_qty) < Number(i.qty) && ["confirmed", "packing"].includes(o.status) ? ` <span class="overdue">short</span>` : ""}`}</td>
        </tr>`).join("")}</tbody>
      </table></div>

      ${o.dispatched_at ? `<h3 class="form-section">Dispatch</h3>
      <p class="m-meta">Dispatched ${esc(fmtDateTime(o.dispatched_at))}${o.dispatch_vehicle ? ` · vehicle ${esc(o.dispatch_vehicle)}` : ""}${o.dispatch_driver ? ` · driver ${esc(o.dispatch_driver)}` : ""}${o.dispatched_by ? ` · by ${esc(staffName(o.dispatched_by))}` : ""}</p>
      <p class="m-meta">${o.delivered_at ? `<b>Delivered ${esc(fmtDateTime(o.delivered_at))}</b>: warranty started for every serial number`
        : `Not delivered yet (the warranty clock starts on delivery) <button type="button" class="btn btn--ghost btn--sm" data-o="delivered">Mark delivered</button>`}</p>` : ""}

      <h3 class="form-section">Installation</h3>
      ${installSection(o, job)}

      <div id="oInvoice"></div>
      <div id="oCosts"></div>
      <div id="oSubsidy"></div>

      <h3 class="form-section">Timeline</h3>
      <ol class="timeline">${log.length ? log.map((a) => `<li class="t-${esc(a.type)}">
          <div class="t-head"><span>${esc(a.created_by || "system")}</span><span>${esc(new Date(a.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</span></div>
          <div class="t-body">${esc(a.body)}</div></li>`).join("") : `<li class="t-empty">Nothing yet.</li>`}</ol>

      <div class="m-actions">
        <button type="button" class="btn btn--ghost btn--sm" data-o="lead">Open lead</button>
        ${quote?.pdf_path ? `<button type="button" class="btn btn--ghost btn--sm" data-o="quote-pdf">Quotation PDF</button>` : ""}
        ${state.isManager && ["awaiting_payment", "confirmed", "packing", "packed"].includes(o.status) ? `<button type="button" class="danger-link" data-o="cancel">Cancel order</button>` : ""}
      </div>`;

    const f = $("payForm");
    if (f) {
      f.addEventListener("submit", (e) => { e.preventDefault(); recordPayment(f); });
      f.amount.addEventListener("input", () => {
        if (f.type.value !== "refund") f.type.value = payTypeFor(current.order, Number(f.amount.value) || 0);
        if (!$("payQr").hidden) showQr();
      });
    }
  }

  const serialsOf = (i) => (current?.serials || []).filter((s) => s.order_item_id === i.id).map((s) => s.serial_no);

  function installSection(o, job) {
    if (!job || job.status === "cancelled") {
      return `<p class="muted">${o.status === "awaiting_payment" ? "Booked automatically as soon as the advance is paid." : "Not scheduled."}</p>`;
    }
    const ticked = Object.keys(CHECKLIST).filter((k) => job.checklist?.[k] === true).length;
    const crew = job.crews?.name || "no crew";
    if (job.status === "done") {
      return `<p class="m-meta"><b>Installed ${esc(fmtDateTime(job.finished_at))}</b> by ${esc(crew)} · started ${esc(fmtDateTime(job.started_at))}
          · generation at handover <b>${esc(job.generation_kwh)} kWh</b> · checklist ${ticked}/${Object.keys(CHECKLIST).length} · signed by <b>${esc(job.signed_by_name || "")}</b></p>
        ${job.install_notes ? `<p class="m-text">${esc(job.install_notes)}</p>` : ""}
        <div class="photos" id="oPhotos"></div>
        <div class="m-actions"><button type="button" class="btn btn--primary btn--sm" data-o="certificate">Completion certificate (PDF)</button></div>`;
    }
    if (job.status === "in_progress") {
      return `<p class="m-meta"><b>In progress</b> since ${esc(fmtDateTime(job.started_at))} · ${esc(crew)} · checklist ${ticked}/${Object.keys(CHECKLIST).length} · ${(job.photos || []).length} photo(s)</p>
        <div class="photos" id="oPhotos"></div>`;
    }
    return `<div class="m-actions"><span><b>${esc(fmtDay(job.scheduled_date))}</b> · ${esc(job.time_slot)} · ${esc(crew)} · ${esc(job.status.replace(/_/g, " "))}</span>
        <button type="button" class="btn btn--ghost btn--sm" data-o="reschedule">Reschedule</button></div>
      ${o.status === "dispatched" ? "" : `<p class="muted">The crew can start once the warehouse has dispatched the order.</p>`}`;
  }

  // Installation photos and the customer's signature (private bucket, short-lived links)
  async function loadInstallPhotos() {
    const job = current?.job;
    const box = $("oPhotos");
    if (!box || !job) return;
    const paths = [...(job.photos || []), ...(job.signature_path ? [job.signature_path] : [])];
    if (!paths.length) return;
    const { data } = await sb.storage.from("install-photos").createSignedUrls(paths, 3600);
    // Photo files start with their slot: "<job id>/<slot>-<random>.jpg"
    const SLOT = { before: "Before work", panels: "Panels & structure", inverter: "Inverter", earthing: "Earthing pit", acdb: "ACDB / DCDB", meter: "Meter", after: "After work" };
    box.innerHTML = (data || []).map((p, i) => {
      const caption = p.path === job.signature_path ? "Customer signature" : SLOT[(p.path.split("/")[1] || "").split("-")[0]] || `Photo ${i + 1}`;
      return `<figure${p.path === job.signature_path ? ` class="sig"` : ""}>
        <a href="${esc(p.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(p.signedUrl)}" alt="${esc(caption)}" loading="lazy"></a>
        <figcaption>${esc(caption)}</figcaption>
      </figure>`;
    }).join("");
  }

  function paymentItem(p) {
    return `<li data-pay="${p.id}">
      <div class="m-head"><span class="m-title">${esc(inr(p.amount))} · ${esc(PAY_TYPES[p.type] || p.type)}</span><span>${esc(p.receipt_number)}</span></div>
      <div class="m-meta">${esc(PAY_METHODS[p.method] || p.method)}${p.reference ? ` · ref ${esc(p.reference)}` : ""} · ${esc(fmtDay(p.paid_on))}${p.received_by ? ` · recorded by ${esc(staffName(p.received_by))}` : ""}</div>
      <div class="m-actions">
        <button type="button" class="btn btn--ghost btn--sm" data-p="pdf">Receipt PDF</button>
        <button type="button" class="btn btn--primary btn--sm" data-p="send">Send receipt on WhatsApp</button>
      </div>
    </li>`;
  }

  // ---------- Recording a payment ----------
  let saving = false; // stops a double click recording the same payment twice

  async function recordPayment(f) {
    if (saving) return;
    const o = current.order;
    const btn = f.querySelector('button[type="submit"]');
    const amount = round2(Number(f.amount.value) || 0);
    const reference = f.reference.value.trim();
    if (!(amount > 0)) return toast("Enter the amount received.");
    if (f.type.value !== "refund" && amount > Number(o.balance) + 0.5) return toast(`That's more than the balance (${inr(o.balance)}).`);
    if (f.method.value !== "cash" && !reference) return toast("Enter the payment reference (UTR / transaction ID / cheque number).");
    if (current.payments.some((p) => reference && (p.reference || "").toLowerCase() === reference.toLowerCase())) {
      return toast(`Reference ${reference} is already recorded on this order.`);
    }

    saving = true;
    btn.disabled = true;
    btn.textContent = "Saving…";
    const before = o.status;
    try {
      const { data: p, error } = await sb.from("payments").insert({
        order_id: o.id, amount, type: f.type.value, method: f.method.value, reference: reference || null,
        paid_on: f.paid_on.value || todayISO(), notes: f.notes.value.trim() || null,
      }).select().single();
      if (error) {
        throw new Error(/payments_order_reference_idx|duplicate key/i.test(error.message)
          ? `Reference ${reference} is already recorded on this order.` : error.message);
      }
      await openOrder(o.id); // amount paid and status are updated by the database
      let receipt = "";
      try {
        await makeReceipt(current.payments.find((x) => x.id === p.id) || p);
        receipt = ` · receipt ${p.receipt_number}`;
      } catch (err) {
        receipt = ` (receipt PDF failed: ${err.message || err})`;
      }
      const confirmed = before === "awaiting_payment" && current.order.status !== "awaiting_payment";
      toast(`Payment of ${inr(amount)} recorded${receipt}${confirmed ? ". Order confirmed: packing list and installation booked" : ""}`);
      renderOrder();
      afterChange();
    } catch (err) {
      toast("Couldn't record the payment: " + (err.message || err));
      btn.disabled = false;
      btn.textContent = "Record payment";
    } finally {
      saving = false;
    }
  }

  // Lists and the lead page behind the order show the new state
  function afterChange() {
    if (viewOpen("orders")) loadOrders();
    if (state.current?.id === current.order.lead_id) {
      renderLead(state.current);
      window.CRM.loadActivity(state.current.id);
    }
    loadTiles();
  }

  // ---------- UPI payment link + QR (no gateway: the customer pays from any UPI app) ----------
  function upiLink(amount) {
    const upi = String(window.Quotes.getSettings().upi_id || "").trim();
    if (!upi) return null;
    return `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent("Sun Power Solar")}&am=${amount.toFixed(2)}&tn=${encodeURIComponent(current.order.order_number)}&cu=INR`;
  }

  function qrSvg(text) {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: "UPI payment QR code" });
  }

  function showQr() {
    const f = $("payForm");
    const amount = round2(Number(f.amount.value) || 0);
    const link = amount > 0 ? upiLink(amount) : null;
    const box = $("payQr");
    box.hidden = false;
    if (!link) {
      box.innerHTML = `<p class="quote-warn">${amount > 0 ? "Add your UPI ID in <b>Quote settings → Orders &amp; payments</b> first." : "Enter the amount first."}</p>`;
      return;
    }
    const l = current.lead;
    const message = [
      `Hello ${(l.name || "").split(/\s+/)[0] || "there"}, this is Sun Power Solar Solutions.`,
      `Please pay ${inr(amount)} for order ${current.order.order_number} by UPI:`,
      `UPI ID: ${window.Quotes.getSettings().upi_id}`,
      link,
      `Please mention ${current.order.order_number} in the payment note. Thank you!`,
    ].join("\n");
    box.innerHTML = `<div class="qr">${qrSvg(link)}</div>
      <div class="qr-info">
        <b>Scan to pay ${esc(inr(amount))}</b>
        <p class="muted">Any UPI app · to ${esc(window.Quotes.getSettings().upi_id)} · note ${esc(current.order.order_number)}</p>
        <div class="m-actions">
          <a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="https://wa.me/${esc(String(l.phone || "").replace(/\D/g, ""))}?text=${esc(encodeURIComponent(message))}">Send link in WhatsApp</a>
          <button type="button" class="btn btn--ghost btn--sm" data-o="copy-link">Copy link</button>
        </div>
      </div>`;
    box.dataset.link = link;
  }

  // ---------- Receipt PDF ----------
  function drawQr(doc, text, x, y, size) {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const cell = size / n;
    doc.setFillColor(0, 0, 0);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) doc.rect(x + c * cell, y + r * cell, cell + 0.03, cell + 0.03, "F");
    }
  }

  function buildReceipt(p) {
    const { order: o, lead: l, payments, quote } = current;
    const settings = window.Quotes.getSettings();
    const P = window.Quotes.pdf;
    const { W, M, orange, navy, muted } = P;
    const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    P.header(doc);

    // Paid up to and including this receipt, so a re-printed receipt still shows the figures of that day
    const upto = payments.filter((x) => x.created_at <= p.created_at);
    if (!upto.some((x) => x.id === p.id)) upto.push(p);
    const paidToDate = upto.reduce((a, x) => a + (x.type === "refund" ? -1 : 1) * Number(x.amount), 0);
    const balance = Math.max(0, Number(o.total) - paidToDate);

    let y = 46;
    doc.setTextColor(...navy).setFont("helvetica", "bold").setFontSize(20).text(p.type === "refund" ? "REFUND RECEIPT" : "PAYMENT RECEIPT", M, y);
    doc.setFontSize(9).setFont("helvetica", "normal").setTextColor(...muted);
    doc.text(`Receipt no: ${p.receipt_number}`, W - M, y - 7, { align: "right" });
    doc.text(`Date: ${P.date(p.paid_on + "T00:00:00")}`, W - M, y - 2.5, { align: "right" });
    doc.text(`Order no: ${o.order_number}`, W - M, y + 2, { align: "right" });

    y += 9;
    const half = (W - 2 * M - 6) / 2;
    const col2 = M + half + 6;
    doc.setDrawColor(230, 225, 218).setFillColor(248, 246, 242);
    doc.roundedRect(M, y, half, 28, 2, 2, "FD");
    doc.roundedRect(col2, y, half, 28, 2, 2, "FD");
    doc.setTextColor(...orange).setFont("helvetica", "bold").setFontSize(8).text("RECEIVED FROM", M + 5, y + 6);
    doc.text("FOR ORDER", col2 + 5, y + 6);
    doc.setTextColor(...navy).setFontSize(11).text(l.name || "", M + 5, y + 12.5);
    doc.text(o.order_number, col2 + 5, y + 12.5);
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(60, 60, 60);
    doc.text([l.client_code ? `Client ID ${l.client_code}` : "", l.phone, l.location].filter(Boolean), M + 5, y + 18);
    doc.text([`${system(o)} rooftop solar`, quote?.quote_number ? `Quotation ${quote.quote_number}` : ""].filter(Boolean), col2 + 5, y + 18);

    y += 36;
    doc.autoTable({
      startY: y, margin: { left: M, right: M },
      head: [["Description", "Amount"]],
      body: [[`${PAY_TYPES[p.type] || p.type} received by ${PAY_METHODS[p.method] || p.method}${p.reference ? ` (ref ${p.reference})` : ""}${p.notes ? `\n${p.notes}` : ""}`, rs(p.amount)]],
      foot: [
        ["Order total (incl. GST)", rs(o.total)],
        ["Paid to date (including this receipt)", rs(paidToDate)],
        ["Balance due", rs(balance)],
      ],
      theme: "grid",
      styles: { font: "helvetica", fontSize: 9.5, cellPadding: 3, lineColor: [230, 225, 218] },
      headStyles: { fillColor: navy, textColor: 255 },
      footStyles: { fillColor: [248, 246, 242], textColor: navy, fontStyle: "bold" },
      columnStyles: { 1: { cellWidth: 45, halign: "right" } },
      didParseCell: (d) => {
        if (d.section === "foot" && d.column.index === 1) d.cell.styles.halign = "right";
        if (d.section === "foot" && /Balance/.test(d.row.raw[0])) d.cell.styles.textColor = orange;
      },
    });
    y = doc.lastAutoTable.finalY + 6;

    if (Number(o.subsidy) > 0) {
      doc.setFontSize(8).setTextColor(...muted).text(
        `Govt. subsidy of ${rs(o.subsidy)} (PM Surya Ghar) is credited by the Government to the customer's bank account after installation. It is not deducted from the amount payable to Sun Power.`,
        M, y, { maxWidth: W - 2 * M });
      y += 10;
    }

    // How to pay the balance: UPI QR for the exact amount, and bank details
    const link = balance > 0 && settings.upi_id
      ? `upi://pay?pa=${encodeURIComponent(settings.upi_id)}&pn=${encodeURIComponent("Sun Power Solar")}&am=${balance.toFixed(2)}&tn=${encodeURIComponent(o.order_number)}&cu=INR`
      : null;
    if (balance > 0 && (link || settings.bank_details)) {
      doc.setTextColor(...orange).setFont("helvetica", "bold").setFontSize(9).text("HOW TO PAY THE BALANCE", M, y + 3);
      doc.setTextColor(60, 60, 60).setFont("helvetica", "normal").setFontSize(9);
      let ty = y + 9;
      if (link) {
        drawQr(doc, link, M, ty - 3, 32);
        doc.text([`Scan with any UPI app to pay ${rs(balance)}`, `UPI ID: ${settings.upi_id}`, `Payment note: ${o.order_number}`], M + 38, ty + 2);
      }
      if (settings.bank_details) {
        const bx = link ? M + 110 : M;
        doc.setFont("helvetica", "bold").text("Bank transfer", bx, ty + 2);
        doc.setFont("helvetica", "normal").text(doc.splitTextToSize(String(settings.bank_details), W - M - bx), bx, ty + 7);
      }
      y = ty + 36;
    }

    // Signatures
    y = Math.max(y + 6, 245);
    doc.setDrawColor(...muted);
    doc.line(M, y, M + 70, y);
    doc.line(W - M - 70, y, W - M, y);
    doc.setFontSize(8.5).setTextColor(...muted);
    doc.text(`Received by: ${staffName(p.received_by) || ""}`, M, y + 5);
    doc.text("Authorised signatory, Sun Power Solar Solutions", W - M, y + 5, { align: "right" });
    doc.setFontSize(7.5).text("This is a computer-generated receipt.", M, y + 12);

    P.footer(doc);
    return doc;
  }

  // ---------- Installation certificate PDF ----------
  async function imageData(bucket, path) {
    const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 300);
    if (error) throw error;
    const blob = await (await fetch(data.signedUrl)).blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
  }

  async function buildCertificate() {
    const { order: o, lead: l, items, job } = current;
    const settings = window.Quotes.getSettings();
    const P = window.Quotes.pdf;
    const { W, M, orange, navy, muted } = P;
    const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    P.header(doc);

    let y = 46;
    doc.setTextColor(...navy).setFont("helvetica", "bold").setFontSize(19).text("INSTALLATION CERTIFICATE", M, y);
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...muted).text("Installation & commissioning of a rooftop solar power system", M, y + 5);
    doc.setFontSize(9);
    doc.text(`Certificate no: ${o.order_number}-IC`, W - M, y - 7, { align: "right" });
    doc.text(`Installed on: ${P.date(job.finished_at)}`, W - M, y - 2.5, { align: "right" });
    doc.text(`Order no: ${o.order_number}`, W - M, y + 2, { align: "right" });

    y += 9;
    const half = (W - 2 * M - 6) / 2;
    const col2 = M + half + 6;
    doc.setDrawColor(230, 225, 218).setFillColor(248, 246, 242);
    doc.roundedRect(M, y, half, 28, 2, 2, "FD");
    doc.roundedRect(col2, y, half, 28, 2, 2, "FD");
    doc.setTextColor(...orange).setFont("helvetica", "bold").setFontSize(8).text("CUSTOMER & SITE", M + 5, y + 6);
    doc.text("SYSTEM", col2 + 5, y + 6);
    doc.setTextColor(...navy).setFontSize(11).text(l.name || "", M + 5, y + 12.5);
    doc.text(`${system(o)}`, col2 + 5, y + 12.5);
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(60, 60, 60);
    doc.text([l.client_code ? `Client ID ${l.client_code}` : "", l.location || ""].filter(Boolean), M + 5, y + 18);
    doc.text([`Installed by ${job.crews?.name || "our crew"}`, `Generation at handover: ${job.generation_kwh} kWh`], col2 + 5, y + 18);

    // Equipment with serial numbers
    doc.autoTable({
      startY: y + 36, margin: { left: M, right: M },
      head: [["Equipment installed", "Qty", "Serial numbers"]],
      body: items.filter((i) => !i.is_service).map((i) => [i.description, `${i.qty} ${i.unit || ""}`.trim(), serialsOf(i).join(", ")]),
      theme: "grid",
      styles: { font: "helvetica", fontSize: 9, cellPadding: 1.7, lineColor: [230, 225, 218] },
      headStyles: { fillColor: navy, textColor: 255 },
      columnStyles: { 1: { cellWidth: 22, halign: "right" }, 2: { cellWidth: 55 } },
    });

    // Checklist
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 5, margin: { left: M, right: M },
      head: [["Commissioning checklist", "Status"]],
      body: Object.entries(CHECKLIST).map(([k, label]) => [label, job.checklist?.[k] ? "Done" : "-"]),
      theme: "plain",
      styles: { fontSize: 9, cellPadding: { top: 0.7, bottom: 0.7, left: 2, right: 2 } },
      headStyles: { textColor: orange, fontStyle: "bold" },
      columnStyles: { 1: { cellWidth: 22, textColor: [27, 127, 59], fontStyle: "bold" } },
    });
    y = doc.lastAutoTable.finalY + 4;

    const warranty = [["Panel warranty", settings.warranty_panel], ["Inverter warranty", settings.warranty_inverter],
      ["Installation warranty", settings.warranty_installation]].filter(([, v]) => v);
    if (warranty.length) {
      doc.autoTable({
        startY: y, margin: { left: M, right: M }, head: [["Warranty", ""]], body: warranty, theme: "plain",
        styles: { fontSize: 9, cellPadding: { top: 0.7, bottom: 0.7, left: 2, right: 2 } },
        headStyles: { textColor: orange, fontStyle: "bold" }, columnStyles: { 0: { cellWidth: 50, textColor: muted } },
      });
      y = doc.lastAutoTable.finalY + 4;
    }
    if (job.install_notes) {
      const notes = doc.splitTextToSize(`Notes: ${job.install_notes}`, W - 2 * M);
      doc.setFontSize(8.5).setTextColor(60, 60, 60).text(notes, M, y + 2);
      y += 2 + notes.length * 4;
    }

    doc.setFontSize(8).setTextColor(...muted).text("The customer confirms the system above was installed, switched on and explained to them.", M, y + 3);
    y += 5;

    // Signatures (the signature image sits just above the line; the footer band starts at 287 mm)
    let sy = Math.max(y + 20, 240);
    if (sy > 280) { doc.addPage(); sy = 40; }
    if (job.signature_path) {
      try {
        doc.addImage(await imageData("install-photos", job.signature_path), "PNG", M, sy - 18, 54, 16);
      } catch {
        // the line below still shows who signed
      }
    }
    doc.setDrawColor(...muted);
    doc.line(M, sy, M + 70, sy);
    doc.line(W - M - 70, sy, W - M, sy);
    doc.setFontSize(8.5).setTextColor(...muted);
    doc.text(`Customer: ${job.signed_by_name || ""}`, M, sy + 5);
    doc.text("For Sun Power Solar Solutions", W - M, sy + 5, { align: "right" });

    P.footer(doc);
    return doc;
  }

  async function makeReceipt(p) {
    const doc = buildReceipt(p);
    const path = `${current.order.lead_id}/${p.receipt_number}.pdf`;
    const up = await sb.storage.from("receipts").upload(path, doc.output("blob"), { contentType: "application/pdf", upsert: true });
    if (up.error) throw up.error;
    const { error } = await sb.from("payments").update({ receipt_pdf_path: path }).eq("id", p.id);
    if (error) throw error;
    p.receipt_pdf_path = path;
    return path;
  }

  // ---------- Buttons inside the order ----------
  $("oBody").addEventListener("click", async (e) => {
    const pb = e.target.closest("button[data-p]");
    if (pb) return paymentAction(pb);
    const b = e.target.closest("button[data-o]");
    if (!b || !current) return;
    const o = current.order;
    const act = b.dataset.o;

    if (act === "qr") return showQr();
    if (act === "copy-link") {
      try {
        await navigator.clipboard.writeText($("payQr").dataset.link);
        toast("Payment link copied");
      } catch {
        toast("Couldn't copy. Long-press the QR instead.");
      }
      return;
    }
    if (act === "lead") {
      $("orderModal").hidden = true;
      await openDrawer(o.lead_id);
      return window.CRM.showPane("deal");
    }
    if (act === "quote-pdf") {
      const tab = window.open("about:blank", "_blank");
      const { data, error } = await sb.storage.from("quotes").createSignedUrl(current.quote.pdf_path, 3600);
      if (error) { tab?.close(); return toast("Couldn't open the PDF: " + error.message); }
      if (tab) tab.location.href = data.signedUrl; else window.location.href = data.signedUrl;
      return;
    }
    if (act === "reschedule") return window.Schedule?.openJob(current.job.id, () => openOrder(o.id));
    if (act === "delivered") {
      if (!confirm(`Mark ${o.order_number} as delivered at the customer's site now? Every serial number's warranty starts today.`)) return;
      const { error } = await sb.rpc("mark_delivered", { p_order_id: o.id });
      if (error) return toast(error.message);
      toast("Delivered: warranty started");
      return openOrder(o.id);
    }
    if (act === "certificate") {
      b.disabled = true;
      try {
        (await buildCertificate()).save(`${o.order_number}-installation-certificate.pdf`);
      } catch (err) {
        toast("Couldn't make the certificate: " + (err.message || err));
      } finally {
        b.disabled = false;
      }
      return;
    }
    if (act === "cancel") {
      const reason = prompt(`Cancel order ${o.order_number}? Reserved stock goes back to the shelf and the installation is cancelled.\n\nReason:`);
      if (reason === null) return;
      if (!reason.trim()) return toast("Give a reason to cancel the order.");
      const { error } = await sb.from("orders").update({
        status: "cancelled", notes: [o.notes, `Cancelled: ${reason.trim()}`].filter(Boolean).join("\n"),
      }).eq("id", o.id);
      if (error) return toast("Couldn't cancel: " + error.message);
      await sb.from("lead_activities").insert({
        lead_id: o.lead_id, type: "note", created_by: state.me.email, body: `Order ${o.order_number} cancelled: ${reason.trim()}`,
      });
      toast("Order cancelled; stock unreserved");
      await openOrder(o.id);
      afterChange();
    }
  });

  async function paymentAction(btn) {
    const p = current.payments.find((x) => x.id === btn.closest("li[data-pay]").dataset.pay);
    if (!p) return;
    // Open the tab during the click itself, or the browser's pop-up blocker stops it after the await
    const tab = btn.dataset.p === "pdf" ? window.open("about:blank", "_blank") : null;
    btn.disabled = true;
    try {
      if (!p.receipt_pdf_path) await makeReceipt(p);
      if (btn.dataset.p === "pdf") {
        const { data, error } = await sb.storage.from("receipts").createSignedUrl(p.receipt_pdf_path, 3600);
        if (error) throw error;
        if (tab) tab.location.href = data.signedUrl; else window.location.href = data.signedUrl;
      } else {
        const { error } = await sb.functions.invoke(WHATSAPP_FUNCTION, { body: { kind: "receipt", lead_id: current.order.lead_id, payment_id: p.id } });
        if (error) {
          let msg = error.message;
          try { msg = (await error.context.json()).error || msg; } catch {}
          throw new Error(msg);
        }
        toast("Receipt sent on WhatsApp ✓");
        afterChange();
      }
    } catch (err) {
      tab?.close();
      toast("Couldn't do that: " + (err.message || err));
    } finally {
      btn.disabled = false;
    }
  }

  document.querySelectorAll("[data-close-order]").forEach((el) => el.addEventListener("click", () => {
    $("orderModal").hidden = true;
    if (viewOpen("orders")) loadOrders();
  }));

  // ---------- Lead page: this lead's order ----------
  async function renderLead(l) {
    const { data, error } = await sb.from("orders").select("*").eq("lead_id", l.id).order("created_at", { ascending: false });
    $("leadOrderBlock").hidden = Boolean(error) || !data.length;
    if (error) return;
    $("leadOrders").innerHTML = data.map((o) => `<li data-order="${o.id}">
        <div class="m-head"><span class="m-title">${esc(o.order_number)} · ${esc(system(o))}</span>${badge(o.status)}</div>
        <div class="m-meta">Paid ${esc(inr(o.amount_paid))} of ${esc(inr(o.total))} · balance ${esc(inr(o.balance))}${o.status === "awaiting_payment" ? ` · advance due ${esc(inr(Math.max(0, o.advance_required - o.amount_paid)))}` : ""}</div>
        <div class="m-actions"><button type="button" class="btn btn--primary btn--sm" data-open-order>${o.status === "awaiting_payment" ? "Record payment" : "Open order"}</button></div>
      </li>`).join("");
  }
  $("leadOrders").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-open-order]");
    if (b) openOrder(b.closest("li").dataset.order);
  });

  // New orders and payments show up without a reload
  setInterval(() => {
    if (viewOpen("orders") && $("orderModal").hidden) loadOrders();
  }, 30000);

  window.Orders = { openOrder, renderLead, ORDER_STATUS };
})();
