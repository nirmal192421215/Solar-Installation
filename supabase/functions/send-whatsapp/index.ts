// Supabase Edge Function: WhatsApp quotes and questions to a lead through Twilio.
//
// From the CRM (staff login):
//   { kind: "quote", lead_id, quote_id }      → send an existing quote with its PDF attached
//   { kind: "ask",   lead_id, questions: [] } → ask for missing quote details
// From the call-results function after an AI call (header x-internal-token = BOLNA_WEBHOOK_TOKEN):
//   { kind: "auto", lead_id, execution_id }   → ask for missing details, or build the quote + PDF and send it
//
// Secrets (Edge Functions → Secrets): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, BOLNA_WEBHOOK_TOKEN,
// optional TWILIO_WHATSAPP_FROM (defaults to the Twilio sandbox number +14155238886),
// optional TWILIO_QUOTE_CONTENT_SID / TWILIO_ASK_CONTENT_SID (Meta-approved templates for a live sender).

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { jsPDF } from "npm:jspdf@2.5.1";
import * as AutoTable from "npm:jspdf-autotable@3.8.2";

const ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const FROM = (Deno.env.get("TWILIO_WHATSAPP_FROM") || "+14155238886").replace(/^whatsapp:/, "");
const QUOTE_TEMPLATE = Deno.env.get("TWILIO_QUOTE_CONTENT_SID") ?? "";
const ASK_TEMPLATE = Deno.env.get("TWILIO_ASK_CONTENT_SID") ?? "";
const INTERNAL_TOKEN = Deno.env.get("BOLNA_WEBHOOK_TOKEN") ?? "";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// deno-lint-ignore no-explicit-any
const autoTable: any = (AutoTable as any).autoTable ?? (AutoTable as any).default?.default ?? (AutoTable as any).default;

const COMPANY = "Sun Power Solar Solutions";
const COMPANY_PHONE = "+91 93426 26096";
const COMPANY_ADDRESS = "No 2B, Sri Laxmi Nagar Colony Rd, West Hanuman Nagar, Boduppal, Hyderabad, Telangana 500092";
const UNITS_PER_KW_MONTH = 120;
const TARIFF = 8; // ₹ per unit, for the savings estimate
const SYSTEM_TYPES: Record<string, string> = { on_grid: "On-grid", hybrid: "Hybrid (with battery)", off_grid: "Off-grid (battery)" };
const STAGE_RANK: Record<string, number> = { new: 0, ai_called: 1, interested: 2, survey_booked: 3, quote_sent: 4 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const rs = (n: number) => "Rs. " + Math.round(Number(n) || 0).toLocaleString("en-IN");
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

// ---------- PDF (same layout as the CRM) ----------
function buildPdf(settings: Row, l: Row, q: Row, c: ReturnType<typeof calculate>): Uint8Array {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210, M = 16;
  const orange: [number, number, number] = [242, 98, 15], navy: [number, number, number] = [14, 34, 51], muted: [number, number, number] = [91, 102, 114];
  const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

  doc.setFillColor(...navy);
  doc.rect(0, 0, W, 34, "F");
  doc.setFillColor(...orange);
  doc.roundedRect(M, 9, 16, 16, 3, 3, "F");
  doc.setFillColor(255, 255, 255);
  doc.circle(M + 8, 21, 5, "F");
  doc.setFillColor(...orange);
  doc.rect(M + 2, 21, 12, 2.5, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold").setFontSize(16).text(COMPANY, M + 21, 17);
  doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(220, 226, 232);
  doc.text(settings.address || COMPANY_ADDRESS, M + 21, 22.5, { maxWidth: 120 });
  doc.text([settings.phone || COMPANY_PHONE, settings.email, settings.gstin ? `GSTIN ${settings.gstin}` : ""].filter(Boolean).join("  |  "), M + 21, 30);

  let y = 46;
  doc.setTextColor(...navy).setFont("helvetica", "bold").setFontSize(20).text("QUOTATION", M, y);
  doc.setFontSize(9).setFont("helvetica", "normal").setTextColor(...muted);
  doc.text(`Quote no: ${q.quote_number}`, W - M, y - 7, { align: "right" });
  doc.text(`Date: ${fmtDate(q.created_at)}`, W - M, y - 2.5, { align: "right" });
  doc.text(`Valid until: ${fmtDate(q.valid_until + "T00:00:00")}`, W - M, y + 2, { align: "right" });

  y += 9;
  const half = (W - 2 * M - 6) / 2, col2 = M + (W - 2 * M + 6) / 2;
  doc.setDrawColor(230, 225, 218).setFillColor(248, 246, 242);
  doc.roundedRect(M, y, half, 30, 2, 2, "FD");
  doc.roundedRect(col2, y, half, 30, 2, 2, "FD");
  doc.setTextColor(...orange).setFont("helvetica", "bold").setFontSize(8).text("PREPARED FOR", M + 5, y + 6);
  doc.text("PROPOSED SYSTEM", col2 + 5, y + 6);
  doc.setTextColor(...navy).setFontSize(11).text(String(l.name), M + 5, y + 12.5);
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(60, 60, 60);
  doc.text([l.phone, l.location, l.property_type || ""].filter(Boolean), M + 5, y + 18);
  const units = q.system_size_kw * UNITS_PER_KW_MONTH;
  doc.setTextColor(...navy).setFont("helvetica", "bold").setFontSize(11).text(`${q.system_size_kw} kW ${SYSTEM_TYPES[q.system_type]}`, col2 + 5, y + 12.5);
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(60, 60, 60).text([
    `Est. generation: ~${Math.round(units)} units / month`,
    `Est. savings: ~${rs(units * TARIFF)} / month`,
    `Roof space needed: ~${Math.round(q.system_size_kw * 100)} sq ft`,
  ], col2 + 5, y + 18);

  y += 38;
  autoTable(doc, {
    startY: y, margin: { left: M, right: M },
    head: [["#", "Description", "Amount"]],
    body: c.items.map((i, n) => [n + 1, i.description, rs(i.amount)]),
    foot: [
      ["", "Taxable value", rs(c.subtotal)],
      ["", `GST @ ${settings.gst_percent || 0}%`, rs(c.gst)],
      ["", "Total (incl. GST)", rs(c.total)],
      ...(c.subsidy ? [["", "Less: PM Surya Ghar subsidy*", `- ${rs(c.subsidy)}`], ["", "Effective cost after subsidy", rs(c.net)]] : []),
    ],
    theme: "grid",
    styles: { font: "helvetica", fontSize: 9.5, cellPadding: 3, lineColor: [230, 225, 218] },
    headStyles: { fillColor: navy, textColor: 255 },
    footStyles: { fillColor: [248, 246, 242], textColor: navy, fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 10, halign: "center" }, 2: { cellWidth: 40, halign: "right" } },
    // deno-lint-ignore no-explicit-any
    didParseCell: (d: any) => {
      if (d.section === "foot" && d.column.index === 2) d.cell.styles.halign = "right";
      if (d.section === "foot" && /Total|Effective/.test(d.row.raw[1])) d.cell.styles.textColor = orange;
    },
  });
  // deno-lint-ignore no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 4;
  if (c.subsidy) {
    doc.setFontSize(8).setTextColor(...muted).text(
      "* Subsidy is paid by the Government directly to the customer's bank account after installation and inspection. The amount payable to Sun Power is the Total.",
      M, y + 2, { maxWidth: W - 2 * M });
    y += 9;
  }

  const comp = [
    ["Solar panels", settings.panel], ["Inverter", settings.inverter],
    ...(q.system_type !== "on_grid" ? [["Battery", settings.battery]] : []),
    ["Mounting structure", settings.structure], ["Cables & protection", settings.bos],
    ["Panel warranty", settings.warranty_panel], ["Inverter warranty", settings.warranty_inverter],
    ["Installation warranty", settings.warranty_installation],
  ].filter(([, v]) => v);
  if (comp.length) {
    autoTable(doc, {
      startY: y + 2, margin: { left: M, right: M },
      head: [["Components & warranty", ""]], body: comp, theme: "plain",
      styles: { fontSize: 9, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 } },
      headStyles: { textColor: orange, fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 50, textColor: muted } },
    });
    // deno-lint-ignore no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 4;
  }

  const terms = [
    settings.payment_terms ? `Payment terms: ${settings.payment_terms}` : null,
    settings.notes || null,
    "Final system design and price are confirmed after the free site survey.",
    `This quotation is valid until ${fmtDate(q.valid_until + "T00:00:00")}.`,
  ].filter(Boolean) as string[];
  const termsHeight = 8 + terms.reduce((h, t) => h + doc.splitTextToSize(`• ${t}`, W - 2 * M).length * 4.2, 0);
  if (y + termsHeight > 282) { doc.addPage(); y = 20; }
  doc.setTextColor(...orange).setFont("helvetica", "bold").setFontSize(9).text("TERMS", M, y + 3);
  doc.setTextColor(60, 60, 60).setFont("helvetica", "normal").setFontSize(8.5);
  let ty = y + 8;
  for (const t of terms) {
    const lines = doc.splitTextToSize(`• ${t}`, W - 2 * M);
    doc.text(lines, M, ty);
    ty += lines.length * 4.2;
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFillColor(...orange);
    doc.rect(0, 287, W, 10, "F");
    doc.setTextColor(255, 255, 255).setFontSize(8.5)
      .text(`Thank you for choosing ${COMPANY}  |  ${settings.phone || COMPANY_PHONE}${pages > 1 ? `  |  Page ${p} of ${pages}` : ""}`, W / 2, 293, { align: "center" });
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

// ---------- Sending ----------
async function sendQuote(l: Row, q: Row, by: string) {
  // Twilio downloads the PDF from this link; the customer can also reopen it later
  const days = Math.max(7, Math.ceil((new Date(q.valid_until).getTime() - Date.now()) / 864e5) + 30);
  const { data: signed, error } = await sb.storage.from("quotes").createSignedUrl(q.pdf_path, days * 86400);
  if (error) throw error;

  const firstName = firstNameOf(l);
  const system = `${q.system_size_kw} kW ${SYSTEM_TYPES[q.system_type] ?? q.system_type}`;
  const lines = [
    `Hello ${firstName}, thank you for choosing ${COMPANY}!`,
    "",
    `Here is your solar quotation ${q.quote_number}:`,
    `• System: ${system} rooftop solar`,
    `• Total price: ${rs(q.total)} (incl. GST)`,
  ];
  if (Number(q.subsidy) > 0) {
    lines.push(`• Govt. subsidy (PM Surya Ghar): ${rs(q.subsidy)}, credited to your bank account after installation`);
    lines.push(`• Effective cost after subsidy: ${rs(q.net_payable)}`);
  }
  lines.push(`• Valid until: ${longDate(q.valid_until)}`, "", "Your quotation PDF is attached.", `Any questions? Reply here or call ${COMPANY_PHONE}.`);

  const sent = QUOTE_TEMPLATE
    ? await sendWhatsApp(l.phone, {
      contentSid: QUOTE_TEMPLATE,
      variables: { "1": firstName, "2": q.quote_number, "3": system, "4": rs(q.total), "5": longDate(q.valid_until), "6": signed.signedUrl },
    })
    : await sendWhatsApp(l.phone, { body: lines.join("\n"), mediaUrl: signed.signedUrl });

  await sb.from("quotes").update({ status: q.status === "draft" ? "sent" : q.status, sent_at: new Date().toISOString() }).eq("id", q.id);
  if (l.status in STAGE_RANK && STAGE_RANK[l.status] < STAGE_RANK.quote_sent) {
    await sb.from("leads").update({ status: "quote_sent" }).eq("id", l.id);
  }
  await sb.from("lead_activities").insert({
    lead_id: l.id, type: "note", created_by: by,
    body: `Quotation ${q.quote_number} sent on WhatsApp to ${l.phone} with the PDF attached (Twilio ${sent.status}).`,
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
async function autoFollowUp(l: Row, executionId: string) {
  const by = "AI advisor";
  const note = (body: string) => sb.from("lead_activities").insert({ lead_id: l.id, type: "note", created_by: by, body });

  if (!l.consent) return { skipped: "no consent" };

  const questions = missingQuestions(l);
  if (questions.length) {
    await sendQuestions(l, questions, by);
    return { asked: questions.length };
  }

  const { data: row } = await sb.from("quote_settings").select("settings").eq("id", 1).maybeSingle();
  const settings: Row = row?.settings ?? {};
  const type = systemTypeKey(l.system_type) ?? "on_grid";
  const kw = sizeFromLead(l);
  if (!kw) return { skipped: "no system size" };
  if (!(Number(settings[`price_${type}`]) > 0)) {
    await note(`Automatic quote skipped: no price set for ${SYSTEM_TYPES[type]} in Quote settings.`);
    return { skipped: "no price" };
  }

  // One automatic quote per call, even if the call result arrives twice
  const { data: existing } = await sb.from("quotes").select("id").eq("call_execution_id", executionId).maybeSingle();
  if (existing) return { skipped: "quote already sent for this call" };

  const c = calculate(settings, l, kw, type);
  const validDays = Number(settings.validity_days) || 15;
  const validUntil = new Date(Date.now() + validDays * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const { data: q, error } = await sb.from("quotes").insert({
    lead_id: l.id, created_by: by, source: "ai_call", call_execution_id: executionId,
    system_type: type, system_size_kw: kw, items: c.items,
    subtotal: round2(c.subtotal), gst_amount: round2(c.gst), total: round2(c.total),
    subsidy: round2(c.subsidy), net_payable: round2(c.net), valid_until: validUntil,
  }).select().single();
  if (error) {
    if (error.code === "23505") return { skipped: "quote already sent for this call" };
    throw error;
  }

  const path = `${l.id}/${q.quote_number}.pdf`;
  const pdf = buildPdf(settings, l, q, c);
  const up = await sb.storage.from("quotes").upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (up.error) throw up.error;
  await sb.from("quotes").update({ pdf_path: path }).eq("id", q.id);
  q.pdf_path = path;

  await note(`Quotation ${q.quote_number} created automatically after the AI call: ${kw} kW ${SYSTEM_TYPES[type]}, total ${rs(c.total)}${c.subsidy ? `, ${rs(c.net)} after subsidy` : ""}.`);
  await sendQuote(l, q, by);
  return { quote: q.quote_number };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!ACCOUNT_SID || !AUTH_TOKEN) return json({ error: "Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)." }, 500);

  // deno-lint-ignore no-explicit-any
  let input: any;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
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
