// Supabase Edge Function: receive Bolna call updates and write results into the CRM.
// After each completed call, Gemini turns the transcript into minutes of meeting,
// customer requirements and the next follow-up meeting.
//
// Set this as the agent's webhook URL in Bolna:
//   https://iekfgtyfwmplsauutegs.supabase.co/functions/v1/hyper-action?token=<BOLNA_WEBHOOK_TOKEN>
//
// Secrets (Edge Functions → Secrets): BOLNA_WEBHOOK_TOKEN, GEMINI_API_KEY,
// optional GEMINI_MODEL (defaults to gemini-3.8-flash).

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const WEBHOOK_TOKEN = Deno.env.get("BOLNA_WEBHOOK_TOKEN") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Bolna's final statuses; results are only complete once one of these arrives
const TERMINAL = new Set(["completed", "no-answer", "busy", "failed", "canceled", "stopped", "error", "balance-low"]);
const NO_SPEECH = "Summary not generated as there was no user turn";

// Pipeline order, so an AI call only ever moves a lead forward
const STAGE_RANK: Record<string, number> = { new: 0, ai_called: 1, interested: 2, survey_booked: 3, survey_done: 4, survey_approved: 5, quote_sent: 6 };

const BOLNA_API_KEY = Deno.env.get("BOLNA_API_KEY") ?? "";

// After a positive call, the WhatsApp function asks for missing details or sends the quote
const WHATSAPP_FUNCTION = Deno.env.get("WHATSAPP_FUNCTION") || "send-whatsapp";
const FOLLOW_UP_OUTCOMES = new Set(["survey_booked", "interested", "callback"]);

async function requestWhatsAppFollowUp(leadId: string, executionId: string): Promise<string | null> {
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${WHATSAPP_FUNCTION}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": WEBHOOK_TOKEN,
        Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`,
      },
      body: JSON.stringify({ kind: "auto", lead_id: leadId, execution_id: executionId }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.error ?? data.message ?? `HTTP ${res.status}`;
  } catch (err) {
    return (err as Error).message;
  }
}

// The CRM's "Regenerate minutes" button calls this function from the browser
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });

// Staff-only check for the CRM's "Regenerate minutes" button
async function isStaffRequest(req: Request): Promise<boolean> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data } = await sb.auth.getUser(token);
  const email = data.user?.email?.toLowerCase();
  if (!email) return false;
  const { data: staff } = await sb.from("staff").select("email").ilike("email", email).maybeSingle();
  return Boolean(staff);
}

// ---------- Minutes of meeting via Gemini ----------
type Minutes = {
  outcome: "survey_booked" | "interested" | "callback" | "not_interested" | "wrong_number" | "do_not_call" | "unclear";
  summary: string;
  discussion_points: string[];
  customer_requirements: string[];
  concerns: string[];
  agreed_next_steps: string[];
  requirements: {
    owns_property: string | null;
    property_type: string | null;
    monthly_bill: string | null;
    roof_type: string | null;
    roof_area: string | null;
    shading: string | null;
    system_size: string | null;
    system_type: string | null;
    wants_subsidy: string | null;
    install_timeline: string | null;
    other_notes: string | null;
  };
  next_meeting: {
    type: "site_survey" | "callback" | "none";
    date: string | null;
    time_slot: string | null;
    agenda: string | null;
  };
};

const nullableString = { type: ["string", "null"] };
const stringList = { type: "array", items: { type: "string" } };

const MINUTES_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["survey_booked", "interested", "callback", "not_interested", "wrong_number", "do_not_call", "unclear"],
      description: "Result of the call.",
    },
    summary: { type: "string", description: "Two or three sentence summary of the call for the sales team." },
    discussion_points: { ...stringList, description: "Main topics discussed." },
    customer_requirements: { ...stringList, description: "What the customer needs or wants, in their own terms." },
    concerns: { ...stringList, description: "Objections, worries or open questions the customer raised." },
    agreed_next_steps: { ...stringList, description: "What was agreed to happen next, and by whom." },
    requirements: {
      type: "object",
      description: "Facts the customer stated on the call. Use null when not mentioned.",
      properties: {
        owns_property: { ...nullableString, description: "Yes, No or Unknown." },
        property_type: { ...nullableString, description: "Independent house, villa, apartment, shop, factory, etc." },
        monthly_bill: { ...nullableString, description: "Monthly electricity bill in rupees, as stated." },
        roof_type: { ...nullableString, description: "RCC/concrete, sheet, tiled, etc." },
        roof_area: { ...nullableString, description: "Free roof space, e.g. '400 sq ft'." },
        shading: { ...nullableString, description: "Any shade from trees or buildings." },
        system_size: { ...nullableString, description: "System size discussed, e.g. '3 kW'." },
        system_type: { ...nullableString, description: "On-grid, hybrid or off-grid (battery)." },
        wants_subsidy: { ...nullableString, description: "Yes, No or Not sure." },
        install_timeline: { ...nullableString, description: "When they want to install." },
        other_notes: { ...nullableString, description: "Anything else the team should know." },
      },
      required: ["owns_property", "property_type", "monthly_bill", "roof_type", "roof_area", "shading",
        "system_size", "system_type", "wants_subsidy", "install_timeline", "other_notes"],
    },
    next_meeting: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["site_survey", "callback", "none"] },
        date: { ...nullableString, description: "Agreed date as YYYY-MM-DD, resolved from relative words like 'tomorrow' using today's date. Null if no date was agreed." },
        time_slot: { ...nullableString, description: "Agreed time or slot, e.g. 'Morning 10–1' or '4 PM'." },
        agenda: { ...nullableString, description: "What the meeting is for." },
      },
      required: ["type", "date", "time_slot", "agenda"],
    },
  },
  required: ["outcome", "summary", "discussion_points", "customer_requirements", "concerns", "agreed_next_steps",
    "requirements", "next_meeting"],
};

function todayIst(): string {
  const now = new Date(Date.now() + 330 * 60_000);
  return now.toISOString().slice(0, 10) + ` (${now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })})`;
}

// deno-lint-ignore no-explicit-any
function buildPrompt(lead: any, transcript: string): string {
  return [
    "You are writing the minutes of a sales phone call for Sun Power Solar Solutions, a rooftop solar installer in Hyderabad, India.",
    "The 'assistant' in the transcript is Surya, the company's AI energy advisor. The 'user' is the customer.",
    "Write for the sales team: short, factual, no filler. Only record what the customer actually said; never guess.",
    "Speech-to-text can garble words (e.g. 'congregate' likely means 'concrete'); interpret sensibly, but mark anything uncertain.",
    `Today's date in India is ${todayIst()}. Resolve dates like 'tomorrow' or 'Monday' to YYYY-MM-DD. Site surveys happen Monday to Saturday.`,
    "",
    "What the customer entered on the website form before the call:",
    JSON.stringify({
      name: lead.name, location: lead.location, property_type: lead.property_type, monthly_bill: lead.monthly_bill,
      system_size: lead.system_size, system_type: lead.system_type, wants_subsidy: lead.wants_subsidy,
    }),
    "",
    "Call transcript:",
    transcript.slice(0, 30_000),
  ].join("\n");
}

// Models to try in order. Busy (503), over-quota (429) or retired (404) models are skipped at once,
// so a Gemini outage on one model doesn't lose the minutes.
const FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite"];
const MODELS = [...new Set([GEMINI_MODEL, ...FALLBACK_MODELS])];

// Supabase stops a function after 150 s; leave room to save the results
const MINUTES_DEADLINE_MS = 110_000;
const ATTEMPT_TIMEOUT_MS = 45_000;

async function generateMinutes(prompt: string): Promise<Minutes> {
  const deadline = Date.now() + MINUTES_DEADLINE_MS;
  // Request shapes, newest API field names first; only a 400 (bad request) moves on to the next shape
  const configs = [
    { responseMimeType: "application/json", responseJsonSchema: MINUTES_SCHEMA },
    { responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: MINUTES_SCHEMA } } },
    { responseMimeType: "application/json" },
  ];
  const errors: string[] = [];

  for (const model of MODELS) {
    for (const generationConfig of configs) {
      const remaining = deadline - Date.now();
      if (remaining < 5_000) throw new Error(`Gemini timed out (${errors.join("; ") || "no response"})`);
      let res: Response;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining)),
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "responseMimeType" in generationConfig && !("responseJsonSchema" in generationConfig)
              ? `${prompt}\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(MINUTES_SCHEMA)}`
              : prompt }] }],
            generationConfig: { ...generationConfig, temperature: 0.2 },
          }),
        });
      } catch {
        errors.push(`${model}: no reply in time`);
        break; // slow model: try the next one
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const text: string = (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
        try {
          return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as Minutes;
        } catch {
          errors.push(`${model}: unreadable reply`);
          break;
        }
      }
      errors.push(`${model}: ${data.error?.message?.slice(0, 80) ?? `HTTP ${res.status}`}`);
      if (res.status !== 400) break; // busy / quota / missing model: next model
    }
  }
  throw new Error(`Gemini unavailable (${errors.join("; ")})`);
}

// ---------- Formatting ----------
function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const MEETING_LABEL = { site_survey: "Site survey", callback: "Callback" } as const;

function formatMinutes(m: Minutes, duration: number | null): string {
  const section = (title: string, items: string[]) => (items?.length ? `\n${title}:\n${items.map((i) => `• ${i}`).join("\n")}` : "");
  const req = Object.entries(m.requirements ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`);
  const next = m.next_meeting?.type && m.next_meeting.type !== "none"
    ? `\nNext meeting: ${MEETING_LABEL[m.next_meeting.type]}${m.next_meeting.date ? ` on ${m.next_meeting.date}` : " (date not fixed)"}${m.next_meeting.time_slot ? `, ${m.next_meeting.time_slot}` : ""}`
    : "";
  return [
    `Minutes of AI call${duration ? ` (${formatDuration(duration)})` : ""}. Outcome: ${m.outcome.replace(/_/g, " ")}.`,
    m.summary,
    section("Requirements", req),
    section("Discussed", m.discussion_points),
    section("Concerns", m.concerns),
    section("Agreed next steps", m.agreed_next_steps),
    next,
  ].filter(Boolean).join("\n");
}

// ---------- Final processing of a finished call ----------
// deno-lint-ignore no-explicit-any
async function finishCall(ex: any, lead: any, executionId: string, status: string) {
  const telephony = ex.telephony_data ?? {};
  const duration = Number(ex.conversation_duration ?? telephony.duration ?? 0) || null;
  const transcript: string = typeof ex.transcript === "string" ? ex.transcript : "";
  const customerSpoke = /^\s*user:\s*\S/im.test(transcript);
  const leadPatch: Record<string, unknown> = {};
  const lines: string[] = [];
  let followUp = false;

  if (status !== "completed") {
    const reason = ex.termination_reason ? ` (${String(ex.termination_reason).replace(/_/g, " ")})` : "";
    lines.push(`AI call not connected: ${status.replace(/-/g, " ")}${reason}.`);
    if (ex.error_message) lines.push(String(ex.error_message));
    if (status === "balance-low") lines.push("Top up the Bolna wallet to resume calls.");
  } else if (!customerSpoke) {
    lines.push(`AI call completed${duration ? ` (${formatDuration(duration)})` : ""}, but the customer didn't speak (voicemail, silence or immediate hang-up).`);
  } else {
    let minutes: Minutes | null = null;
    if (GEMINI_API_KEY) {
      try {
        minutes = await generateMinutes(buildPrompt(lead, transcript));
      } catch (err) {
        lines.push(`AI call completed${duration ? ` (${formatDuration(duration)})` : ""}. Minutes couldn't be generated: ${(err as Error).message}`);
      }
    } else {
      lines.push(`AI call completed${duration ? ` (${formatDuration(duration)})` : ""}. Add GEMINI_API_KEY to generate minutes automatically.`);
    }

    // Move the lead forward
    const stage = minutes?.outcome === "survey_booked" ? "survey_booked"
      : minutes && ["interested", "callback"].includes(minutes.outcome) ? "interested"
      : "ai_called";
    if (lead.status in STAGE_RANK && STAGE_RANK[stage] > STAGE_RANK[lead.status]) leadPatch.status = stage;

    if (minutes) {
      followUp = FOLLOW_UP_OUTCOMES.has(minutes.outcome);
      lines.push(formatMinutes(minutes, duration));

      await sb.from("lead_calls").update({
        outcome: minutes.outcome,
        minutes,
        summary: minutes.summary,
      }).eq("execution_id", executionId);

      // Save requirements the customer stated (the call is more recent than the form)
      const r = minutes.requirements ?? {};
      const fields: [keyof Minutes["requirements"], string][] = [
        ["owns_property", "owns_property"], ["property_type", "property_type"], ["monthly_bill", "monthly_bill"],
        ["roof_type", "roof_type"], ["roof_area", "roof_area"], ["shading", "shading"], ["system_size", "system_size"],
        ["system_type", "system_type"], ["wants_subsidy", "wants_subsidy"], ["install_timeline", "install_timeline"],
        ["other_notes", "requirement_notes"],
      ];
      for (const [from, to] of fields) {
        const v = r[from];
        if (typeof v === "string" && v.trim() && !/^unknown$/i.test(v.trim())) leadPatch[to] = v.trim().slice(0, 40 * (to === "requirement_notes" ? 25 : 1));
      }

      // Save the agreed follow-up meeting for the team
      const nm = minutes.next_meeting;
      if (nm && nm.type !== "none" && nm.date && /^\d{4}-\d{2}-\d{2}$/.test(nm.date)) {
        await sb.from("meetings").upsert({
          lead_id: lead.id,
          type: nm.type,
          scheduled_date: nm.date,
          time_slot: nm.time_slot?.slice(0, 60) ?? null,
          agenda: nm.agenda?.slice(0, 2000) ?? null,
          source: "ai_call",
          call_execution_id: executionId,
          created_by: "AI advisor",
        }, { onConflict: "call_execution_id,type" });
        leadPatch.follow_up_date = nm.date;
      }
    }
  }

  if (telephony.recording_url) lines.push(`Recording: ${telephony.recording_url}`);
  if (Object.keys(leadPatch).length) await sb.from("leads").update(leadPatch).eq("id", lead.id);
  await sb.from("lead_activities").insert({
    lead_id: lead.id,
    type: "call",
    body: lines.join("\n").slice(0, 5000),
    created_by: "AI advisor",
  });

  // Requirements are saved now, so the quote (or the missing-details questions) can go out
  if (followUp) {
    const failed = await requestWhatsAppFollowUp(lead.id, executionId);
    if (failed) {
      await sb.from("lead_activities").insert({
        lead_id: lead.id, type: "note", created_by: "AI advisor",
        body: `Automatic WhatsApp follow-up didn't go out: ${failed}`,
      });
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
  const params = new URL(req.url).searchParams;
  const fromBolna = Boolean(WEBHOOK_TOKEN) && params.get("token") === WEBHOOK_TOKEN;
  // ?reprocess=1 re-runs the minutes for a call that already finished
  let reprocess = params.get("reprocess") === "1";

  // deno-lint-ignore no-explicit-any
  let ex: any;
  try {
    ex = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: CORS });
  }

  if (!fromBolna) {
    // Only staff may use the CRM's "Regenerate minutes": { execution_id } → fetch the call from Bolna
    if (!(await isStaffRequest(req))) return new Response("Unauthorized", { status: 401, headers: CORS });
    const id = typeof ex?.execution_id === "string" ? ex.execution_id : "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("execution_id is required", { status: 400, headers: CORS });
    const res = await fetch(`https://api.bolna.ai/executions/${id}`, { headers: { Authorization: `Bearer ${BOLNA_API_KEY}` } });
    if (!res.ok) return new Response(`Couldn't load the call from Bolna (HTTP ${res.status})`, { status: 502, headers: CORS });
    ex = await res.json();
    reprocess = true;
  }

  const executionId: string | undefined = ex.id ?? ex.execution_id;
  const status: string | undefined = ex.status;
  if (!executionId || !status) return ok({ ignored: true });

  // Find the call: by execution id, or by the lead_id we passed in user_data
  const { data: call } = await sb.from("lead_calls").select("*").eq("execution_id", executionId).maybeSingle();
  let leadId: string | undefined = call?.lead_id;
  if (!leadId) {
    const fromContext = ex.context_details?.recipient_data?.lead_id ?? ex.user_data?.lead_id;
    if (typeof fromContext === "string") leadId = fromContext;
  }
  if (!leadId) return ok({ ignored: true, reason: "Unknown execution" });

  const { data: lead } = await sb.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) return ok({ ignored: true, reason: "Lead not found" });

  // Bolna may resend the same final event; only process it once
  const alreadyFinal = call && TERMINAL.has(call.status) && !reprocess;
  const terminal = TERMINAL.has(status);
  // A late in-progress event must never overwrite final results
  if (alreadyFinal && !terminal) return ok({ ignored: true, reason: "Call already finished" });

  const telephony = ex.telephony_data ?? {};
  const duration = Number(ex.conversation_duration ?? telephony.duration ?? 0) || null;
  const summary = typeof ex.summary === "string" && ex.summary.trim() && ex.summary !== NO_SPEECH ? ex.summary.trim() : null;
  const transcript = typeof ex.transcript === "string" ? ex.transcript : ex.transcript ? JSON.stringify(ex.transcript) : null;

  await sb.from("lead_calls").upsert({
    execution_id: executionId,
    lead_id: leadId,
    status,
    updated_at: new Date().toISOString(),
    termination_reason: ex.termination_reason ?? null,
    duration_seconds: duration,
    cost_cents: ex.total_cost ?? null,
    summary,
    transcript,
    recording_url: telephony.recording_url ?? null,
    extracted_data: ex.extracted_data ?? null,
    raw: terminal ? ex : null,
  });

  // Live status for the CRM table (only for the lead's latest call)
  if (lead.ai_call_execution_id === executionId) {
    await sb.from("leads").update({ ai_call_status: status }).eq("id", leadId);
  }

  if (!terminal || alreadyFinal) return ok();

  // Re-processing runs in the foreground so the caller sees whether the minutes worked
  if (reprocess) {
    await finishCall(ex, lead, executionId, status);
    const { data: done } = await sb.from("lead_calls").select("outcome").eq("execution_id", executionId).maybeSingle();
    return ok({ reprocessed: true, outcome: done?.outcome ?? null, gemini_configured: Boolean(GEMINI_API_KEY) });
  }

  // Reply to Bolna straight away; write the minutes in the background
  const work = finishCall(ex, lead, executionId, status).catch((err) => console.error("finishCall failed", err));
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(work);
  else await work;
  return ok();
});
