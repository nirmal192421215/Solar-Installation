// Quotations: check details → ask missing on WhatsApp → build quote → PDF → send via click-to-chat
(() => {
  const { sb, state, esc, toast, todayISO, updateLead, loadActivity, refreshLead } = window.CRM;
  const $ = (id) => document.getElementById(id);

  // Supabase Edge Function that sends WhatsApp messages through Twilio (its name as deployed)
  const WHATSAPP_FUNCTION = "send-whatsapp";

  const COMPANY = "Sun Power Solar Solutions";
  const COMPANY_PHONE = "+91 93426 26096";
  const COMPANY_ADDRESS = "No 2B, Sri Laxmi Nagar Colony Rd, West Hanuman Nagar, Boduppal, Hyderabad, Telangana 500092";
  const UNITS_PER_KW_MONTH = 120;
  const TARIFF = 8; // ₹ per unit, for the savings estimate

  const SYSTEM_TYPES = { on_grid: "On-grid", hybrid: "Hybrid (with battery)", off_grid: "Off-grid (battery)" };
  const STAGE_RANK = { new: 0, ai_called: 1, interested: 2, survey_booked: 3, quote_sent: 4 };

  // Suggested starting values, pre-filled into empty fields of Quote settings for review.
  // Typical Hyderabad residential market figures; the owner should adjust them to their real costs.
  const SUGGESTED = {
    price_on_grid: "50000",
    price_hybrid: "75000",
    price_off_grid: "80000",
    gst_percent: "8.9", // effective rate for rooftop solar EPC (70% goods @ 5% + 30% services @ 18%)
    prices_include_gst: "false",
    validity_days: "15",
    net_metering_charges: "0",
    apply_subsidy: true,
    panel: "540 Wp Mono PERC / TOPCon, Tier-1, ALMM-listed",
    inverter: "On-grid string inverter, BIS-certified, sized to the system",
    battery: "Lithium-ion (LFP) battery, capacity as per backup load",
    structure: "Hot-dip galvanised steel structure, wind-rated",
    bos: "DC/AC cables, ACDB/DCDB with surge protection, earthing, lightning arrestor",
    warranty_panel: "25-year performance warranty (manufacturer)",
    warranty_inverter: "5 years (manufacturer)",
    warranty_installation: "5 years workmanship",
    payment_terms: "50% advance with order, 40% on delivery of material, 10% after installation and commissioning",
    notes: "Installation within 15 days of advance and site readiness. Subsidy is subject to PM Surya Ghar scheme rules and DISCOM approval.",
    phone: COMPANY_PHONE,
    address: COMPANY_ADDRESS,
  };

  let settings = {};
  let lead = null;

  const rs = (n) => "Rs. " + Math.round(Number(n) || 0).toLocaleString("en-IN");
  const isHome = (l) => /home|house|villa|apartment|flat|independent|residential|bungalow/i.test(l.property_type || "");
  const firstName = (l) => (l.name || "").trim().split(/\s+/)[0] || "there";

  // ---------- Reading what we know about the lead ----------
  function systemTypeKey(text) {
    const t = (text || "").toLowerCase();
    if (/hybrid/.test(t)) return "hybrid";
    if (/off[\s-]?grid|battery/.test(t)) return "off_grid";
    if (/on[\s-]?grid|grid[\s-]?tied|net[\s-]?meter/.test(t)) return "on_grid";
    return null;
  }

  function billAmount(text) {
    const nums = (text || "").replace(/,/g, "").match(/\d+(\.\d+)?/g)?.map(Number).filter((n) => n >= 100) ?? [];
    if (/thousand/i.test(text || "") && !nums.length) return null;
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  }

  function sizeFromLead(l) {
    const kw = parseFloat(String(l.system_size || "").replace(/[^\d.]/g, ""));
    if (kw > 0) return kw;
    const bill = billAmount(l.monthly_bill);
    return bill ? Math.max(1, Math.round((bill / TARIFF / UNITS_PER_KW_MONTH) * 2) / 2) : null;
  }

  // Details a quote needs, with the WhatsApp question to ask when missing
  function missingDetails(l) {
    const checks = [
      ["Property type", !l.property_type || /not specified/i.test(l.property_type),
        "Is it an independent house, apartment, shop or factory?"],
      ["Owns property", !l.owns_property || /unknown/i.test(l.owns_property),
        "Do you own the property? (If it's rented, we'll need the owner's permission.)"],
      ["Roof type", !l.roof_type, "Is the roof concrete (RCC), metal sheet or tiled?"],
      ["Roof area", !l.roof_area, "Roughly how much free, shade-free roof space is there (in sq ft)?"],
      ["Monthly bill", !billAmount(l.monthly_bill), "What is your average monthly electricity bill (₹)?"],
      ["System type", !systemTypeKey(l.system_type),
        "Would you like on-grid (lowest cost, no battery) or battery backup for power cuts?"],
    ];
    if (isHome(l)) {
      checks.push(["Subsidy", !l.wants_subsidy || /not specified/i.test(l.wants_subsidy),
        "Would you like us to apply for the PM Surya Ghar subsidy (up to ₹78,000) for you?"]);
    }
    return checks.filter(([, missing]) => missing).map(([label, , question]) => ({ label, question }));
  }

  // ---------- Prices ----------
  function priceFor(type) {
    return Number(settings[`price_${type}`]) || 0;
  }

  function subsidyFor(kw) {
    return Math.min(kw, 2) * 30000 + Math.max(0, Math.min(kw - 2, 1)) * 18000;
  }

  function calculate({ kw, type, discount, subsidyOverride }) {
    const items = [
      { description: `${kw} kW ${SYSTEM_TYPES[type]} rooftop solar system: supply, installation & commissioning`, amount: priceFor(type) * kw },
    ];
    const netMetering = Number(settings.net_metering_charges) || 0;
    if (netMetering && type !== "off_grid") items.push({ description: "Net metering & DISCOM approval charges", amount: netMetering });
    const other = Number(settings.other_charges) || 0;
    if (other) items.push({ description: settings.other_charges_label || "Other charges", amount: other });
    if (discount > 0) items.push({ description: "Discount", amount: -discount });

    const sum = items.reduce((a, i) => a + i.amount, 0);
    const gstRate = (Number(settings.gst_percent) || 0) / 100;
    let subtotal, gst, total;
    if (settings.prices_include_gst === "true" || settings.prices_include_gst === true) {
      total = sum;
      subtotal = gstRate ? total / (1 + gstRate) : total;
      gst = total - subtotal;
    } else {
      subtotal = sum;
      gst = subtotal * gstRate;
      total = subtotal + gst;
    }
    const eligible = settings.apply_subsidy && isHome(lead) && type !== "off_grid" && !/^no/i.test(lead.wants_subsidy || "");
    const subsidy = subsidyOverride ?? (eligible ? subsidyFor(kw) : 0);
    return { items, subtotal, gst, total, subsidy, net: total - subsidy };
  }

  // ---------- Settings ----------
  async function loadSettings() {
    const { data, error } = await sb.from("quote_settings").select("settings").eq("id", 1).maybeSingle();
    settings = error || !data ? {} : data.settings || {};
    return !error;
  }

  $("settingsBtn").addEventListener("click", async () => {
    await loadSettings();
    const f = $("settingsForm");
    const neverSaved = !Object.keys(settings).length;
    let suggested = 0;
    [...f.elements].forEach((el) => {
      if (!el.name) return;
      el.classList.remove("is-suggested");
      const saved = settings[el.name];
      const empty = saved === undefined || saved === "";
      // Fill empty fields with suggested values, highlighted so they get reviewed before saving
      const value = empty && SUGGESTED[el.name] !== undefined ? SUGGESTED[el.name] : saved;
      if (empty && SUGGESTED[el.name] !== undefined && (el.type !== "checkbox" || neverSaved)) {
        el.classList.add("is-suggested");
        suggested++;
      }
      if (el.type === "checkbox") el.checked = Boolean(empty && !neverSaved ? saved : value);
      else el.value = value ?? "";
    });
    if (!f.prices_include_gst.value) f.prices_include_gst.value = "false";
    $("settingsHint").hidden = !suggested;
    $("settingsError").textContent = "";
    $("settingsModal").hidden = false;
  });
  document.querySelectorAll("[data-close-settings]").forEach((el) =>
    el.addEventListener("click", () => ($("settingsModal").hidden = true)));

  $("settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const next = {};
    [...e.target.elements].forEach((el) => {
      if (!el.name) return;
      next[el.name] = el.type === "checkbox" ? el.checked : el.value.trim();
    });
    const { error } = await sb.from("quote_settings")
      .update({ settings: next, updated_at: new Date().toISOString(), updated_by: state.me.email }).eq("id", 1);
    if (error) return ($("settingsError").textContent = error.message);
    settings = next;
    $("settingsModal").hidden = true;
    toast("Quote settings saved");
    if ($("quoteForm")) renderBuilder(); // refresh an open quote with the new prices
  });

  // ---------- Drawer section ----------
  async function open(l) {
    lead = l;
    $("quoteBox").innerHTML = "";
    await Promise.all([loadSettings(), loadQuotes()]);
  }

  async function loadQuotes() {
    const { data, error } = await sb.from("quotes").select("*").eq("lead_id", lead.id).order("created_at", { ascending: false });
    if (error) return ($("quotesList").innerHTML = `<li class="m-empty">Quotes aren't set up yet (run quotes.sql).</li>`);
    $("quotesList").innerHTML = data.length
      ? data.map((q) => `<li data-id="${q.id}">
          <div class="m-head">
            <span class="m-title">${esc(q.quote_number)} · ${esc(q.system_size_kw)} kW ${esc(SYSTEM_TYPES[q.system_type] || q.system_type)}</span>
            <span class="m-badge ${q.status === "sent" ? "scheduled" : q.status === "accepted" ? "done" : q.status === "rejected" ? "cancelled" : ""}">${esc(q.status)}</span>
          </div>
          <div class="m-meta">${esc(new Date(q.created_at).toLocaleDateString("en-IN"))} · Total ${esc(rs(q.total))}${q.subsidy > 0 ? ` · after subsidy ${esc(rs(q.net_payable))}` : ""} · valid until ${esc(new Date(q.valid_until + "T00:00:00").toLocaleDateString("en-IN"))}</div>
          <div class="m-actions">
            <button type="button" class="btn btn--ghost btn--sm" data-q="pdf">Open PDF</button>
            <button type="button" class="btn btn--primary btn--sm" data-q="auto">${q.status === "draft" ? "Send on WhatsApp" : "Send again"}</button>
            <button type="button" class="btn btn--ghost btn--sm" data-q="send" title="Opens WhatsApp with the message ready; you press Send">Open in WhatsApp</button>
            ${q.status === "sent" ? `<button type="button" class="btn btn--ghost btn--sm" data-q="accepted">Accepted</button>
            <button type="button" class="btn btn--ghost btn--sm" data-q="rejected">Rejected</button>` : ""}
          </div>
        </li>`).join("")
      : "";
    state.quotes = data;
  }

  $("prepareQuoteBtn").addEventListener("click", () => {
    if (!lead) return;
    const missing = missingDetails(lead);
    if (missing.length) return renderMissing(missing);
    renderBuilder();
  });

  function waLink(phone, text) {
    return `https://wa.me/${String(phone).replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
  }

  function renderMissing(missing) {
    const message = [
      `Hello ${firstName(lead)}, this is ${COMPANY}. Thank you for your interest in rooftop solar!`,
      "",
      "To prepare an accurate quotation for you, could you please share:",
      ...missing.map((m, i) => `${i + 1}. ${m.question}`),
      "",
      `You can reply here or call us on ${COMPANY_PHONE}.`,
    ].join("\n");
    $("quoteBox").innerHTML = `<div class="quote-panel quote-panel--warn">
        <strong>A few details are missing for an accurate quote:</strong>
        <ul>${missing.map((m) => `<li>${esc(m.label)}</li>`).join("")}</ul>
        <p class="muted">Send the customer these questions on WhatsApp, then fill in their answers under <b>Requirements</b> (or Details) and click <b>Prepare quote</b> again.</p>
        <div class="m-actions">
          <button type="button" class="btn btn--primary btn--sm" id="askAuto">Send questions on WhatsApp</button>
          <a class="btn btn--ghost btn--sm" id="askWhatsApp" target="_blank" rel="noopener" href="${esc(waLink(lead.phone, message))}">Open in WhatsApp</a>
          <button type="button" class="btn btn--ghost btn--sm" id="quoteAnyway">Prepare quote anyway</button>
        </div>
        <details><summary>Message preview</summary><pre>${esc(message)}</pre></details>
      </div>`;
    $("askWhatsApp").addEventListener("click", async () => {
      await sb.from("lead_activities").insert({
        lead_id: lead.id, type: "note", created_by: state.me.email,
        body: `Asked on WhatsApp for missing quote details: ${missing.map((m) => m.label).join(", ")}.`,
      });
      loadActivity(lead.id);
    });
    $("quoteAnyway").addEventListener("click", renderBuilder);
    $("askAuto").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Sending…";
      const ok = await sendViaTwilio({ kind: "ask", lead_id: lead.id, questions: missing.map((m) => m.question) });
      btn.disabled = false;
      btn.textContent = ok ? "Sent ✓ (send again)" : "Send questions on WhatsApp";
      loadActivity(lead.id);
    });
  }

  // Send through Twilio (server side). Returns true on success; on failure explains and offers click-to-chat.
  async function sendViaTwilio(body) {
    const { data, error } = await sb.functions.invoke(WHATSAPP_FUNCTION, { body });
    if (!error) {
      toast("Sent on WhatsApp ✓");
      return true;
    }
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch {}
    if (/not found|Failed to send a request/i.test(msg)) msg = "the WhatsApp function isn't deployed yet";
    toast(`Couldn't send automatically: ${msg}. You can use "Open in WhatsApp" instead.`);
    return false;
  }

  function renderBuilder() {
    const type = systemTypeKey(lead.system_type) || "on_grid";
    const kw = sizeFromLead(lead) || 3;
    const unpriced = Object.keys(SYSTEM_TYPES).filter((t) => !priceFor(t));
    $("quoteBox").innerHTML = `<form class="quote-panel" id="quoteForm">
        ${unpriced.length === 3 ? `<p class="quote-warn">No prices set yet. Open <b>Quote settings</b> (top right) and enter your price per kW first.</p>` : ""}
        <div class="manage">
          <label><span>System type</span>
            <select name="type">${Object.entries(SYSTEM_TYPES).map(([k, v]) =>
              `<option value="${k}"${k === type ? " selected" : ""}${priceFor(k) ? "" : " disabled"}>${v}${priceFor(k) ? "" : " (no price set)"}</option>`).join("")}</select>
          </label>
          <label><span>System size (kW)</span><input type="number" name="kw" min="0.5" step="0.01" value="${kw}" required></label>
          <label><span>Discount (₹)</span><input type="number" name="discount" min="0" step="1" value="0"></label>
          <label><span>Subsidy shown (₹)</span><input type="number" name="subsidy" min="0" step="1" placeholder="auto"></label>
        </div>
        <div class="quote-calc" id="quoteCalc"></div>
        <button type="submit" class="btn btn--primary">Create PDF quotation</button>
      </form>`;
    const f = $("quoteForm");
    const recalc = () => {
      const t = f.type.value;
      if (!priceFor(t)) return ($("quoteCalc").innerHTML = `<p class="quote-warn">Set a price for ${esc(SYSTEM_TYPES[t])} in Quote settings.</p>`);
      const c = calculate(readForm(f));
      $("quoteCalc").innerHTML = `
        ${c.items.map((i) => `<div><span>${esc(i.description)}</span><b>${esc(rs(i.amount))}</b></div>`).join("")}
        <div><span>Taxable value</span><b>${esc(rs(c.subtotal))}</b></div>
        <div><span>GST (${esc(settings.gst_percent || 0)}%)</span><b>${esc(rs(c.gst))}</b></div>
        <div class="total"><span>Total</span><b>${esc(rs(c.total))}</b></div>
        ${c.subsidy ? `<div><span>PM Surya Ghar subsidy (to customer's bank)</span><b>− ${esc(rs(c.subsidy))}</b></div>
        <div class="total"><span>Effective cost after subsidy</span><b>${esc(rs(c.net))}</b></div>` : ""}`;
    };
    f.addEventListener("input", recalc);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!priceFor(f.type.value)) return toast("Set a price for this system type in Quote settings first.");
      await createQuote(readForm(f), f.querySelector('button[type="submit"]'));
    });
    recalc();
  }

  function readForm(f) {
    const subsidyRaw = f.subsidy.value.trim();
    return {
      type: f.type.value,
      kw: Number(f.kw.value) || 1,
      discount: Number(f.discount.value) || 0,
      subsidyOverride: subsidyRaw === "" ? undefined : Number(subsidyRaw),
    };
  }

  // ---------- Create, store and send ----------
  async function createQuote(input, btn) {
    btn.disabled = true;
    btn.textContent = "Creating PDF…";
    try {
      const c = calculate(input);
      const validDays = Number(settings.validity_days) || 15;
      const validUntil = new Date(Date.now() + validDays * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

      const { data: q, error } = await sb.from("quotes").insert({
        lead_id: lead.id, created_by: state.me.email, system_type: input.type, system_size_kw: input.kw,
        items: c.items, subtotal: round2(c.subtotal), gst_amount: round2(c.gst), total: round2(c.total),
        subsidy: round2(c.subsidy), net_payable: round2(c.net), valid_until: validUntil,
      }).select().single();
      if (error) throw error;

      const pdf = buildPdf(q, c);
      const path = `${lead.id}/${q.quote_number}.pdf`;
      const up = await sb.storage.from("quotes").upload(path, pdf.output("blob"), { contentType: "application/pdf", upsert: true });
      if (up.error) throw up.error;
      await sb.from("quotes").update({ pdf_path: path }).eq("id", q.id);

      await sb.from("lead_activities").insert({
        lead_id: lead.id, type: "note", created_by: state.me.email,
        body: `Quotation ${q.quote_number} created: ${input.kw} kW ${SYSTEM_TYPES[input.type]}, total ${rs(c.total)}${c.subsidy ? `, ${rs(c.net)} after subsidy` : ""}.`,
      });
      $("quoteBox").innerHTML = "";
      toast(`Quotation ${q.quote_number} created`);
      await Promise.all([loadQuotes(), loadActivity(lead.id)]);
    } catch (err) {
      toast("Couldn't create the quote: " + (err.message || err));
      btn.disabled = false;
      btn.textContent = "Create PDF quotation";
    }
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  async function signedUrl(q, days) {
    const { data, error } = await sb.storage.from("quotes").createSignedUrl(q.pdf_path, days * 86400);
    if (error) throw error;
    return data.signedUrl;
  }

  $("quotesList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-q]");
    if (!btn) return;
    const q = (state.quotes || []).find((x) => x.id === btn.closest("li").dataset.id);
    if (!q) return;
    const action = btn.dataset.q;

    if (action === "auto") {
      btn.disabled = true;
      btn.textContent = "Sending…";
      const ok = await sendViaTwilio({ kind: "quote", lead_id: lead.id, quote_id: q.id });
      if (ok) {
        const fresh = await refreshLead(lead.id);
        if (fresh) lead = fresh;
      }
      await Promise.all([loadQuotes(), loadActivity(lead.id)]);
      return;
    }

    // Open the tab during the click itself, or the browser's pop-up blocker stops it after the await
    const tab = action === "pdf" || action === "send" ? window.open("about:blank", "_blank") : null;

    try {
      if (action === "pdf") {
        if (!q.pdf_path) { tab?.close(); return toast("This quote has no PDF."); }
        const url = await signedUrl(q, 1);
        if (tab) tab.location.href = url; else window.location.href = url;
        return;
      }

      if (action === "send") {
        if (!q.pdf_path) { tab?.close(); return toast("This quote has no PDF."); }
        // The customer's link stays valid a month beyond the quote's validity
        const days = Math.max(7, Math.ceil((new Date(q.valid_until) - Date.now()) / 864e5) + 30);
        const url = await signedUrl(q, days);
        const lines = [
          `Hello ${firstName(lead)}, thank you for choosing ${COMPANY}!`,
          "",
          `Here is your solar quotation ${q.quote_number}:`,
          `• System: ${q.system_size_kw} kW ${SYSTEM_TYPES[q.system_type]} rooftop solar`,
          `• Total price: ${rs(q.total)} (incl. GST)`,
        ];
        if (q.subsidy > 0) {
          lines.push(`• Govt. subsidy (PM Surya Ghar): ${rs(q.subsidy)}, credited to your bank account after installation`);
          lines.push(`• Effective cost after subsidy: ${rs(q.net_payable)}`);
        }
        lines.push(`• Valid until: ${new Date(q.valid_until + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}`);
        lines.push("", "Download your quotation (PDF):", url, "", `Any questions? Reply here or call ${COMPANY_PHONE}.`);
        const link = waLink(lead.phone, lines.join("\n"));
        if (tab) tab.location.href = link; else window.location.href = link;

        await sb.from("quotes").update({ status: q.status === "draft" ? "sent" : q.status, sent_at: new Date().toISOString() }).eq("id", q.id);
        await sb.from("lead_activities").insert({
          lead_id: lead.id, type: "note", created_by: state.me.email,
          body: `Quotation ${q.quote_number} sent on WhatsApp to ${lead.phone}.`,
        });
        if (lead.status in STAGE_RANK && STAGE_RANK[lead.status] < STAGE_RANK.quote_sent) {
          await updateLead(lead.id, { status: "quote_sent" });
        }
        const fresh = await refreshLead(lead.id);
        if (fresh) lead = fresh;
        toast("WhatsApp opened. Press Send in the chat.");
        await Promise.all([loadQuotes(), loadActivity(lead.id)]);
        return;
      }

      if (action === "accepted" || action === "rejected") {
        await sb.from("quotes").update({ status: action }).eq("id", q.id);
        await sb.from("lead_activities").insert({
          lead_id: lead.id, type: "note", created_by: state.me.email, body: `Quotation ${q.quote_number} marked ${action}.`,
        });
        if (action === "accepted" && confirm("Mark this lead as Won?")) await updateLead(lead.id, { status: "won", deal_value: q.total });
        await Promise.all([loadQuotes(), loadActivity(lead.id)]);
      }
    } catch (err) {
      tab?.close();
      toast("Something went wrong: " + (err.message || err));
    }
  });

  // ---------- PDF ----------
  function buildPdf(q, c) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const W = 210, M = 16;
    const orange = [242, 98, 15], navy = [14, 34, 51], muted = [91, 102, 114];
    const fmtDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

    // Header band
    doc.setFillColor(...navy);
    doc.rect(0, 0, W, 34, "F");
    doc.setFillColor(...orange);
    doc.roundedRect(M, 9, 16, 16, 3, 3, "F");
    doc.setFillColor(255, 255, 255);
    doc.circle(M + 8, 21, 5, "F");
    doc.setFillColor(...orange);
    doc.rect(M + 2, 21, 12, 2.5, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold").setFontSize(16).text("Sun Power Solar Solutions", M + 21, 17);
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(220, 226, 232);
    doc.text(settings.address || COMPANY_ADDRESS, M + 21, 22.5, { maxWidth: 120 });
    const contact = [settings.phone || COMPANY_PHONE, settings.email, settings.gstin ? `GSTIN ${settings.gstin}` : ""].filter(Boolean).join("  |  ");
    doc.text(contact, M + 21, 30);

    // Title
    let y = 46;
    doc.setTextColor(...navy).setFont("helvetica", "bold").setFontSize(20).text("QUOTATION", M, y);
    doc.setFontSize(9).setFont("helvetica", "normal").setTextColor(...muted);
    doc.text(`Quote no: ${q.quote_number}`, W - M, y - 7, { align: "right" });
    doc.text(`Date: ${fmtDate(q.created_at)}`, W - M, y - 2.5, { align: "right" });
    doc.text(`Valid until: ${fmtDate(q.valid_until + "T00:00:00")}`, W - M, y + 2, { align: "right" });

    // Customer & system
    y += 9;
    doc.setDrawColor(230, 225, 218).setFillColor(248, 246, 242);
    doc.roundedRect(M, y, (W - 2 * M - 6) / 2, 30, 2, 2, "FD");
    doc.roundedRect(M + (W - 2 * M + 6) / 2, y, (W - 2 * M - 6) / 2, 30, 2, 2, "FD");
    const col2 = M + (W - 2 * M + 6) / 2;
    doc.setTextColor(...orange).setFont("helvetica", "bold").setFontSize(8).text("PREPARED FOR", M + 5, y + 6);
    doc.text("PROPOSED SYSTEM", col2 + 5, y + 6);
    doc.setTextColor(...navy).setFontSize(11).text(lead.name, M + 5, y + 12.5);
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(60, 60, 60);
    doc.text([lead.phone, lead.location, lead.property_type || ""].filter(Boolean), M + 5, y + 18);
    const monthlyUnits = q.system_size_kw * UNITS_PER_KW_MONTH;
    doc.setTextColor(...navy).setFont("helvetica", "bold").setFontSize(11)
      .text(`${q.system_size_kw} kW ${SYSTEM_TYPES[q.system_type]}`, col2 + 5, y + 12.5);
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(60, 60, 60).text([
      `Est. generation: ~${Math.round(monthlyUnits)} units / month`,
      `Est. savings: ~${rs(monthlyUnits * TARIFF)} / month`,
      `Roof space needed: ~${Math.round(q.system_size_kw * 100)} sq ft`,
    ], col2 + 5, y + 18);

    // Price table
    y += 38;
    const body = c.items.map((i, n) => [n + 1, i.description, rs(i.amount)]);
    doc.autoTable({
      startY: y, margin: { left: M, right: M },
      head: [["#", "Description", "Amount"]],
      body,
      foot: [
        ["", "Taxable value", rs(c.subtotal)],
        ["", `GST @ ${settings.gst_percent || 0}%`, rs(c.gst)],
        ["", "Total (incl. GST)", rs(c.total)],
        ...(c.subsidy ? [
          ["", "Less: PM Surya Ghar subsidy*", `- ${rs(c.subsidy)}`],
          ["", "Effective cost after subsidy", rs(c.net)],
        ] : []),
      ],
      theme: "grid",
      styles: { font: "helvetica", fontSize: 9.5, cellPadding: 3, lineColor: [230, 225, 218] },
      headStyles: { fillColor: navy, textColor: 255 },
      footStyles: { fillColor: [248, 246, 242], textColor: navy, fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 10, halign: "center" }, 2: { cellWidth: 40, halign: "right" } },
      didParseCell: (d) => {
        if (d.section === "foot" && d.column.index === 2) d.cell.styles.halign = "right";
        if (d.section === "foot" && /Total|Effective/.test(d.row.raw[1])) d.cell.styles.textColor = orange;
      },
    });
    y = doc.lastAutoTable.finalY + 4;
    if (c.subsidy) {
      doc.setFontSize(8).setTextColor(...muted).text(
        "* Subsidy is paid by the Government directly to the customer's bank account after installation and inspection. The amount payable to Sun Power is the Total.",
        M, y + 2, { maxWidth: W - 2 * M });
      y += 9;
    }

    // Components & warranty
    const comp = [
      ["Solar panels", settings.panel], ["Inverter", settings.inverter],
      ...(q.system_type !== "on_grid" ? [["Battery", settings.battery]] : []),
      ["Mounting structure", settings.structure], ["Cables & protection", settings.bos],
      ["Panel warranty", settings.warranty_panel], ["Inverter warranty", settings.warranty_inverter],
      ["Installation warranty", settings.warranty_installation],
    ].filter(([, v]) => v);
    if (comp.length) {
      doc.autoTable({
        startY: y + 2, margin: { left: M, right: M },
        head: [["Components & warranty", ""]], body: comp, theme: "plain",
        styles: { fontSize: 9, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 } },
        headStyles: { textColor: orange, fontStyle: "bold" },
        columnStyles: { 0: { cellWidth: 50, textColor: muted } },
      });
      y = doc.lastAutoTable.finalY + 4;
    }

    // Terms
    const terms = [
      settings.payment_terms ? `Payment terms: ${settings.payment_terms}` : null,
      settings.notes || null,
      "Final system design and price are confirmed after the free site survey.",
      `This quotation is valid until ${fmtDate(q.valid_until + "T00:00:00")}.`,
    ].filter(Boolean);
    const termsHeight = 8 + terms.reduce((h, t) => h + doc.splitTextToSize(`• ${t}`, W - 2 * M).length * 4.2, 0);
    if (y + termsHeight > 282) { doc.addPage(); y = 20; }
    doc.setTextColor(...orange).setFont("helvetica", "bold").setFontSize(9).text("TERMS", M, y + 3);
    doc.setTextColor(60, 60, 60).setFont("helvetica", "normal").setFontSize(8.5);
    let ty = y + 8;
    terms.forEach((t) => {
      const lines = doc.splitTextToSize(`• ${t}`, W - 2 * M);
      doc.text(lines, M, ty);
      ty += lines.length * 4.2;
    });

    // Footer on every page
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFillColor(...orange);
      doc.rect(0, 287, W, 10, "F");
      doc.setTextColor(255, 255, 255).setFontSize(8.5)
        .text(`Thank you for choosing Sun Power Solar Solutions  |  ${settings.phone || COMPANY_PHONE}${pages > 1 ? `  |  Page ${p} of ${pages}` : ""}`, W / 2, 293, { align: "center" });
    }
    return doc;
  }

  window.Quotes = { open };
})();
