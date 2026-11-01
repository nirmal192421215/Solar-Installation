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

  const SYSTEM_TYPES = { on_grid: "On-grid", hybrid: "Hybrid (with battery)", off_grid: "Off-grid (battery)", panel_set: "Solar panel set" };
  // Price-per-kW estimates are for complete systems
  const ESTIMATE_TYPES = Object.fromEntries(Object.entries(SYSTEM_TYPES).filter(([k]) => k !== "panel_set"));
  const STAGE_RANK = { new: 0, ai_called: 1, interested: 2, survey_booked: 3, survey_done: 4, survey_approved: 5, quote_sent: 6 };

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
    // Estimate band and parts catalogue for the final quote (typical market values; adjust to real costs)
    estimate_margin_percent: "10",
    panel_model: "Mono PERC / TOPCon, Tier-1, ALMM-listed",
    panel_watt: "540",
    panel_price: "12000",
    inverter_on_grid_per_kw: "8000",
    inverter_hybrid_per_kw: "15000",
    battery_kwh_per_kw: "2",
    battery_price_per_kwh: "18000",
    structure_per_kw: "7000",
    structure_elevated_per_kw: "4000",
    dc_cable_per_m: "60",
    ac_cable_per_m: "90",
    acdb_dcdb: "6000",
    earthing_kit: "5000",
    lightning_arrestor: "2500",
    installation_per_kw: "5000",
    // Orders & payments
    advance_percent: "30",
    // After-sales service
    workmanship_warranty_months: "60",
    service_visit_charge: "500",
    // Invoices & costs (check the HSN/SAC codes with your accountant)
    labour_cost_per_hour: "150",
    company_state: "Telangana",
    invoice_prefix: "SP",
    installation_sac: "9954",
    service_sac: "9987",
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

  function calculate({ kw, type, discount, subsidyOverride, parts }) {
    const items = parts ? parts.map((p) => ({ ...p })) : [
      { description: `${kw} kW ${SYSTEM_TYPES[type]} rooftop solar system: supply, installation & commissioning`, amount: priceFor(type) * kw },
    ];
    const netMetering = Number(settings.net_metering_charges) || 0;
    if (!parts && netMetering && type !== "off_grid") items.push({ description: "Net metering & DISCOM approval charges", amount: netMetering });
    const other = Number(settings.other_charges) || 0;
    if (!parts && other) items.push({ description: settings.other_charges_label || "Other charges", amount: other });
    if (discount > 0) items.push({ description: "Discount", amount: -discount });

    const sum = items.reduce((a, i) => a + i.amount, 0);
    const gstRate = (Number(settings.gst_percent) || 0) / 100;
    let subtotal, gst, total;
    let gstLabel = `GST (${settings.gst_percent || 0}%)`;
    if (parts?.length && parts.every((p) => Number.isFinite(p.gst_percent))) {
      // Lines from Products carry their own GST rate (goods / services); a discount lowers the GST in proportion
      const gross = parts.reduce((a, p) => a + p.amount, 0);
      subtotal = sum;
      gst = gross ? parts.reduce((a, p) => a + (p.amount * p.gst_percent) / 100, 0) * (subtotal / gross) : 0;
      total = subtotal + gst;
      gstLabel = `GST (${[...new Set(parts.map((p) => p.gst_percent))].sort((a, b) => a - b).join("% / ")}% per item)`;
    } else if (settings.prices_include_gst === "true" || settings.prices_include_gst === true) {
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
    return { items, subtotal, gst, total, subsidy, net: total - subsidy, gstLabel };
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
    const badge = (q) => `<span class="m-badge ${q.status === "sent" ? "scheduled" : q.status === "accepted" ? "done" : q.status === "rejected" ? "cancelled" : ""}">${esc(q.status)}</span>`;
    const sendButtons = (q) => `
            <button type="button" class="btn btn--ghost btn--sm" data-q="pdf">Open PDF</button>
            <button type="button" class="btn btn--primary btn--sm" data-q="auto">${q.status === "draft" ? "Send on WhatsApp" : "Send again"}</button>
            <button type="button" class="btn btn--ghost btn--sm" data-q="send" title="Opens WhatsApp with the message ready; you press Send">Open in WhatsApp</button>`;
    $("quotesList").innerHTML = data.length
      ? data.map((q) => q.kind === "estimate" ? `<li data-id="${q.id}">
          <div class="m-head">
            <span class="m-title"><span class="q-kind estimate">Estimate</span>${q.pdf_path ? `${esc(q.quote_number)} · ` : ""}${esc(q.range?.kw_low ?? "")}–${esc(q.range?.kw_high ?? q.system_size_kw)} kW ${esc(SYSTEM_TYPES[q.system_type] || q.system_type)}</span>
            ${badge(q)}
          </div>
          <div class="m-meta">${esc(new Date(q.created_at).toLocaleDateString("en-IN"))} · Approx. ${esc(rs(q.range?.total_low))} – ${esc(rs(q.range?.total_high))}${q.range?.subsidy ? ` · after subsidy ${esc(rs(q.range.net_low))} – ${esc(rs(q.range.net_high))}` : ""} · ${q.source === "ai_call" ? "sent on WhatsApp after the AI call" : "prepared in the CRM"}</div>
          ${q.pdf_path ? `<div class="m-actions">${sendButtons(q)}</div>` : ""}
        </li>` : `<li data-id="${q.id}">
          <div class="m-head">
            <span class="m-title">${q.kind === "final" ? `<span class="q-kind final">Final</span>` : ""}${esc(q.quote_number)} · ${esc(q.system_size_kw)} kW ${esc(SYSTEM_TYPES[q.system_type] || q.system_type)}</span>
            ${badge(q)}
          </div>
          <div class="m-meta">${esc(new Date(q.created_at).toLocaleDateString("en-IN"))} · Total ${esc(rs(q.total))}${q.subsidy > 0 ? ` · after subsidy ${esc(rs(q.net_payable))}` : ""} · valid until ${esc(new Date(q.valid_until + "T00:00:00").toLocaleDateString("en-IN"))}${q.accepted_at ? ` · accepted ${esc(new Date(q.accepted_at).toLocaleDateString("en-IN"))}${q.accepted_via === "whatsapp" ? " on WhatsApp" : ""}` : ""}</div>
          <div class="m-actions">
            ${sendButtons(q)}
            ${q.status === "sent" ? `<button type="button" class="btn btn--ghost btn--sm" data-q="accepted">Mark accepted</button>
            <button type="button" class="btn btn--ghost btn--sm" data-q="rejected">Mark rejected</button>` : ""}
          </div>
        </li>`).join("")
      : "";
    state.quotes = data;
  }

  $("prepareQuoteBtn").addEventListener("click", async () => {
    if (!lead) return;
    const { data: survey } = await sb.from("surveys").select("*").eq("lead_id", lead.id).eq("status", "approved")
      .order("reviewed_at", { ascending: false }).limit(1).maybeSingle();
    if (survey) return prepareFinal(survey);
    // No approved survey: only an approximate estimate can go to the customer
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
        <strong>A few details are missing for an accurate estimate:</strong>
        <ul>${missing.map((m) => `<li>${esc(m.label)}</li>`).join("")}</ul>
        <p class="muted">Send the customer these questions on WhatsApp, then fill in their answers under <b>Requirements</b> (or Details) and click <b>Prepare quote</b> again.</p>
        <div class="m-actions">
          <button type="button" class="btn btn--primary btn--sm" id="askAuto">Send questions on WhatsApp</button>
          <a class="btn btn--ghost btn--sm" id="askWhatsApp" target="_blank" rel="noopener" href="${esc(waLink(lead.phone, message))}">Open in WhatsApp</a>
          <button type="button" class="btn btn--ghost btn--sm" id="quoteAnyway">Prepare estimate anyway</button>
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

  // Price band for an estimate: a size band around the suggested size, ± the margin in Quote settings
  // (the same rule as the automatic estimate sent after the AI call)
  function estimateRange(input) {
    const margin = (Number(settings.estimate_margin_percent) || 10) / 100;
    const kwHigh = input.kw + (input.kw < 5 ? 0.5 : 1);
    const low = calculate(input);
    const high = calculate({ ...input, kw: kwHigh });
    const range = {
      kw_low: input.kw, kw_high: kwHigh, margin_percent: margin * 100,
      total_low: Math.round(low.total * (1 - margin)), total_high: Math.round(high.total * (1 + margin)),
      net_low: Math.round(low.total * (1 - margin) - low.subsidy), net_high: Math.round(high.total * (1 + margin) - high.subsidy),
      subsidy: high.subsidy,
    };
    return { range, high };
  }

  // Without an approved site survey: an APPROXIMATE ESTIMATE (price range) only
  function renderBuilder() {
    const type = systemTypeKey(lead.system_type) || "on_grid";
    const kw = sizeFromLead(lead) || 3;
    const unpriced = Object.keys(ESTIMATE_TYPES).filter((t) => !priceFor(t));
    $("quoteBox").innerHTML = `<form class="quote-panel" id="quoteForm">
        <strong><span class="q-kind estimate">Estimate</span>Approximate estimate</strong>
        <p class="muted">There's no approved site survey yet, so the customer gets a price <b>range</b>. The final quote unlocks once the engineer's survey is approved.</p>
        ${unpriced.length === 3 ? `<p class="quote-warn">No prices set yet. Open <b>Quote settings</b> (top right) and enter your price per kW first.</p>` : ""}
        <div class="manage">
          <label><span>System type</span>
            <select name="type">${Object.entries(ESTIMATE_TYPES).map(([k, v]) =>
              `<option value="${k}"${k === type ? " selected" : ""}${priceFor(k) ? "" : " disabled"}>${v}${priceFor(k) ? "" : " (no price set)"}</option>`).join("")}</select>
          </label>
          <label><span>System size (kW)</span><input type="number" name="kw" min="0.5" step="0.01" value="${kw}" required></label>
          <label><span>Discount (₹)</span><input type="number" name="discount" min="0" step="1" value="0"></label>
          <label><span>Subsidy shown (₹)</span><input type="number" name="subsidy" min="0" step="1" placeholder="auto"></label>
        </div>
        <div class="quote-calc" id="quoteCalc"></div>
        <button type="submit" class="btn btn--primary">Create estimate PDF</button>
      </form>`;
    const f = $("quoteForm");
    const recalc = () => {
      const t = f.type.value;
      if (!priceFor(t)) return ($("quoteCalc").innerHTML = `<p class="quote-warn">Set a price for ${esc(SYSTEM_TYPES[t])} in Quote settings.</p>`);
      const { range: r } = estimateRange(readForm(f));
      $("quoteCalc").innerHTML = `
        <div><span>System size</span><b>about ${esc(r.kw_low)}–${esc(r.kw_high)} kW</b></div>
        <div><span>Price band</span><b>± ${esc(r.margin_percent)}%</b></div>
        <div class="total"><span>Approximate price (incl. GST)</span><b>${esc(rs(r.total_low))} – ${esc(rs(r.total_high))}</b></div>
        ${r.subsidy ? `<div><span>PM Surya Ghar subsidy (to customer's bank)</span><b>up to ${esc(rs(r.subsidy))}</b></div>
        <div class="total"><span>Approximate cost after subsidy</span><b>${esc(rs(r.net_low))} – ${esc(rs(r.net_high))}</b></div>` : ""}`;
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

  // ---------- Final quote from an approved site survey ----------
  const num = (k) => Number(settings[k]) || 0;

  // Fallback when no kit template fits: parts priced from the catalogue in Quote settings and the survey's measurements
  function partsFromSurvey(s, type) {
    const watt = num("panel_watt") || 540;
    const panels = s.panel_count || Math.ceil(((s.recommended_kw || 1) * 1000) / watt);
    const kw = Math.round(panels * watt) / 1000;
    const elevated = /elevated/i.test(s.structure_height || "");
    const battery = type !== "on_grid";
    const batteryKwh = Math.round(kw * (num("battery_kwh_per_kw") || 2) * 10) / 10;
    const rows = [
      { description: `Solar panels ${watt} Wp (${settings.panel_model || "Tier-1"}) x ${panels}`, amount: panels * num("panel_price") },
      { description: `${battery ? "Hybrid" : "On-grid"} inverter, ${kw} kW`, amount: kw * num(battery ? "inverter_hybrid_per_kw" : "inverter_on_grid_per_kw") },
      ...(battery ? [{ description: `Lithium battery ${batteryKwh} kWh (${settings.battery || "LFP"})`, amount: batteryKwh * num("battery_price_per_kwh") }] : []),
      { description: `Mounting structure for ${kw} kW${elevated ? ", elevated" : ""} (${settings.structure || "hot-dip galvanised"})`, amount: kw * (num("structure_per_kw") + (elevated ? num("structure_elevated_per_kw") : 0)) },
      { description: `DC cable ${s.dc_cable_m || 0} m (panels to inverter)`, amount: (s.dc_cable_m || 0) * num("dc_cable_per_m") },
      { description: `AC cable ${s.ac_cable_m || 0} m (inverter to meter)`, amount: (s.ac_cable_m || 0) * num("ac_cable_per_m") },
      { description: "ACDB & DCDB with surge protection", amount: num("acdb_dcdb") },
      { description: "Earthing kit", amount: num("earthing_kit") },
      { description: "Lightning arrestor", amount: num("lightning_arrestor") },
      { description: `Installation & commissioning (${kw} kW)`, amount: kw * num("installation_per_kw") },
      ...(type !== "off_grid" && num("net_metering_charges") ? [{ description: "Net metering & DISCOM approval charges", amount: num("net_metering_charges") }] : []),
    ];
    return { kw, rows: rows.map((r) => ({ ...r, amount: Math.round(r.amount) })) };
  }

  // The kit template for this survey: same system type (hybrid uses the off-grid kits) and the nearest size
  function pickTemplate(templates, type, kw) {
    let list = templates.filter((t) => t.system_type === type);
    if (!list.length && type === "hybrid") list = templates.filter((t) => t.system_type === "off_grid");
    return list.sort((a, b) => Math.abs(a.size_kw - kw) - Math.abs(b.size_kw - kw) || b.size_kw - a.size_kw)[0] || null;
  }

  // Template items → quote lines, with the survey's panel count, cable metres and structure height
  function linesFromTemplate(t, s, products, kw, panels) {
    const byId = new Map(products.map((p) => [p.id, p]));
    const elevated = /elevated/i.test(s.structure_height || "");
    const elevatedExtra = products.find((p) => p.category === "structure" && /elevat/i.test(p.name));
    const items = [...(t.kit_template_items || [])].sort((a, b) => a.sort - b.sort);
    const lines = [];
    for (const i of items) {
      const p = byId.get(i.product_id);
      if (!p) continue;
      let qty = {
        fixed: i.qty,
        per_kw: i.qty * kw,
        per_panel: i.qty * panels,
        from_survey_dc_cable: Number(s.dc_cable_m) || i.qty,
        from_survey_ac_cable: Number(s.ac_cable_m) || i.qty,
      }[i.qty_mode] ?? i.qty;
      if (p.category === "panel") qty = panels; // the engineer counted them on the roof
      lines.push(lineFor(p, qty));
      // Elevated structure is charged on top of the standard structure
      if (elevated && p.category === "structure" && elevatedExtra && p.id !== elevatedExtra.id
        && !items.some((x) => x.product_id === elevatedExtra.id)) {
        lines.push(lineFor(elevatedExtra, kw));
      }
    }
    return lines;
  }

  function lineFor(p, qty) {
    const whole = ["pcs", "set", "job"].includes(p.unit);
    return {
      product_id: p.id, sku: p.sku, description: p.name, unit: p.unit,
      qty: whole ? Math.ceil(qty - 1e-9) : Math.round(qty * 100) / 100,
      unit_price: Number(p.sell_price) || 0, gst_percent: Number(p.gst_percent),
      is_service: p.is_service, available: p.is_service ? null : Number(p.stock_qty) - Number(p.reserved_qty),
    };
  }

  async function prepareFinal(survey) {
    await loadSettings();
    const type = survey.system_type || systemTypeKey(lead.system_type) || "on_grid";
    const watt = num("panel_watt") || 540;
    const kw = Number(survey.recommended_kw) || Math.round((survey.panel_count || 0) * watt) / 1000 || sizeFromLead(lead) || 3;
    const panels = Number(survey.panel_count) || Math.ceil((kw * 1000) / watt);

    const [{ data: templates, error }, { data: products }] = await Promise.all([
      sb.from("kit_templates").select("*, kit_template_items(*)").eq("active", true),
      sb.from("products").select("*").eq("active", true),
    ]);
    const template = error ? null : pickTemplate(templates || [], type, kw);
    const lines = template
      ? linesFromTemplate(template, survey, products || [], kw, panels)
      : partsFromSurvey(survey, type).rows.map((r) => ({ description: r.description, qty: 1, unit: "set", unit_price: r.amount }));

    $("quoteBox").innerHTML = `<form class="quote-panel" id="finalForm">
        <strong><span class="q-kind final">Final</span>Final quote from the approved site survey${survey.visited_at ? ` (${esc(new Date(survey.visited_at + "T00:00:00").toLocaleDateString("en-IN"))})` : ""}</strong>
        <p class="muted">${esc(SYSTEM_TYPES[type])} · ${kw} kW · ${panels} panels · DC ${esc(survey.dc_cable_m ?? "?")} m · AC ${esc(survey.ac_cable_m ?? "?")} m${/elevated/i.test(survey.structure_height || "") ? " · elevated structure" : ""}.
          ${template ? `Lines come from the <b>${esc(template.name)}</b> kit template, priced from Products (excl. GST).` : "No kit template matches, so prices come from Quote settings → Parts &amp; prices."}
          Change any quantity or price; a quantity of 0 drops the line.</p>
        <p class="quote-warn" id="stockWarn" hidden></p>
        <div class="table-wrap"><table class="bom"><thead><tr><th>Item</th><th>Qty</th><th>Unit price (₹)</th><th class="right">Amount</th></tr></thead><tbody>
          ${lines.map((l, i) => `<tr>
            <td><input name="d${i}" value="${esc(l.description)}">${l.sku ? `<small class="bom-sku">${esc(l.sku)}</small>` : ""}<small class="stock-tag" id="st${i}"></small></td>
            <td class="qty"><input type="number" min="0" step="any" name="q${i}" value="${l.qty}"><small>${esc(l.unit || "")}</small></td>
            <td class="num"><input type="number" min="0" step="1" name="p${i}" value="${l.unit_price}"></td>
            <td class="right amt" id="am${i}"></td>
          </tr>`).join("")}
        </tbody></table></div>
        <div class="manage">
          <label><span>Discount (₹)</span><input type="number" name="discount" min="0" step="1" value="0"></label>
          <label><span>Subsidy shown (₹)</span><input type="number" name="subsidy" min="0" step="1" placeholder="auto"></label>
        </div>
        <div class="quote-calc" id="finalCalc"></div>
        <button type="submit" class="btn btn--primary">Create FINAL quotation PDF</button>
      </form>`;
    const f = $("finalForm");
    const read = () => ({
      type, kw, survey,
      parts: lines.map((l, i) => {
        const qty = Number(f[`q${i}`].value) || 0;
        const unit_price = Number(f[`p${i}`].value) || 0;
        return { ...l, description: f[`d${i}`].value.trim(), qty, unit_price, amount: round2(qty * unit_price) };
      }).filter((p) => p.description && p.qty > 0 && p.amount > 0),
      discount: Number(f.discount.value) || 0,
      subsidyOverride: f.subsidy.value.trim() === "" ? undefined : Number(f.subsidy.value),
    });
    const recalc = () => {
      let short = 0;
      lines.forEach((l, i) => {
        const qty = Number(f[`q${i}`].value) || 0;
        $(`am${i}`).textContent = rs(qty * (Number(f[`p${i}`].value) || 0));
        const low = l.available !== null && l.available !== undefined && qty > l.available;
        $(`st${i}`).textContent = low ? `Only ${l.available} in stock` : "";
        if (low) short++;
      });
      $("stockWarn").hidden = !short;
      $("stockWarn").textContent = `${short} item(s) are short in stock. You can still send the quote; the warehouse is flagged if the order is confirmed before new stock arrives.`;
      const c = calculate(read());
      $("finalCalc").innerHTML = `
        <div><span>Taxable value</span><b>${esc(rs(c.subtotal))}</b></div>
        <div><span>${esc(c.gstLabel)}</span><b>${esc(rs(c.gst))}</b></div>
        <div class="total"><span>Final total</span><b>${esc(rs(c.total))}</b></div>
        ${c.subsidy ? `<div><span>PM Surya Ghar subsidy (to customer's bank)</span><b>− ${esc(rs(c.subsidy))}</b></div>
        <div class="total"><span>Effective cost after subsidy</span><b>${esc(rs(c.net))}</b></div>` : ""}`;
    };
    f.addEventListener("input", recalc);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      await createQuote(read(), f.querySelector('button[type="submit"]'));
    });
    recalc();
    $("quoteBox").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- Create, store and send ----------
  // Stock figures are only for the form; the quote keeps what the order needs
  const quoteLine = ({ available, is_service, ...line }) => line;

  async function createQuote(input, btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Creating PDF…";
    try {
      const isFinal = Boolean(input.survey);
      const c = calculate(input);
      const est = isFinal ? null : estimateRange(input);
      const priced = est ? est.high : c;
      const validDays = Number(settings.validity_days) || 15;
      const validUntil = new Date(Date.now() + validDays * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

      const { data: q, error } = await sb.from("quotes").insert({
        lead_id: lead.id, created_by: state.me.email, system_type: input.type,
        system_size_kw: est ? est.range.kw_high : input.kw,
        kind: isFinal ? "final" : "estimate", survey_id: input.survey?.id ?? null, range: est?.range ?? null,
        items: priced.items.map(quoteLine), subtotal: round2(priced.subtotal), gst_amount: round2(priced.gst),
        total: est ? est.range.total_high : round2(c.total), subsidy: round2(priced.subsidy),
        net_payable: est ? est.range.net_high : round2(c.net), valid_until: validUntil,
      }).select().single();
      if (error) throw error;

      const pdf = buildPdf(q, priced, input.survey);
      const path = `${lead.id}/${q.quote_number}.pdf`;
      const up = await sb.storage.from("quotes").upload(path, pdf.output("blob"), { contentType: "application/pdf", upsert: true });
      if (up.error) throw up.error;
      await sb.from("quotes").update({ pdf_path: path }).eq("id", q.id);

      await sb.from("lead_activities").insert({
        lead_id: lead.id, type: "note", created_by: state.me.email,
        body: est
          ? `Approximate estimate ${q.quote_number} created: ${est.range.kw_low}–${est.range.kw_high} kW ${SYSTEM_TYPES[input.type]}, ${rs(est.range.total_low)} – ${rs(est.range.total_high)}.`
          : `FINAL quotation ${q.quote_number} created: ${input.kw} kW ${SYSTEM_TYPES[input.type]}, total ${rs(c.total)}${c.subsidy ? `, ${rs(c.net)} after subsidy` : ""}.`,
      });
      $("quoteBox").innerHTML = "";
      toast(`${est ? "Estimate" : "Quotation"} ${q.quote_number} created`);
      await Promise.all([loadQuotes(), loadActivity(lead.id)]);
    } catch (err) {
      toast("Couldn't create the quote: " + (err.message || err));
      btn.disabled = false;
      btn.textContent = label;
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
        const r = q.kind === "estimate" ? q.range : null;
        const lines = [
          `Hello ${firstName(lead)}, thank you for choosing ${COMPANY}!`,
          "",
          r ? `Here is your *APPROXIMATE ESTIMATE* ${q.quote_number} (not a final quote):`
            : q.kind === "final" ? `Here is your *FINAL quotation* ${q.quote_number}, based on our engineer's site survey:`
            : `Here is your solar quotation ${q.quote_number}:`,
        ];
        if (r) {
          lines.push(`• System: about ${r.kw_low}–${r.kw_high} kW ${SYSTEM_TYPES[q.system_type]} rooftop solar`,
            `• Approximate price: ${rs(r.total_low)} – ${rs(r.total_high)} (incl. GST)`);
          if (r.subsidy > 0) lines.push(`• After PM Surya Ghar subsidy: about ${rs(r.net_low)} – ${rs(r.net_high)}`);
        } else {
          lines.push(`• System: ${q.system_size_kw} kW ${SYSTEM_TYPES[q.system_type]} rooftop solar`, `• Total price: ${rs(q.total)} (incl. GST)`);
          if (q.subsidy > 0) {
            lines.push(`• Govt. subsidy (PM Surya Ghar): ${rs(q.subsidy)}, credited to your bank account after installation`);
            lines.push(`• Effective cost after subsidy: ${rs(q.net_payable)}`);
          }
        }
        lines.push(`• Valid until: ${new Date(q.valid_until + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}`);
        lines.push("", `Download your ${r ? "estimate" : "quotation"} (PDF):`, url, "");
        if (r) lines.push("The exact price is confirmed after our free site survey.");
        if (q.kind === "final") lines.push("Happy with it? Just reply YES to go ahead and we'll send the payment details.");
        lines.push(`Any questions? Reply here or call ${COMPANY_PHONE}.`);
        const link = waLink(lead.phone, lines.join("\n"));
        if (tab) tab.location.href = link; else window.location.href = link;

        await sb.from("quotes").update({ status: q.status === "draft" ? "sent" : q.status, sent_at: new Date().toISOString() }).eq("id", q.id);
        await sb.from("lead_activities").insert({
          lead_id: lead.id, type: "note", created_by: state.me.email,
          body: `${r ? "Approximate estimate" : "Quotation"} ${q.quote_number} sent on WhatsApp to ${lead.phone}.`,
        });
        // An estimate isn't a quote: the lead only reaches "Quote sent" with the final quote
        if (!r && lead.status in STAGE_RANK && STAGE_RANK[lead.status] < STAGE_RANK.quote_sent) {
          await updateLead(lead.id, { status: "quote_sent" });
        }
        const fresh = await refreshLead(lead.id);
        if (fresh) lead = fresh;
        toast("WhatsApp opened. Press Send in the chat.");
        await Promise.all([loadQuotes(), loadActivity(lead.id)]);
        return;
      }

      if (action === "accepted" || action === "rejected") {
        // Accepting a final quote: the database marks the lead Won, logs it and creates the order
        const createsOrder = q.kind === "final" && action === "accepted";
        if (createsOrder && !confirm(`Mark ${q.quote_number} as accepted by ${lead.name}?\n\nThis creates the order (advance payment due) and marks the lead as Won.`)) return;
        const { error } = await sb.from("quotes").update(createsOrder ? { status: action, accepted_via: "crm" } : { status: action }).eq("id", q.id);
        if (error) throw error;
        if (createsOrder) {
          const fresh = await refreshLead(lead.id);
          if (fresh) lead = fresh;
          toast("Accepted: order created. Record the advance payment on the order.");
          await window.Orders?.renderLead(lead);
        } else {
          await sb.from("lead_activities").insert({
            lead_id: lead.id, type: "note", created_by: state.me.email, body: `Quotation ${q.quote_number} marked ${action}.`,
          });
          if (action === "accepted" && confirm("Mark this lead as Won?")) await updateLead(lead.id, { status: "won", deal_value: q.total });
        }
        await Promise.all([loadQuotes(), loadActivity(lead.id)]);
      }
    } catch (err) {
      tab?.close();
      toast("Something went wrong: " + (err.message || err));
    }
  });

  // ---------- PDF ----------
  const PDF = { W: 210, M: 16, orange: [242, 98, 15], navy: [14, 34, 51], muted: [91, 102, 114] };
  const pdfDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

  // Brand band at the top of every Sun Power document (quotes, receipts, packing slips)
  function drawHeader(doc) {
    const { W, M, orange, navy } = PDF;
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
  }

  // Orange thank-you strip on every page
  function drawFooter(doc) {
    const { W, orange } = PDF;
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFillColor(...orange);
      doc.rect(0, 287, W, 10, "F");
      doc.setTextColor(255, 255, 255).setFontSize(8.5)
        .text(`Thank you for choosing Sun Power Solar Solutions  |  ${settings.phone || COMPANY_PHONE}${pages > 1 ? `  |  Page ${p} of ${pages}` : ""}`, W / 2, 293, { align: "center" });
    }
  }

  function buildPdf(q, c, survey) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const { W, M, orange, navy, muted } = PDF;
    const fmtDate = pdfDate;
    const estimate = q.kind === "estimate" ? q.range || {} : null;
    drawHeader(doc);

    // Title
    let y = 46;
    doc.setTextColor(...navy).setFont("helvetica", "bold").setFontSize(20)
      .text(estimate ? "APPROXIMATE ESTIMATE" : survey ? "FINAL QUOTATION" : "QUOTATION", M, y);
    if (survey || estimate) {
      doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...muted).text(estimate
        ? "Not a final quote: the exact size and price are confirmed after our free site survey"
        : `Based on site survey${survey.visited_at ? ` on ${fmtDate(survey.visited_at + "T00:00:00")}` : ""}`, M, y + 5);
    }
    doc.setFontSize(9).setFont("helvetica", "normal").setTextColor(...muted);
    doc.text(`${estimate ? "Estimate" : "Quote"} no: ${q.quote_number}`, W - M, y - 7, { align: "right" });
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
    const kwShown = estimate ? estimate.kw_low || q.system_size_kw : q.system_size_kw;
    const monthlyUnits = kwShown * UNITS_PER_KW_MONTH;
    doc.setTextColor(...navy).setFont("helvetica", "bold").setFontSize(11)
      .text(`${estimate ? `About ${estimate.kw_low}–${estimate.kw_high}` : q.system_size_kw} kW ${SYSTEM_TYPES[q.system_type]}`, col2 + 5, y + 12.5);
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(60, 60, 60).text([
      `Est. generation: ~${Math.round(monthlyUnits)} units / month`,
      `Est. savings: ~${rs(monthlyUnits * TARIFF)} / month`,
      `Roof space needed: ~${Math.round(kwShown * 100)} sq ft`,
    ], col2 + 5, y + 18);

    // Price table. Final quotes from products show quantities and unit prices.
    y += 38;
    const withQty = !estimate && c.items.some((i) => i.qty !== undefined);
    const head = withQty ? [["#", "Description", "Qty", "Unit price", "Amount"]] : [["#", "Description", "Amount"]];
    const span = head[0].length - 1;
    const foot = (label, value) => ["", { content: label, colSpan: span - 1 }, value];
    const body = estimate
      ? [[1, `About ${estimate.kw_low}–${estimate.kw_high} kW ${SYSTEM_TYPES[q.system_type]} rooftop solar system: supply, installation & commissioning`,
        `${rs(estimate.total_low)} – ${rs(estimate.total_high)}`]]
      : c.items.map((i, n) => withQty
        ? [n + 1, i.description, i.qty !== undefined ? `${i.qty} ${i.unit || ""}`.trim() : "", i.unit_price !== undefined ? rs(i.unit_price) : "", rs(i.amount)]
        : [n + 1, i.description, rs(i.amount)]);
    const footRows = estimate
      ? [
        foot(`Approximate total (incl. GST, ± ${estimate.margin_percent ?? 10}%)`, `${rs(estimate.total_low)} – ${rs(estimate.total_high)}`),
        ...(estimate.subsidy ? [
          foot("Less: PM Surya Ghar subsidy (up to)*", `- ${rs(estimate.subsidy)}`),
          foot("Approximate cost after subsidy", `${rs(estimate.net_low)} – ${rs(estimate.net_high)}`),
        ] : []),
      ]
      : [
        foot("Taxable value", rs(c.subtotal)),
        foot(c.gstLabel ? c.gstLabel.replace(/^GST \(/, "GST @ ").replace(/\)$/, "") : `GST @ ${settings.gst_percent || 0}%`, rs(c.gst)),
        foot("Total (incl. GST)", rs(c.total)),
        ...(c.subsidy ? [
          foot("Less: PM Surya Ghar subsidy*", `- ${rs(c.subsidy)}`),
          foot("Effective cost after subsidy", rs(c.net)),
        ] : []),
      ];
    doc.autoTable({
      startY: y, margin: { left: M, right: M },
      head, body, foot: footRows,
      theme: "grid",
      styles: { font: "helvetica", fontSize: 9.5, cellPadding: 3, lineColor: [230, 225, 218] },
      headStyles: { fillColor: navy, textColor: 255 },
      footStyles: { fillColor: [248, 246, 242], textColor: navy, fontStyle: "bold" },
      columnStyles: withQty
        ? { 0: { cellWidth: 10, halign: "center" }, 2: { cellWidth: 20, halign: "right" }, 3: { cellWidth: 28, halign: "right" }, 4: { cellWidth: 32, halign: "right" } }
        : { 0: { cellWidth: 10, halign: "center" }, 2: { cellWidth: estimate ? 56 : 40, halign: "right" } },
      didParseCell: (d) => {
        if (d.section !== "foot") return;
        if (d.column.index === span) d.cell.styles.halign = "right";
        if (/Total|Effective|after subsidy/.test(d.row.raw[1].content)) d.cell.styles.textColor = orange;
      },
    });
    y = doc.lastAutoTable.finalY + 4;
    if (estimate ? estimate.subsidy : c.subsidy) {
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
      if (y + 12 + comp.length * 5.5 > 282) { doc.addPage(); y = 20; }
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
      estimate
        ? "This is an approximate estimate, not a final quote. The exact system size and price are confirmed after our free site survey."
        : survey ? null : "Final system design and price are confirmed after the free site survey.",
      `This ${estimate ? "estimate" : "quotation"} is valid until ${fmtDate(q.valid_until + "T00:00:00")}.`,
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

    drawFooter(doc);
    return doc;
  }

  window.Quotes = {
    open, prepareFinal, loadSettings, getSettings: () => settings, rs,
    pdf: { ...PDF, header: drawHeader, footer: drawFooter, date: pdfDate },
  };
})();
