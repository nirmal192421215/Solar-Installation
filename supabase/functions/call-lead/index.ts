// Supabase Edge Function: place an AI call to a lead through Bolna.
//
// Called by the database trigger on every new lead ({ lead_id }), and by the CRM's
// "Call with AI now" button ({ lead_id, force: true } with the staff member's login token).
//
// Secrets (Edge Functions → Secrets): BOLNA_API_KEY, BOLNA_AGENT_ID,
// optional BOLNA_FROM_NUMBER. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const BOLNA_API_KEY = Deno.env.get("BOLNA_API_KEY") ?? "";
const BOLNA_AGENT_ID = Deno.env.get("BOLNA_AGENT_ID") ?? "";
const BOLNA_FROM_NUMBER = Deno.env.get("BOLNA_FROM_NUMBER") ?? "";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Calling hours in India (IST): Monday–Saturday, 9:00 to 19:00
const OPEN_HOUR = 9;
const CLOSE_HOUR = 19;
const SCHEDULED_CALL_HOUR = 11; // "Tomorrow" and after-hours calls go out at 11 AM
const IST_OFFSET_MIN = 330;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- IST time helpers (India has no daylight saving) ----------
type IstParts = { y: number; m: number; d: number; h: number; min: number; dow: number };

function toIst(date: Date): IstParts {
  const t = new Date(date.getTime() + IST_OFFSET_MIN * 60_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), h: t.getUTCHours(), min: t.getUTCMinutes(), dow: t.getUTCDay() };
}

function fromIst(y: number, m: number, d: number, h: number, min = 0): Date {
  return new Date(Date.UTC(y, m, d, h, min) - IST_OFFSET_MIN * 60_000);
}

function isOpen(date: Date): boolean {
  const p = toIst(date);
  return p.dow !== 0 && p.h >= OPEN_HOUR && p.h < CLOSE_HOUR;
}

// The next working day (after the given date) at the scheduled call hour
function nextWorkingDayAt(date: Date, hour = SCHEDULED_CALL_HOUR): Date {
  const p = toIst(date);
  let day = fromIst(p.y, p.m, p.d + 1, hour);
  while (toIst(day).dow === 0) {
    const q = toIst(day);
    day = fromIst(q.y, q.m, q.d + 1, hour);
  }
  return day;
}

// Earliest open moment at or after `date`
function nextOpening(date: Date): Date {
  if (isOpen(date)) return date;
  const p = toIst(date);
  if (p.dow !== 0 && p.h < OPEN_HOUR) return fromIst(p.y, p.m, p.d, SCHEDULED_CALL_HOUR);
  return nextWorkingDayAt(date);
}

// Returns null for "call now", or the time to schedule the call for
function chooseCallTime(preferred: string | null, now: Date): Date | null {
  switch (preferred) {
    case "Tomorrow":
      return nextWorkingDayAt(now);
    case "Later today": {
      const later = new Date(now.getTime() + 3 * 3600_000);
      const sameDay = toIst(later).d === toIst(now).d;
      return sameDay && isOpen(later) ? later : nextOpening(later);
    }
    default: // "Call me now" or not chosen
      return isOpen(now) ? null : nextOpening(now);
  }
}

// Bolna rejects a trailing "Z"; it needs a numeric offset
function toBolnaTimestamp(date: Date): string {
  const p = toIst(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}:00+05:30`;
}

function formatIst(date: Date): string {
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

async function logActivity(leadId: string, body: string) {
  await sb.from("lead_activities").insert({ lead_id: leadId, type: "call", body, created_by: "AI advisor" });
}

// Staff-only check for manual "call now" requests from the CRM
async function isStaffRequest(req: Request): Promise<boolean> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data } = await sb.auth.getUser(token);
  const email = data.user?.email?.toLowerCase();
  if (!email) return false;
  const { data: staff } = await sb.from("staff").select("email").ilike("email", email).maybeSingle();
  return Boolean(staff);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!BOLNA_API_KEY || !BOLNA_AGENT_ID) return json({ error: "Bolna is not configured" }, 500);

  let payload: { lead_id?: string; force?: boolean };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const leadId = payload.lead_id;
  if (!leadId || !/^[0-9a-f-]{36}$/i.test(leadId)) return json({ error: "lead_id is required" }, 400);

  const force = payload.force === true;
  if (force && !(await isStaffRequest(req))) return json({ error: "Not allowed" }, 403);

  // Claim the lead so it is only ever called once (unless staff force a new call)
  const base = sb.from("leads").update({ ai_call_status: "queuing" }).eq("id", leadId).eq("consent", true);
  const claim = force
    ? base.or("ai_call_status.is.null,ai_call_status.not.in.(queuing,queued,scheduled,initiated,ringing,in-progress)")
    : base.is("ai_call_status", null);
  const { data: lead, error: claimError } = await claim.select().maybeSingle();
  if (claimError) return json({ error: claimError.message }, 500);
  if (!lead) return json({ skipped: true, reason: "Lead not found, no consent, or a call is already in progress" });

  const now = new Date();
  const when = force ? (isOpen(now) ? null : nextOpening(now)) : chooseCallTime(lead.preferred_call_time, now);

  const body: Record<string, unknown> = {
    agent_id: BOLNA_AGENT_ID,
    recipient_phone_number: lead.phone,
    user_data: {
      customer_name: lead.name.split(" ")[0],
      full_name: lead.name,
      location: lead.location,
      property_type: lead.property_type ?? "not specified",
      monthly_bill: lead.monthly_bill ?? "not specified",
      system_size: lead.system_size ?? "not specified",
      system_type: lead.system_type ?? "not specified",
      wants_subsidy: lead.wants_subsidy ?? "not specified",
      company_name: "Sun Power Solar Solutions",
      company_phone: "+91 93426 26096",
      lead_id: lead.id,
    },
  };
  if (BOLNA_FROM_NUMBER) body.from_phone_number = BOLNA_FROM_NUMBER;
  if (when) body.scheduled_at = toBolnaTimestamp(when);

  const res = await fetch("https://api.bolna.ai/call", {
    method: "POST",
    headers: { Authorization: `Bearer ${BOLNA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await res.json().catch(() => ({}));

  if (!res.ok || !result.execution_id) {
    const detail = typeof result.detail === "string" ? result.detail : result.detail ? JSON.stringify(result.detail) : null;
    const reason = `${result.message ?? result.error ?? detail ?? "no details"} (HTTP ${res.status})`;
    await sb.from("leads").update({ ai_call_status: "failed" }).eq("id", leadId);
    await logActivity(leadId, `AI call could not be placed: ${reason}`);
    return json({ error: reason }, 502);
  }

  const status = when ? "scheduled" : "queued";
  await sb.from("leads").update({
    ai_call_status: status,
    ai_call_execution_id: result.execution_id,
    ai_call_scheduled_at: when ? when.toISOString() : now.toISOString(),
  }).eq("id", leadId);

  await sb.from("lead_calls").insert({
    execution_id: result.execution_id,
    lead_id: leadId,
    status,
    scheduled_at: when ? when.toISOString() : null,
  });

  await logActivity(leadId, when ? `AI call scheduled for ${formatIst(when)}` : "AI call placed");
  return json({ ok: true, execution_id: result.execution_id, scheduled_at: body.scheduled_at ?? null });
});
