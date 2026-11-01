// Supabase Edge Function: WhatsApp quotes and questions to a lead through Twilio.
//
// From the CRM (staff login):
//   { kind: "quote", lead_id, quote_id }      → send an existing quote with its PDF attached
//   { kind: "ask",   lead_id, questions: [] } → ask for missing quote details
//   { kind: "receipt", lead_id, payment_id } → send a payment receipt with its PDF attached
//   { kind: "invoice", lead_id, invoice_id } → send a GST tax invoice with its PDF attached
// From the call-results function after an AI call (header x-internal-token = BOLNA_WEBHOOK_TOKEN):
//   { kind: "auto", lead_id, execution_id }   → ask for missing details, or send an APPROXIMATE estimate + survey booking
// From Twilio when the customer replies (set as the WhatsApp "when a message comes in" URL):
//   form post, signed by Twilio → read the answers / chosen survey day, then ask what's missing, book the survey or send the estimate;
//   a clear "yes" to the latest FINAL quote accepts it (the database creates the order) → reply with payment instructions;
//   a message from a number that isn't a lead yet becomes a new lead, only when switched on in Quote settings
// From the database when an order is confirmed (pg_net from public.confirm_order, no login):
//   { kind: "order_confirmed", order_id } → payment received + installation date. Sent once per order (orders.confirmation_sent_at).
//   { kind: "installation_complete", order_id } → system installed, balance + warranty. Sent once (orders.install_message_sent_at).
//   { kind: "ticket", ticket_id, event } → service ticket created / visit booked / resolved. Each sent once (service_tickets.notified).
//   { kind: "passport", order_id } → order completed: create the Localhost users login and send it. Once (orders.passport_sent_at).
// From the CRM (staff login): { kind: "passport_reset", lead_id } → new Localhost users password, sent on WhatsApp and shown to staff.
// The exact FINAL quote is built in the CRM after the engineer's survey is approved, then sent with { kind: "quote" }.
//
// Secrets (Edge Functions → Secrets): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, BOLNA_WEBHOOK_TOKEN, GEMINI_API_KEY,
// optional TWILIO_WHATSAPP_FROM (defaults to the Twilio sandbox number +14155238886),
// optional TWILIO_QUOTE_CONTENT_SID / TWILIO_ASK_CONTENT_SID (Meta-approved templates for a live sender).

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const FROM = (Deno.env.get("TWILIO_WHATSAPP_FROM") || "+14155238886").replace(/^whatsapp:/, "");
const QUOTE_TEMPLATE = Deno.env.get("TWILIO_QUOTE_CONTENT_SID") ?? "";
const ASK_TEMPLATE = Deno.env.get("TWILIO_ASK_CONTENT_SID") ?? "";
const INTERNAL_TOKEN = Deno.env.get("BOLNA_WEBHOOK_TOKEN") ?? "";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const COMPANY = "Sun Power Solar Solutions";
const COMPANY_PHONE = "+91 93426 26096";
const UNITS_PER_KW_MONTH = 120;
const TARIFF = 8; // ₹ per unit, for the savings estimate
const SYSTEM_TYPES: Record<string, string> = { on_grid: "On-grid", hybrid: "Hybrid (with battery)", off_grid: "Off-grid (battery)", panel_set: "Solar panel set" };
const STAGE_RANK: Record<string, number> = { new: 0, ai_called: 1, interested: 2, survey_booked: 3, survey_done: 4, survey_approved: 5, quote_sent: 6 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const rs = (n: number) => "Rs. " + Math.round(Number(n) || 0).toLocaleString("en-IN");
const inr = (n: number) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const round2 = (n: number) => Math.round(n * 100) / 100;
const longDate = (d: string) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

// Plain-language explanations of the Twilio errors staff are likely to hit
const TWILIO_HINTS: Record<number, string> = {
  20003: "Twilio rejected the Account SID / Auth Token. Check both secrets in Supabase.",
  21211: "The customer's phone number isn't valid.",
  21608: "This number can't receive messages from your Twilio account (trial accounts can only message verified numbers).",
  63007: "The 'From' WhatsApp number isn't set up in Twilio.",
  63015: "Sandbox: this phone hasn't joined the sandbox. Send the join code to the sandbox number from that phone first.",
  63016: "WhatsApp only allows free-form messages within 24 hours of the customer's last message. Ask them to message you first (sandbox: re-send the join code), or use an approved template.",
};

// ---------- Who is calling ----------
async function staffEmail(req: Request): Promise<string | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await sb.auth.getUser(token);
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: staff } = await sb.from("staff").select("email").ilike("email", email).maybeSingle();
  return staff ? email : null;
}

// ---------- Twilio ----------
async function sendWhatsApp(to: string, msg: { body?: string; mediaUrl?: string; contentSid?: string; variables?: Record<string, string> }) {
  const form = new URLSearchParams({ From: `whatsapp:${FROM}`, To: `whatsapp:${to}` });
  if (msg.contentSid) {
    form.set("ContentSid", msg.contentSid);
    if (msg.variables) form.set("ContentVariables", JSON.stringify(msg.variables));
  } else {
    if (msg.body) form.set("Body", msg.body);
    if (msg.mediaUrl) form.set("MediaUrl", msg.mediaUrl);
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = Number(data.code) || 0;
    throw new Error(TWILIO_HINTS[code] ?? `${data.message ?? `Twilio HTTP ${res.status}`}${code ? ` (code ${code})` : ""}`);
  }
  return data as { sid: string; status: string };
}

// ---------- What we know about the lead (same rules as the CRM's quotes.js) ----------
const isHome = (l: Row) => /home|house|villa|apartment|flat|independent|residential|bungalow/i.test(l.property_type || "");
const firstNameOf = (l: Row) => String(l.name || "").trim().split(/\s+/)[0] || "there";

function systemTypeKey(text: string | null): string | null {
  const t = (text || "").toLowerCase();
  if (/hybrid/.test(t)) return "hybrid";
  if (/off[\s-]?grid|battery/.test(t)) return "off_grid";
  if (/on[\s-]?grid|grid[\s-]?tied|net[\s-]?meter/.test(t)) return "on_grid";
  return null;
}

function billAmount(text: string | null): number | null {
  const nums = (text || "").replace(/,/g, "").match(/\d+(\.\d+)?/g)?.map(Number).filter((n) => n >= 100) ?? [];
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function sizeFromLead(l: Row): number | null {
  const kw = parseFloat(String(l.system_size || "").replace(/[^\d.]/g, ""));
  if (kw > 0) return kw;
  const bill = billAmount(l.monthly_bill);
  return bill ? Math.max(1, Math.round((bill / TARIFF / UNITS_PER_KW_MONTH) * 2) / 2) : null;
}

function missingQuestions(l: Row): string[] {
  const checks: [boolean, string][] = [
    [!l.property_type || /not specified/i.test(l.property_type), "Is it an independent house, apartment, shop or factory?"],
    [!l.owns_property || /unknown/i.test(l.owns_property), "Do you own the property? (If it's rented, we'll need the owner's permission.)"],
    [!l.roof_type, "Is the roof concrete (RCC), metal sheet or tiled?"],
    [!l.roof_area, "Roughly how much free, shade-free roof space is there (in sq ft)?"],
    [!billAmount(l.monthly_bill), "What is your average monthly electricity bill (₹)?"],
    [!systemTypeKey(l.system_type), "Would you like on-grid (lowest cost, no battery) or battery backup for power cuts?"],
  ];
  if (isHome(l)) {
    checks.push([!l.wants_subsidy || /not specified/i.test(l.wants_subsidy),
      "Would you like us to apply for the PM Surya Ghar subsidy (up to ₹78,000) for you?"]);
  }
  return checks.filter(([missing]) => missing).map(([, q]) => q);
}

// ---------- Prices ----------
function calculate(settings: Row, l: Row, kw: number, type: string) {
  const items = [
    { description: `${kw} kW ${SYSTEM_TYPES[type]} rooftop solar system: supply, installation & commissioning`, amount: (Number(settings[`price_${type}`]) || 0) * kw },
  ];
  const netMetering = Number(settings.net_metering_charges) || 0;
  if (netMetering && type !== "off_grid") items.push({ description: "Net metering & DISCOM approval charges", amount: netMetering });
  const other = Number(settings.other_charges) || 0;
  if (other) items.push({ description: settings.other_charges_label || "Other charges", amount: other });

  const sum = items.reduce((a, i) => a + i.amount, 0);
  const gstRate = (Number(settings.gst_percent) || 0) / 100;
  let subtotal: number, gst: number, total: number;
  if (settings.prices_include_gst === "true" || settings.prices_include_gst === true) {
    total = sum;
    subtotal = gstRate ? total / (1 + gstRate) : total;
    gst = total - subtotal;
  } else {
    subtotal = sum;
    gst = subtotal * gstRate;
    total = subtotal + gst;
  }
  const eligible = settings.apply_subsidy && isHome(l) && type !== "off_grid" && !/^no/i.test(l.wants_subsidy || "");
  const subsidy = eligible ? Math.min(kw, 2) * 30000 + Math.max(0, Math.min(kw - 2, 1)) * 18000 : 0;
  return { items, subtotal, gst, total, subsidy, net: total - subsidy };
}

// ---------- Sending ----------
async function sendQuote(l: Row, q: Row, by: string) {
  // Twilio downloads the PDF from this link; the customer can also reopen it later
  const days = Math.max(7, Math.ceil((new Date(q.valid_until).getTime() - Date.now()) / 864e5) + 30);
  const { data: signed, error } = await sb.storage.from("quotes").createSignedUrl(q.pdf_path, days * 86400);
  if (error) throw error;

  const firstName = firstNameOf(l);
  const system = `${q.system_size_kw} kW ${SYSTEM_TYPES[q.system_type] ?? q.system_type}`;
  const isFinal = q.kind === "final";
  const range = q.kind === "estimate" ? q.range : null;
  const lines = [
    `Hello ${firstName}, thank you for choosing ${COMPANY}!`,
    "",
    isFinal
      ? `Here is your *FINAL quotation* ${q.quote_number}, based on our engineer's site survey:`
      : q.kind === "estimate"
      ? `Here is your *APPROXIMATE ESTIMATE* ${q.quote_number} (not a final quote):`
      : `Here is your solar quotation ${q.quote_number}:`,
  ];
  if (range) {
    lines.push(`• System: about ${range.kw_low}–${range.kw_high} kW ${SYSTEM_TYPES[q.system_type] ?? q.system_type} rooftop solar`,
      `• Approximate price: ${rs(range.total_low)} – ${rs(range.total_high)} (incl. GST)`);
    if (Number(range.subsidy) > 0) lines.push(`• After PM Surya Ghar subsidy: about ${rs(range.net_low)} – ${rs(range.net_high)}`);
  } else {
    lines.push(`• System: ${system} rooftop solar`, `• Total price: ${rs(q.total)} (incl. GST)`);
    if (Number(q.subsidy) > 0) {
      lines.push(`• Govt. subsidy (PM Surya Ghar): ${rs(q.subsidy)}, credited to your bank account after installation`);
      lines.push(`• Effective cost after subsidy: ${rs(q.net_payable)}`);
    }
  }
  lines.push(`• Valid until: ${longDate(q.valid_until)}`, "", `Your ${q.kind === "estimate" ? "estimate" : "quotation"} PDF is attached.`);
  if (q.kind === "estimate") lines.push("The exact price is confirmed after our free site survey.");
  if (isFinal) lines.push("", "Happy with it? Just reply *YES* here to go ahead and we'll send the payment details.");
  lines.push(`Any questions? Reply here or call ${COMPANY_PHONE}.`);

  const sent = QUOTE_TEMPLATE
    ? await sendWhatsApp(l.phone, {
      contentSid: QUOTE_TEMPLATE,
      variables: { "1": firstName, "2": q.quote_number, "3": system, "4": rs(q.total), "5": longDate(q.valid_until), "6": signed.signedUrl },
    })
    : await sendWhatsApp(l.phone, { body: lines.join("\n"), mediaUrl: signed.signedUrl });

  await sb.from("quotes").update({ status: q.status === "draft" ? "sent" : q.status, sent_at: new Date().toISOString() }).eq("id", q.id);
  // An estimate isn't a quote: the lead only reaches "Quote sent" with the final quote
  if (q.kind !== "estimate" && l.status in STAGE_RANK && STAGE_RANK[l.status] < STAGE_RANK.quote_sent) {
    await sb.from("leads").update({ status: "quote_sent" }).eq("id", l.id);
  }
  await sb.from("lead_activities").insert({
    lead_id: l.id, type: "note", created_by: by,
    body: `${q.kind === "estimate" ? "Approximate estimate" : isFinal ? "FINAL quotation" : "Quotation"} ${q.quote_number} sent on WhatsApp to ${l.phone} with the PDF attached (Twilio ${sent.status}).`,
  });
  return sent;
}

async function sendQuestions(l: Row, questions: string[], by: string) {
  const body = [
    `Hello ${firstNameOf(l)}, this is ${COMPANY}. Thank you for your interest in rooftop solar!`,
    "",
    "To prepare an accurate quotation for you, could you please share:",
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    `You can reply here or call us on ${COMPANY_PHONE}.`,
  ].join("\n");
  const sent = ASK_TEMPLATE
    ? await sendWhatsApp(l.phone, { contentSid: ASK_TEMPLATE, variables: { "1": firstNameOf(l), "2": questions.join(" ") } })
    : await sendWhatsApp(l.phone, { body });
  await sb.from("lead_activities").insert({
    lead_id: l.id, type: "note", created_by: by,
    body: `Missing quote details requested on WhatsApp (Twilio ${sent.status}):\n${questions.map((q) => `• ${q}`).join("\n")}`,
  });
  return sent;
}

// ---------- Automatic follow-up after an AI call ----------
// Missing details → ask on WhatsApp. Otherwise → approximate estimate + site survey booking.
// The exact quote only comes after the engineer's survey is approved (built in the CRM).
async function autoFollowUp(l: Row, executionId: string) {
  if (!l.consent) return { skipped: "no consent" };

  const questions = missingQuestions(l);
  if (questions.length) {
    await sendQuestions(l, questions, "AI advisor");
    return { asked: questions.length };
  }
  return await sendEstimate(l, executionId);
}

const fmtDay = (d: string) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const todayIstIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

async function upcomingSurvey(leadId: string): Promise<Row | null> {
  const { data } = await sb.from("meetings").select("*")
    .eq("lead_id", leadId).eq("type", "site_survey").eq("status", "scheduled")
    .gte("scheduled_date", todayIstIso()).order("scheduled_date").limit(1).maybeSingle();
  return data;
}

const SURVEY_ASK = "To give you an exact quote, our engineer will do a FREE site survey. Please reply with a day and time that suits you (Mon–Sat, morning 10–1 or afternoon 2–6).";

function surveyLine(m: Row | null): string {
  return m
    ? `✅ Free site survey booked: ${fmtDay(m.scheduled_date)}${m.time_slot ? `, ${m.time_slot}` : ""}. Our engineer will call you before visiting.`
    : SURVEY_ASK;
}

// Approximate price range: a size band around the suggested size, plus/minus the margin set in Quote settings
async function sendEstimate(l: Row, key: string) {
  const by = "AI advisor";
  const note = (body: string) => sb.from("lead_activities").insert({ lead_id: l.id, type: "note", created_by: by, body });

  const { data: row } = await sb.from("quote_settings").select("settings").eq("id", 1).maybeSingle();
  const settings: Row = row?.settings ?? {};
  const type = systemTypeKey(l.system_type) ?? "on_grid";
  const kw = sizeFromLead(l);
  if (!kw) return { skipped: "no system size" };
  if (!(Number(settings[`price_${type}`]) > 0)) {
    await note(`Automatic estimate skipped: no price set for ${SYSTEM_TYPES[type]} in Quote settings.`);
    return { skipped: "no price" };
  }

  // One estimate per call (or per WhatsApp reply), even if the event arrives twice
  const { data: existing } = await sb.from("quotes").select("id").eq("call_execution_id", key).maybeSingle();
  if (existing) return { skipped: "estimate already sent" };

  const margin = (Number(settings.estimate_margin_percent) || 10) / 100;
  const kwLow = kw;
  const kwHigh = kw + (kw < 5 ? 0.5 : 1);
  const low = calculate(settings, l, kwLow, type);
  const high = calculate(settings, l, kwHigh, type);
  const range = {
    kw_low: kwLow, kw_high: kwHigh, margin_percent: margin * 100,
    total_low: Math.round(low.total * (1 - margin)), total_high: Math.round(high.total * (1 + margin)),
    net_low: Math.round(low.total * (1 - margin) - low.subsidy), net_high: Math.round(high.total * (1 + margin) - high.subsidy),
    subsidy: high.subsidy,
  };
  const lakh = (n: number) => n >= 100000 ? `₹${(n / 100000).toFixed(2).replace(/0$/, "").replace(/\.0$/, "")} lakh` : `₹${Math.round(n).toLocaleString("en-IN")}`;

  const survey = await upcomingSurvey(l.id);
  const lines = [
    `Hello ${firstNameOf(l)}, thank you for speaking with ${COMPANY}!`,
    "",
    "*APPROXIMATE ESTIMATE* (not a final quote)",
    `• System: about ${kwLow}–${kwHigh} kW ${SYSTEM_TYPES[type]} rooftop solar`,
    `• Approximate price: ${lakh(range.total_low)} – ${lakh(range.total_high)} (incl. GST)`,
  ];
  if (range.subsidy > 0) {
    lines.push(`• After PM Surya Ghar subsidy (up to ${lakh(range.subsidy)}): about ${lakh(range.net_low)} – ${lakh(range.net_high)}`);
  }
  lines.push("", "The exact system size and final price will be confirmed after our engineer's site survey.", "", surveyLine(survey), "",
    `Questions? Reply here or call ${COMPANY_PHONE}.`);

  const sent = await sendWhatsApp(l.phone, { body: lines.join("\n") });

  const validUntil = new Date(Date.now() + 30 * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  await sb.from("quotes").insert({
    lead_id: l.id, created_by: by, source: "ai_call", call_execution_id: key, kind: "estimate", status: "sent",
    sent_at: new Date().toISOString(), system_type: type, system_size_kw: kwHigh, items: [], range,
    subtotal: round2(high.subtotal), gst_amount: round2(high.gst), total: range.total_high,
    subsidy: round2(range.subsidy), net_payable: range.net_high, valid_until: validUntil,
  });
  await note(`Approximate estimate sent on WhatsApp (Twilio ${sent.status}): ${kwLow}–${kwHigh} kW ${SYSTEM_TYPES[type]}, ${lakh(range.total_low)} – ${lakh(range.total_high)}. ${survey ? `Survey booked for ${fmtDay(survey.scheduled_date)}.` : "Asked the customer to pick a survey day."}`);
  return { estimate: true };
}

// Book the site survey the customer chose on WhatsApp
async function bookSurveyFromReply(l: Row, date: string, slot: string | null, by: string) {
  const { data: m, error } = await sb.from("meetings").insert({
    lead_id: l.id, type: "site_survey", scheduled_date: date, time_slot: slot?.slice(0, 60) ?? null,
    agenda: "Free site survey: roof, shading, cable routing and electrical check", source: "ai_call", created_by: by,
  }).select().single();
  if (error) throw error;
  const patch: Row = { follow_up_date: date };
  if (l.status in STAGE_RANK && STAGE_RANK[l.status] < STAGE_RANK.survey_booked) patch.status = "survey_booked";
  await sb.from("leads").update(patch).eq("id", l.id);
  const sent = await sendWhatsApp(l.phone, { body: `Thank you ${firstNameOf(l)}! ${surveyLine(m)}` });
  await sb.from("lead_activities").insert({
    lead_id: l.id, type: "note", created_by: by,
    body: `Site survey booked from the customer's WhatsApp reply: ${fmtDay(date)}${slot ? `, ${slot}` : ""} (Twilio ${sent.status}).`,
  });
}

// ---------- Orders and payments ----------
async function quoteSettings(): Promise<Row> {
  const { data } = await sb.from("quote_settings").select("settings").eq("id", 1).maybeSingle();
  return data?.settings ?? {};
}

// UPI link (with the amount and order number filled in) and bank details from Quote settings
function paymentLines(settings: Row, amount: number, orderNumber: string): string[] {
  const lines: string[] = [];
  const upi = String(settings.upi_id || "").trim();
  if (upi) {
    const link = `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent("Sun Power Solar")}&am=${amount.toFixed(2)}&tn=${encodeURIComponent(orderNumber)}&cu=INR`;
    lines.push(`• UPI: ${upi}`, `  Pay from your phone: ${link}`);
  }
  const bank = String(settings.bank_details || "").trim();
  if (bank) lines.push("• Bank transfer:", ...bank.split(/\r?\n/).filter(Boolean).map((b) => `  ${b}`));
  if (!lines.length) lines.push(`• Call us on ${COMPANY_PHONE} for the payment details.`);
  lines.push(`Please mention *${orderNumber}* as the payment note / reference.`);
  return lines;
}

const systemLabel = (o: Row) => `${Number(o.system_size_kw) || ""} kW ${SYSTEM_TYPES[o.system_type] ?? o.system_type ?? ""}`.trim();

// The customer accepted the final quote on WhatsApp: the database creates the order, we send the payment details
async function acceptQuoteFromReply(l: Row, q: Row) {
  const { data: updated } = await sb.from("quotes").update({ status: "accepted", accepted_via: "whatsapp" })
    .eq("id", q.id).eq("status", "sent").select("id");
  if (!updated?.length) return; // already accepted (Twilio retried)

  const { data: o } = await sb.from("orders").select("*").eq("quote_id", q.id).maybeSingle();
  if (!o) throw new Error(`Quotation ${q.quote_number} accepted, but the order wasn't created`);
  const advance = Number(o.advance_required) || Number(o.total);
  const lines = [
    `Thank you ${firstNameOf(l)}! 🎉 Your quotation ${q.quote_number} is accepted.`,
    "",
    `Order number: *${o.order_number}*`,
    `• System: ${systemLabel(o)} rooftop solar`,
    `• Total: ${inr(o.total)} (incl. GST)`,
    `• Advance to confirm the order: *${inr(advance)}* (or pay the full amount)`,
  ];
  if (Number(o.subsidy) > 0) lines.push(`• Govt. subsidy of ${inr(o.subsidy)} is credited to your bank account after installation`);
  lines.push("", "How to pay:", ...paymentLines(await quoteSettings(), advance, o.order_number), "",
    "As soon as the advance reaches us, we book your installation and send you the date.",
    `Questions? Reply here or call ${COMPANY_PHONE}.`);
  const sent = await sendWhatsApp(l.phone, { body: lines.join("\n") });
  await sb.from("lead_activities").insert({
    lead_id: l.id, type: "note", created_by: "AI advisor",
    body: `Customer accepted quotation ${q.quote_number} on WhatsApp. Order ${o.order_number} created; payment details sent (advance ${inr(advance)}, Twilio ${sent.status}).`,
  });
}

// From the database (public.confirm_order): payment received + installation date. Only ever sent once per order.
async function sendOrderConfirmed(orderId: string) {
  const { data: o } = await sb.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!o) return { skipped: "order not found" };
  if (o.confirmation_sent_at) return { skipped: "already sent" };
  if (!["confirmed", "packing", "packed"].includes(o.status)) return { skipped: `order is ${o.status}` };

  // Claim it first, so a repeated call can't message the customer twice
  const { data: claimed } = await sb.from("orders").update({ confirmation_sent_at: new Date().toISOString() })
    .eq("id", o.id).is("confirmation_sent_at", null).select("id");
  if (!claimed?.length) return { skipped: "already sent" };

  const { data: l } = await sb.from("leads").select("*").eq("id", o.lead_id).maybeSingle();
  if (!l?.consent) return { skipped: "no consent" };
  const { data: job } = await sb.from("install_jobs").select("scheduled_date, time_slot")
    .eq("order_id", o.id).neq("status", "cancelled").maybeSingle();

  const lines = [
    `Hi ${firstNameOf(l)}, we've received your payment of ${inr(o.amount_paid)} for order ${o.order_number}.`,
    job
      ? `Your ${systemLabel(o)} installation is scheduled for ${fmtDay(job.scheduled_date)}, ${job.time_slot}.`
      : `Your ${systemLabel(o)} installation will be scheduled shortly; we'll message you the date.`,
    `Balance due: ${inr(o.balance)}.`,
  ];
  if (job) lines.push("Our crew lead will call you a day before.");
  lines.push("", `Thank you for choosing ${COMPANY}! Questions? Call ${COMPANY_PHONE}.`);

  try {
    const sent = await sendWhatsApp(l.phone, { body: lines.join("\n") });
    await sb.from("lead_activities").insert({
      lead_id: l.id, type: "note", created_by: "AI advisor",
      body: `Order confirmation sent on WhatsApp for ${o.order_number} (Twilio ${sent.status}).`,
    });
    return { sent: true };
  } catch (err) {
    // Not sent: allow another try
    await sb.from("orders").update({ confirmation_sent_at: null }).eq("id", o.id);
    await sb.from("lead_activities").insert({
      lead_id: l.id, type: "note", created_by: "AI advisor",
      body: `Order confirmation WhatsApp for ${o.order_number} failed: ${(err as Error).message}`,
    });
    throw err;
  }
}

// From the database (public.complete_installation): installed and switched on. Only ever sent once per order.
async function sendInstallationComplete(orderId: string) {
  const { data: o } = await sb.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!o) return { skipped: "order not found" };
  if (o.install_message_sent_at) return { skipped: "already sent" };
  if (!["installed", "completed"].includes(o.status)) return { skipped: `order is ${o.status}` };

  // Claim it first, so a repeated call can't message the customer twice
  const { data: claimed } = await sb.from("orders").update({ install_message_sent_at: new Date().toISOString() })
    .eq("id", o.id).is("install_message_sent_at", null).select("id");
  if (!claimed?.length) return { skipped: "already sent" };

  const { data: l } = await sb.from("leads").select("*").eq("id", o.lead_id).maybeSingle();
  if (!l?.consent) return { skipped: "no consent" };
  const { data: done } = await sb.from("install_jobs").select("finished_at, generation_kwh, crews(name)")
    .eq("order_id", o.id).eq("status", "done").maybeSingle();
  const job = done as Row | null;
  const crew = Array.isArray(job?.crews) ? job?.crews[0]?.name : job?.crews?.name;
  const settings = await quoteSettings();

  const lines = [
    `Hi ${firstNameOf(l)}, your ${systemLabel(o)} rooftop solar system is installed and switched on ✅`,
    "",
    `Order ${o.order_number}${crew ? ` · installed by ${crew}` : ""}`,
  ];
  if (job?.generation_kwh !== null && job?.generation_kwh !== undefined) lines.push(`• Generation at handover: ${job.generation_kwh} kWh`);
  lines.push(`• Total ${inr(o.total)} · paid ${inr(o.amount_paid)} · balance due *${inr(o.balance)}*`);
  if (Number(o.balance) > 0) lines.push("", "To pay the balance:", ...paymentLines(settings, Number(o.balance), o.order_number));
  const warranty = [
    settings.warranty_panel ? `Panels: ${settings.warranty_panel}` : "",
    settings.warranty_inverter ? `Inverter: ${settings.warranty_inverter}` : "",
    settings.warranty_installation ? `Installation: ${settings.warranty_installation}` : "",
  ].filter(Boolean);
  if (warranty.length) lines.push("", "Warranty:", ...warranty.map((w) => `• ${w}`));
  if (Number(o.subsidy) > 0) {
    lines.push("", `Next: we'll help you with the DISCOM inspection and the PM Surya Ghar subsidy claim (${inr(o.subsidy)} to your bank account).`);
  }
  lines.push("", `Thank you for choosing ${COMPANY}! For any service, call ${COMPANY_PHONE}.`);

  try {
    const sent = await sendWhatsApp(l.phone, { body: lines.join("\n") });
    await sb.from("lead_activities").insert({
      lead_id: l.id, type: "note", created_by: "AI advisor",
      body: `Installation-complete message sent on WhatsApp for ${o.order_number} (Twilio ${sent.status}).`,
    });
    return { sent: true };
  } catch (err) {
    // Not sent: allow another try
    await sb.from("orders").update({ install_message_sent_at: null }).eq("id", o.id);
    await sb.from("lead_activities").insert({
      lead_id: l.id, type: "note", created_by: "AI advisor",
      body: `Installation-complete WhatsApp for ${o.order_number} failed: ${(err as Error).message}`,
    });
    throw err;
  }
}

// ---------- Localhost users login ----------
// Readable random password without look-alike characters (0/O, 1/l/I). 216 = 4 × 54, so every character is equally likely.
function newPassword(length = 10): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const out: string[] = [];
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 216 && out.length < length) out.push(chars[b % chars.length]);
    }
  }
  return out.join("");
}

const passportUrl = (settings: Row) => String(settings.portal_url || "").trim() || "http://localhost:8080/portal/";
const loginPhone = (l: Row) => String(l.phone || "").replace(/^\+91/, "");

function passportText(l: Row, password: string | null, settings: Row, orderNumber: string | null): string {
  const lines = orderNumber
    ? [`Hi ${firstNameOf(l)}, order ${orderNumber} is fully paid and your solar system is handed over. Thank you! 🎉`, ""]
    : [`Hi ${firstNameOf(l)}, here is your new Localhost users password.`, ""];
  if (orderNumber && password) {
    lines.push("Your *Localhost users* login is ready: a warranty card for every unit with its serial number, your installation record, invoices and receipts, subsidy progress and service requests, all in one place.", "");
  }
  lines.push(`Open: ${passportUrl(settings)}`);
  if (password) {
    lines.push(`Phone number: ${loginPhone(l)}`, `Password: ${password}`, "", "Please set your own password when you sign in. Keep it private: Sun Power staff will never ask for it.");
  } else {
    lines.push("Sign in with your phone number and your password: this order now shows in Localhost users too.");
  }
  lines.push("", `Questions? Call ${COMPANY_PHONE}.`);
  return lines.join("\n");
}

// From the database (orders_zz_passport trigger): the order is completed. Only ever handled once per order.
async function sendPassport(orderId: string) {
  const { data: o } = await sb.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!o) return { skipped: "order not found" };
  if (o.passport_sent_at) return { skipped: "already sent" };
  if (o.status !== "completed") return { skipped: `order is ${o.status}` };
  const { data: claimed } = await sb.from("orders").update({ passport_sent_at: new Date().toISOString() })
    .eq("id", o.id).is("passport_sent_at", null).select("id");
  if (!claimed?.length) return { skipped: "already sent" };

  const { data: l } = await sb.from("leads").select("*").eq("id", o.lead_id).maybeSingle();
  if (!l) return { skipped: "lead not found" };
  const log = (body: string) => sb.from("lead_activities").insert({ lead_id: l.id, type: "note", created_by: "AI advisor", body });
  // A customer's second order: they already have a login, so no new password
  const { data: account } = await sb.from("customer_accounts").select("lead_id").eq("lead_id", l.id).maybeSingle();
  const password = account ? null : newPassword();
  if (password) {
    const { error } = await sb.rpc("set_customer_password", { p_lead_id: l.id, p_password: password, p_must_change: true, p_by: "automatic (order completed)" });
    if (error) throw new Error(error.message);
  }
  if (!l.consent) {
    await log(`Localhost users login ${password ? "created" : "updated"} for ${o.order_number}; not sent (no WhatsApp consent). Use "Localhost users" on the lead to give the customer a password.`);
    return { skipped: "no consent" };
  }
  try {
    const sent = await sendWhatsApp(l.phone, { body: passportText(l, password, await quoteSettings(), o.order_number) });
    await log(`Localhost users ${password ? "login" : "update"} sent on WhatsApp for ${o.order_number} (Twilio ${sent.status}).`);
    return { sent: true };
  } catch (err) {
    // The login exists; staff can send a new password from the lead
    await log(`Localhost users WhatsApp for ${o.order_number} failed: ${(err as Error).message}. Use "Localhost users" on the lead to send a new password.`);
    throw err;
  }
}

// From the CRM: a new password (forgotten, or the first one never arrived). Returned to staff so they can read it out.
async function resetPassport(l: Row, email: string) {
  const { data: who } = await sb.from("staff").select("role").ilike("email", email).maybeSingle();
  if (!["owner", "manager", "staff"].includes(who?.role)) return json({ error: "Only the office can send a customer a new password." }, 403);
  const { data: done } = await sb.from("orders").select("id").eq("lead_id", l.id).eq("status", "completed").limit(1);
  if (!done?.length) return json({ error: "The Localhost users opens once the customer's order is completed (fully paid)." }, 400);
  const password = newPassword();
  const { error } = await sb.rpc("set_customer_password", { p_lead_id: l.id, p_password: password, p_must_change: true, p_by: email });
  if (error) throw new Error(error.message);
  let whatsapp = "not sent: the customer hasn't agreed to WhatsApp messages";
  if (l.consent) {
    try {
      const sent = await sendWhatsApp(l.phone, { body: passportText(l, password, await quoteSettings(), null) });
      whatsapp = `sent on WhatsApp (Twilio ${sent.status})`;
    } catch (err) {
      whatsapp = `WhatsApp failed: ${(err as Error).message}`;
    }
  }
  await sb.from("lead_activities").insert({
    lead_id: l.id, type: "note", created_by: email, body: `New Localhost users password made by ${email}; ${whatsapp}.`,
  });
  return json({ ok: true, username: loginPhone(l), password, whatsapp });
}

// ---------- Service tickets (breakdowns and checkups) ----------
const TICKET_CATEGORY: Record<string, string> = {
  safety: "Sparks, smoke, burning smell or shock", no_generation: "No power from the system", low_generation: "Low generation",
  inverter_error: "Inverter error / beeping", tripping: "Breaker tripping", water_leak: "Water leak / water in the inverter or boxes",
  physical_damage: "Storm or physical damage", wiring: "Loose or damaged wiring", checkup: "Pre-monsoon checkup", other: "Other problem",
};
const PRIORITY_TIME: Record<string, string> = { urgent: "within 4 hours", high: "within 24 hours", normal: "within 3 days", low: "within a week" };
const SAFETY_ADVICE = "⚠️ For your safety: if you see sparks, smoke or water inside the inverter or ACDB, switch OFF the AC breaker and the DC isolator, keep children away and don't touch the panels or wires.";

// From the database (service_tickets trigger). The event key makes each message go out only once.
async function sendTicketUpdate(ticketId: string, event: string) {
  const { data: t } = await sb.from("service_tickets").select("*, crews(name)").eq("id", ticketId).maybeSingle();
  if (!t) return { skipped: "ticket not found" };
  const key = event === "scheduled" ? `s${String(t.visit_date ?? "").replace(/-/g, "")}${String(t.crew_id ?? "").slice(0, 8)}` : event;
  if (!["created", "scheduled", "resolved"].includes(event) || /[^A-Za-z0-9]/.test(key)) return { skipped: "unknown event" };
  if (t.notified?.[key]) return { skipped: "already sent" };
  const { data: claimed } = await sb.from("service_tickets").update({ notified: { ...(t.notified || {}), [key]: new Date().toISOString() } })
    .eq("id", t.id).is(`notified->>${key}`, null).select("id");
  if (!claimed?.length) return { skipped: "already sent" };

  const { data: l } = await sb.from("leads").select("*").eq("id", t.lead_id).maybeSingle();
  if (!l?.consent) return { skipped: "no consent" };
  const crew = (t as Row).crews?.name;
  const checkup = t.kind === "checkup";
  const lines: string[] = [];
  if (event === "created") {
    lines.push(`Hi ${firstNameOf(l)}, we've received your service request *${t.ticket_number}*.`, "",
      `• Problem: ${TICKET_CATEGORY[t.category] ?? t.category}`,
      `• We'll respond ${PRIORITY_TIME[t.priority] ?? "soon"}`);
    if (t.warranty_note) lines.push(`• ${t.warranty_status === "in_warranty" ? "Covered: " : ""}${t.warranty_note}`);
    if (["safety", "water_leak", "tripping"].includes(t.category)) lines.push("", SAFETY_ADVICE);
  } else if (event === "scheduled") {
    lines.push(checkup
      ? `Hi ${firstNameOf(l)}, your FREE pre-monsoon solar checkup is booked: *${fmtDay(t.visit_date)}, ${t.visit_slot ?? ""}*${crew ? ` (${crew})` : ""}.`
      : `Hi ${firstNameOf(l)}, a technician visit for ${t.ticket_number} is booked: *${fmtDay(t.visit_date)}, ${t.visit_slot ?? ""}*${crew ? ` (${crew})` : ""}.`);
    if (checkup) lines.push("", "Before the rains our crew will clean the panels, test the earthing, check cables and seal the junction boxes.");
    lines.push("", "Our crew will call you before coming. To change the time, reply here or call us.");
  } else {
    lines.push(checkup ? `Hi ${firstNameOf(l)}, your pre-monsoon checkup (${t.ticket_number}) is done ✅` : `Hi ${firstNameOf(l)}, your service request ${t.ticket_number} is resolved ✅`, "");
    if (t.cause) lines.push(`• Found: ${t.cause}`);
    if (t.work_done) lines.push(`• Work done: ${t.work_done}`);
    if (t.generation_kwh !== null && t.generation_kwh !== undefined) lines.push(`• Generation now: ${t.generation_kwh} kWh`);
    lines.push(Number(t.charge_amount) > 0
      ? `• Charges: ${inr(t.charge_amount)} + GST (${t.warranty_status === "not_covered" ? "not covered by warranty" : "warranty expired"}); your tax invoice follows`
      : "• Charges: free (under warranty)");
    lines.push("", "Please rate our service on your customer portal. Thank you!");
  }
  lines.push(`Questions? Call ${COMPANY_PHONE}.`);

  try {
    const sent = await sendWhatsApp(l.phone, { body: lines.join("\n") });
    await sb.from("lead_activities").insert({
      lead_id: l.id, type: "note", created_by: "AI advisor",
      body: `${t.ticket_number}: "${event}" message sent on WhatsApp (Twilio ${sent.status}).`,
    });
    return { sent: true };
  } catch (err) {
    // Not sent: allow another try
    const { [key]: _, ...rest } = { ...(t.notified || {}), [key]: "" };
    await sb.from("service_tickets").update({ notified: rest }).eq("id", t.id);
    await sb.from("lead_activities").insert({
      lead_id: l.id, type: "note", created_by: "AI advisor", body: `${t.ticket_number}: "${event}" WhatsApp failed: ${(err as Error).message}`,
    });
    throw err;
  }
}

async function sendInvoice(l: Row, inv: Row, by: string) {
  const { data: signed, error } = await sb.storage.from("invoices").createSignedUrl(inv.pdf_path, 30 * 86400);
  if (error) throw error;
  const lines = [
    `Hello ${firstNameOf(l)}, here is your GST tax invoice from ${COMPANY}.`,
    "",
    `• Invoice ${inv.invoice_number}, dated ${longDate(inv.invoice_date)}`,
    `• Amount: ${inr(inv.total)} (incl. GST)`,
  ];
  if (inv.kind === "service" && !inv.paid_on) {
    lines.push("", "To pay:", ...paymentLines(await quoteSettings(), Number(inv.total), inv.invoice_number));
  }
  lines.push("", "Your invoice PDF is attached.", `Questions? Call ${COMPANY_PHONE}.`);
  const sent = await sendWhatsApp(l.phone, { body: lines.join("\n"), mediaUrl: signed.signedUrl });
  await sb.from("invoices").update({ sent_at: new Date().toISOString() }).eq("id", inv.id);
  await sb.from("lead_activities").insert({
    lead_id: l.id, type: "note", created_by: by,
    body: `Tax invoice ${inv.invoice_number} (${inr(inv.total)}) sent on WhatsApp with the PDF attached (Twilio ${sent.status}).`,
  });
  return sent;
}

async function sendReceipt(l: Row, p: Row, by: string) {
  const { data: o, error: orderError } = await sb.from("orders").select("*").eq("id", p.order_id).single();
  if (orderError) throw orderError;
  const { data: signed, error } = await sb.storage.from("receipts").createSignedUrl(p.receipt_pdf_path, 30 * 86400);
  if (error) throw error;

  const lines = [
    `Hello ${firstNameOf(l)}, thank you for your payment!`,
    "",
    `Receipt ${p.receipt_number} for order ${o.order_number}:`,
    `• Received: ${inr(p.amount)} on ${longDate(p.paid_on)}`,
    `• Paid so far: ${inr(o.amount_paid)} of ${inr(o.total)}`,
    `• Balance due: ${inr(o.balance)}`,
    "",
    "Your receipt PDF is attached.",
  ];
  if (Number(o.balance) > 0 && o.status !== "cancelled") {
    lines.push("", "To pay the balance:", ...paymentLines(await quoteSettings(), Number(o.balance), o.order_number));
  }
  lines.push(`Questions? Reply here or call ${COMPANY_PHONE}.`);

  const sent = await sendWhatsApp(l.phone, { body: lines.join("\n"), mediaUrl: signed.signedUrl });
  await sb.from("lead_activities").insert({
    lead_id: l.id, type: "note", created_by: by,
    body: `Receipt ${p.receipt_number} (${inr(p.amount)}) sent on WhatsApp with the PDF attached (Twilio ${sent.status}).`,
  });
  return sent;
}

// ---------- Customer replies on WhatsApp (Twilio "when a message comes in" webhook) ----------
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite"];
// The exact public URL Twilio posts to; Twilio signs requests with it
const INBOUND_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-whatsapp`;

// Twilio signs each webhook: base64(HMAC-SHA1(auth token, url + sorted key/value pairs))
async function validTwilioSignature(signature: string | null, params: URLSearchParams): Promise<boolean> {
  if (!signature) return false;
  const keys = [...new Set(params.keys())].sort();
  const data = INBOUND_URL + keys.map((k) => k + params.getAll(k).join("")).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(AUTH_TOKEN), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...mac)) === signature;
}

// Gemini reads the customer's reply against what we asked (missing details, a survey day and/or "go ahead" on the final quote)
async function readReply(questions: string[], reply: string, askedForSurvey: boolean, quoteNumber: string | null = null): Promise<Row> {
  const nullable = { type: ["string", "null"] };
  const schema: Row = {
    type: "object",
    properties: {
      property_type: { ...nullable, description: "Independent house, apartment, villa, shop, factory, etc." },
      owns_property: { ...nullable, description: "Yes or No." },
      roof_type: { ...nullable, description: "RCC, metal sheet, tiled, etc." },
      roof_area: { ...nullable, description: "Free roof space, e.g. '400 sq ft'." },
      monthly_bill: { ...nullable, description: "Monthly electricity bill, e.g. '₹3,000'." },
      system_type: { ...nullable, description: "On-grid, Hybrid or Off-grid (battery)." },
      wants_subsidy: { ...nullable, description: "Yes or No." },
      survey_date: { ...nullable, description: "Day the customer chose for the site survey, as YYYY-MM-DD. Must be today or later and not a Sunday." },
      survey_time_slot: { ...nullable, description: "Time they chose, e.g. 'Morning 10–1', 'Afternoon 2–6' or '11 AM'." },
    },
    required: ["property_type", "owns_property", "roof_type", "roof_area", "monthly_bill", "system_type", "wants_subsidy", "survey_date", "survey_time_slot"],
  };
  const today = new Date(Date.now() + 330 * 60_000);
  const asked = [...questions];
  if (askedForSurvey) asked.push("Which day and time suits you for a free site survey (Mon–Sat, morning 10–1 or afternoon 2–6)?");
  if (quoteNumber) {
    asked.push(`We sent you final quotation ${quoteNumber}. Reply YES to go ahead.`);
    schema.properties.accepts_quote = {
      type: "boolean",
      description: `True only if the customer clearly accepts quotation ${quoteNumber} and wants to go ahead (e.g. 'yes', 'ok go ahead', 'accepted', 'confirm'). False if it's unclear, a question, a negotiation, a delay or a refusal.`,
    };
    schema.required.push("accepts_quote");
  }
  const prompt = [
    "A solar company asked a customer these questions on WhatsApp:",
    ...asked.map((q, i) => `${i + 1}. ${q}`),
    "",
    `The customer replied: "${reply.slice(0, 2000)}"`,
    "",
    `Today in India is ${today.toISOString().slice(0, 10)} (${today.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}).`,
    "Extract only answers the customer actually gave. A one-word reply like 'yes' or 'no' answers the question(s) above.",
    "Resolve days like 'tomorrow' or 'Tuesday' to a YYYY-MM-DD date. Use null for anything not answered. Never guess.",
  ].join("\n");

  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0 },
        }),
      });
      if (!res.ok) continue; // busy or unavailable: next model
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      // try the next model
    }
  }
  throw new Error("Gemini couldn't read the reply");
}

const twiml = () => new Response("<Response></Response>", { headers: { "Content-Type": "text/xml" } });

// A WhatsApp enquiry from someone who isn't a lead yet. Off unless "WhatsApp enquiries from new numbers" is ticked in
// Quote settings; the AI agent only calls them if "…also let the AI agent call them" is ticked too.
async function newLeadFromWhatsApp(from: string, message: string, profileName: string | null): Promise<Response> {
  const settings = await quoteSettings();
  const on = (k: string) => settings[k] === true || settings[k] === "true";
  if (!on("whatsapp_new_leads") || !/^\+91[6-9]\d{9}$/.test(from)) return twiml();
  const name = (profileName || "").replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 80);
  const { data: lead, error } = await sb.from("leads").insert({
    name: name.length >= 2 ? name : "WhatsApp enquiry", phone: from, location: "Not given yet (WhatsApp)", consent: true,
    source: "whatsapp", ai_call_status: on("whatsapp_new_lead_ai_call") ? null : "stopped", // the call function only calls leads with no call status
  }).select().single();
  if (error || !lead) return twiml();
  await sb.from("lead_activities").insert({
    lead_id: lead.id, type: "note", created_by: "Customer (WhatsApp)", body: `New enquiry on WhatsApp: ${message.slice(0, 4000)}`,
  });
  try {
    await sendWhatsApp(from, {
      body: [`Hello${name.length >= 2 ? ` ${name.split(" ")[0]}` : ""}, thank you for contacting ${COMPANY}! ☀️`, "",
        "Our solar advisor will call you shortly. To help us prepare, please reply with:",
        "1. Your area / pincode", "2. Your average monthly electricity bill (₹)", "3. House, shop or factory?", "",
        `Or call us on ${COMPANY_PHONE}.`].join("\n"),
    });
  } catch {
    // the lead is saved either way; the team follows up
  }
  return twiml();
}

async function handleInbound(req: Request): Promise<Response> {
  const params = new URLSearchParams(await req.text());
  if (!(await validTwilioSignature(req.headers.get("x-twilio-signature"), params))) {
    return new Response("Invalid signature", { status: 403 });
  }

  const from = (params.get("From") ?? "").replace(/^whatsapp:/, "");
  const reply = (params.get("Body") ?? "").trim();
  const messageSid = params.get("MessageSid") ?? crypto.randomUUID();
  if (!from || !reply || /^join\s/i.test(reply)) return twiml(); // ignore sandbox join messages

  // Latest lead with this phone number
  const { data: l } = await sb.from("leads").select("*").eq("phone", from).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!l) return await newLeadFromWhatsApp(from, reply, params.get("ProfileName"));

  await sb.from("lead_activities").insert({
    lead_id: l.id, type: "note", created_by: "Customer (WhatsApp)", body: `WhatsApp reply: ${reply.slice(0, 4000)}`,
  });
  if (!l.consent || /^(stop|unsubscribe)$/i.test(reply)) return twiml();

  // What are we waiting for: a "yes" to the latest final quote, or else missing quote details and/or a survey day
  const { data: finalQuote } = await sb.from("quotes").select("*").eq("lead_id", l.id).eq("kind", "final")
    .in("status", ["sent", "accepted"]).order("sent_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  const pendingQuote = finalQuote?.status === "sent" ? finalQuote : null;
  const questions = finalQuote ? [] : missingQuestions(l); // after the survey, the engineer's findings count
  const { data: estimate } = await sb.from("quotes").select("id").eq("lead_id", l.id).eq("kind", "estimate").limit(1).maybeSingle();
  const awaitingSurvey = !finalQuote && Boolean(estimate) && !(await upcomingSurvey(l.id));
  if ((!questions.length && !awaitingSurvey && !pendingQuote) || !GEMINI_API_KEY) return twiml(); // nothing pending: the team handles it

  try {
    const answers = await readReply(questions, reply, awaitingSurvey, pendingQuote?.quote_number ?? null);
    const { survey_date, survey_time_slot, accepts_quote, ...details } = answers ?? {};

    // A clear yes to the final quote → accepted, order created, payment details sent. Anything unclear: the team follows up.
    if (pendingQuote) {
      if (accepts_quote === true) await acceptQuoteFromReply(l, pendingQuote);
      return twiml();
    }

    const patch: Row = {};
    const limits: Row = { property_type: 40, monthly_bill: 40, system_type: 40, wants_subsidy: 40 };
    for (const [k, v] of Object.entries(details)) {
      if (typeof v === "string" && v.trim()) patch[k] = v.trim().slice(0, limits[k] ?? 200);
    }
    let lead = l;
    if (Object.keys(patch).length) {
      const { data: updated } = await sb.from("leads").update(patch).eq("id", l.id).select().single();
      lead = updated ?? { ...l, ...patch };
      await sb.from("lead_activities").insert({
        lead_id: l.id, type: "note", created_by: "AI advisor",
        body: `Details updated from the WhatsApp reply: ${Object.entries(patch).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(", ")}.`,
      });
    }

    // A survey day the customer chose
    const validDate = typeof survey_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(survey_date) && survey_date >= todayIstIso()
      && new Date(survey_date + "T00:00:00Z").getUTCDay() !== 0;
    if (awaitingSurvey && validDate) {
      await bookSurveyFromReply(lead, survey_date, typeof survey_time_slot === "string" ? survey_time_slot : null, "AI advisor");
    }

    if (!Object.keys(patch).length && !(awaitingSurvey && validDate)) return twiml(); // not an answer: leave it for the team

    // Details complete and no estimate yet → send it (it also confirms or asks for the survey)
    if (questions.length) {
      const remaining = missingQuestions(lead);
      if (remaining.length) await sendQuestions(lead, remaining, "AI advisor");
      else if (!estimate) await sendEstimate(lead, `wa-${messageSid}`);
    }
  } catch (err) {
    await sb.from("lead_activities").insert({
      lead_id: l.id, type: "note", created_by: "AI advisor",
      body: `Couldn't process the WhatsApp reply automatically: ${(err as Error).message}`,
    });
  }
  return twiml();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!ACCOUNT_SID || !AUTH_TOKEN) return json({ error: "Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)." }, 500);

  // Customer replies forwarded by Twilio arrive as a form post
  if ((req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) return handleInbound(req);

  // deno-lint-ignore no-explicit-any
  let input: any;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // From the database: only the order id comes in, everything else is re-read here, and it's sent at most once
  if (input.kind === "ticket") {
    try {
      return json({ ok: true, ...(await sendTicketUpdate(String(input.ticket_id ?? ""), String(input.event ?? ""))) });
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  }

  if (input.kind === "passport") {
    try {
      return json({ ok: true, ...(await sendPassport(String(input.order_id ?? ""))) });
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  }

  if (input.kind === "order_confirmed" || input.kind === "installation_complete") {
    try {
      const orderId = String(input.order_id ?? "");
      return json({ ok: true, ...(await (input.kind === "order_confirmed" ? sendOrderConfirmed(orderId) : sendInstallationComplete(orderId))) });
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  }

  // The call-results function proves itself with the shared token; everyone else must be logged-in staff
  const internal = Boolean(INTERNAL_TOKEN) && req.headers.get("x-internal-token") === INTERNAL_TOKEN;
  const email = internal ? "AI advisor" : await staffEmail(req);
  if (!email) return json({ error: "Not allowed" }, 403);
  if (input.kind === "auto" && !internal) return json({ error: "Not allowed" }, 403);

  const { data: lead } = await sb.from("leads").select("*").eq("id", input.lead_id ?? "").maybeSingle();
  if (!lead) return json({ error: "Lead not found" }, 404);

  try {
    if (input.kind === "auto") {
      return json({ ok: true, ...(await autoFollowUp(lead, String(input.execution_id ?? ""))) });
    }

    if (input.kind === "quote") {
      const { data: q } = await sb.from("quotes").select("*").eq("id", input.quote_id ?? "").eq("lead_id", lead.id).maybeSingle();
      if (!q?.pdf_path) return json({ error: "Quote or its PDF not found" }, 404);
      const sent = await sendQuote(lead, q, email);
      return json({ ok: true, sid: sent.sid, status: sent.status });
    }

    if (input.kind === "receipt") {
      const { data: p } = await sb.from("payments").select("*").eq("id", input.payment_id ?? "").eq("lead_id", lead.id).maybeSingle();
      if (!p?.receipt_pdf_path) return json({ error: "Payment or its receipt PDF not found" }, 404);
      const sent = await sendReceipt(lead, p, email);
      return json({ ok: true, sid: sent.sid, status: sent.status });
    }

    if (input.kind === "invoice") {
      const { data: inv } = await sb.from("invoices").select("*").eq("id", input.invoice_id ?? "").eq("lead_id", lead.id).eq("status", "issued").maybeSingle();
      if (!inv?.pdf_path) return json({ error: "Invoice or its PDF not found" }, 404);
      const sent = await sendInvoice(lead, inv, email);
      return json({ ok: true, sid: sent.sid, status: sent.status });
    }

    if (input.kind === "passport_reset") return await resetPassport(lead, email);

    if (input.kind === "ask") {
      const questions: string[] = Array.isArray(input.questions) ? input.questions.map(String).slice(0, 10) : [];
      if (!questions.length) return json({ error: "No questions to send" }, 400);
      const sent = await sendQuestions(lead, questions, email);
      return json({ ok: true, sid: sent.sid, status: sent.status });
    }

    return json({ error: "Unknown kind" }, 400);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await sb.from("lead_activities").insert({
      lead_id: lead.id, type: "note", created_by: email, body: `WhatsApp message failed: ${message}`,
    });
    return json({ error: message }, 502);
  }
});
