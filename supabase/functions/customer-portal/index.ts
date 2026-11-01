// Supabase Edge Function: the customer portal / Localhost users (/portal/).
// A customer gets in two ways, and everything here is limited to that one customer:
//   • the private link /portal/?t=<token> sent by staff from the CRM (only its SHA-256 hash is stored: leads.portal_token_hash)
//   • the Localhost users login (phone number + password), created when their order is completed (passport.sql).
//     Signing in returns a session token; only its SHA-256 hash is stored (customer_sessions, 30 days).
//
//   { action: "login", username, password }                             → { session, must_change }
//   { session, action: "logout" }                                       → ends this session
//   { session, action: "change_password", current, new }                → sets the customer's own password
//   { token | session, action: "get" }                                  → passport: system, warranty cards, installation,
//                                                                          documents, subsidy, payments, tickets
//   { token, action: "create_ticket", category, description, photos }   → new ticket + upload links for up to 4 photos
//   { token, action: "attach_photos", ticket_id, paths }                → add the uploaded photos to the ticket
//   { token, action: "rate", ticket_id, rating, feedback }              → rate a resolved ticket (closes it)
//
// Deploy with JWT verification OFF. Uses the existing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const COMPANY_PHONE = "+91 93426 26096";
const CATEGORIES = ["safety", "no_generation", "low_generation", "inverter_error", "tripping", "water_leak", "physical_damage", "wiring", "other"];
const MAX_OPEN_TICKETS = 5;
const MAX_PHOTOS = 4;
const SESSION_DAYS = 30;
const INSTALL_PHOTO_SLOTS = ["after", "panels", "inverter"]; // shown in the passport

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Calendar date in India (an install finished at 8 pm IST is still that day, not the day before in UTC)
const istDate = (iso: string) => new Date(Date.parse(iso) + 330 * 60000).toISOString().slice(0, 10);
const addMonths = (iso: string, months: number) => {
  const d = new Date(istDate(iso));
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
};

async function signed(bucket: string, path: string | null, days = 1): Promise<string | null> {
  if (!path) return null;
  const { data } = await sb.storage.from(bucket).createSignedUrl(path, days * 86400);
  return data?.signedUrl ?? null;
}

// ---------- Everything the customer sees ----------
async function overview(l: Row, via: string) {
  const [{ data: orders }, { data: tickets }, { data: settingsRow }] = await Promise.all([
    sb.from("orders").select("*, quotes(quote_number, pdf_path), install_jobs!install_jobs_order_id_fkey(scheduled_date, time_slot, status, finished_at, crews(name))")
      .eq("lead_id", l.id).neq("status", "cancelled").order("created_at", { ascending: false }),
    sb.from("service_tickets").select("*, crews(name), order_serials(serial_no, warranty_end, order_items(description))").eq("lead_id", l.id).order("created_at", { ascending: false }).limit(30),
    sb.from("quote_settings").select("settings").eq("id", 1).maybeSingle(),
  ]);
  const settings: Row = settingsRow?.settings ?? {};
  const workmanship = Number(settings.workmanship_warranty_months) || 60;

  const out = [];
  for (const o of orders ?? []) {
    const [{ data: items }, { data: serials }, { data: payments }, { data: invoices }, { data: subsidy }] = await Promise.all([
      sb.from("order_items").select("id, description, qty, unit, is_service, products(category, warranty_months)").eq("order_id", o.id),
      sb.from("order_serials").select("order_item_id, serial_no, warranty_start, warranty_end").eq("order_id", o.id).order("serial_no"),
      sb.from("payments").select("receipt_number, amount, type, paid_on, receipt_pdf_path").eq("order_id", o.id).order("created_at"),
      sb.from("invoices").select("invoice_number, invoice_date, total, pdf_path").eq("order_id", o.id).eq("status", "issued"),
      sb.from("subsidy_cases").select("step, application_no, amount").eq("order_id", o.id).maybeSingle(),
    ]);
    const job = Array.isArray(o.install_jobs) ? o.install_jobs[0] : o.install_jobs;
    const installed = o.installed_at ?? job?.finished_at ?? null;
    const goods = (items ?? []).filter((i: Row) => !i.is_service);
    // A unit's own warranty record (from delivery) wins; otherwise count from delivery or installation
    const serialEnd = (itemId: string) =>
      (serials ?? []).filter((s: Row) => s.order_item_id === itemId && s.warranty_end).map((s: Row) => s.warranty_end).sort().pop() ?? null;
    const start = o.delivered_at ?? installed;
    const warranty = installed
      ? [
        ...goods.filter((i: Row) => i.products?.warranty_months).map((i: Row) => ({
          what: i.description, months: i.products.warranty_months, until: serialEnd(i.id) ?? addMonths(start, i.products.warranty_months),
        })),
        { what: "Installation workmanship", months: workmanship, until: addMonths(installed, workmanship) },
      ]
      : [];
    const balance = Number(o.balance) || 0;

    // Warranty cards: one per unit type, with every serial number and its own dates
    const cards = goods.filter((i: Row) => i.products?.warranty_months).map((i: Row) => {
      const own = (serials ?? []).filter((s: Row) => s.order_item_id === i.id);
      const from = own.find((s: Row) => s.warranty_start)?.warranty_start ?? (start ? istDate(start) : null);
      return {
        what: i.description, category: i.products.category, qty: i.qty, unit: i.unit, months: i.products.warranty_months,
        serials: own.map((s: Row) => s.serial_no), from, until: serialEnd(i.id) ?? (start ? addMonths(start, i.products.warranty_months) : null),
      };
    });
    if (installed) {
      cards.push({ what: "Installation workmanship", category: "workmanship", qty: 1, unit: "", months: workmanship, serials: [],
        from: istDate(installed), until: addMonths(installed, workmanship) });
    }

    // Installation record with a few site photos
    let installation = null;
    if (job && ["done", "in_progress"].includes(job.status)) {
      const { data: ij } = await sb.from("install_jobs").select("finished_at, generation_kwh, installed_kw, signed_by_name, photos")
        .eq("order_id", o.id).neq("status", "cancelled").maybeSingle();
      const paths: string[] = Array.isArray(ij?.photos) ? ij.photos : [];
      const pick = INSTALL_PHOTO_SLOTS.map((slot) => paths.find((p) => (p.split("/")[1] || "").startsWith(slot + "-"))).filter(Boolean) as string[];
      const { data: urls } = pick.length ? await sb.storage.from("install-photos").createSignedUrls(pick, 86400) : { data: [] };
      installation = {
        finished_at: ij?.finished_at ?? null, crew: job.crews?.name ?? null, generation_kwh: ij?.generation_kwh ?? null,
        installed_kw: ij?.installed_kw ?? null, signed_by: ij?.signed_by_name ?? null,
        photos: (urls ?? []).map((u: Row, n: number) => ({ slot: (pick[n].split("/")[1] || "").split("-")[0], url: u.signedUrl })).filter((p: Row) => p.url),
      };
    }

    out.push({
      order_number: o.order_number, status: o.status, system_size_kw: o.system_size_kw, system_type: o.system_type,
      total: o.total, amount_paid: o.amount_paid, balance, subsidy: o.subsidy, installed_at: installed,
      install: job && job.status !== "cancelled" ? { date: job.scheduled_date, slot: job.time_slot, crew: job.crews?.name ?? null, status: job.status } : null,
      equipment: goods.map((i: Row) => ({
        description: i.description, qty: i.qty, unit: i.unit,
        serials: (serials ?? []).filter((s: Row) => s.order_item_id === i.id).map((s: Row) => s.serial_no),
        warranty_until: (serials ?? []).filter((s: Row) => s.order_item_id === i.id && s.warranty_end).map((s: Row) => s.warranty_end)[0] ?? null,
      })),
      warranty,
      quote_pdf: await signed("quotes", o.quotes?.pdf_path ?? null),
      receipts: await Promise.all((payments ?? []).map(async (p: Row) => ({
        receipt_number: p.receipt_number, amount: p.amount, type: p.type, paid_on: p.paid_on, url: await signed("receipts", p.receipt_pdf_path),
      }))),
      upi_link: balance > 0 && settings.upi_id
        ? `upi://pay?pa=${encodeURIComponent(settings.upi_id)}&pn=${encodeURIComponent("Sun Power Solar")}&am=${balance.toFixed(2)}&tn=${encodeURIComponent(o.order_number)}&cu=INR`
        : null,
      upi_id: settings.upi_id || null,
      completed_at: o.completed_at ?? null,
      cards,
      installation,
      invoices: await Promise.all((invoices ?? []).map(async (i: Row) => ({
        invoice_number: i.invoice_number, invoice_date: i.invoice_date, total: i.total, url: await signed("invoices", i.pdf_path),
      }))),
      subsidy_case: subsidy ? { step: subsidy.step, application_no: subsidy.application_no, amount: subsidy.amount } : null,
    });
  }

  const { data: account } = await sb.from("customer_accounts").select("must_change").eq("lead_id", l.id).maybeSingle();
  return {
    customer: { name: l.name, client_code: l.client_code, location: l.location, phone: String(l.phone || "").replace(/^\+91/, "") },
    access: { via, has_login: Boolean(account), must_change: via === "session" && Boolean(account?.must_change) },
    company_phone: COMPANY_PHONE,
    orders: out,
    tickets: (tickets ?? []).map((t: Row) => ({
      id: t.id, ticket_number: t.ticket_number, kind: t.kind, category: t.category, priority: t.priority, status: t.status,
      description: t.description, created_at: t.created_at, sla_due_at: t.sla_due_at, visit_date: t.visit_date, visit_slot: t.visit_slot,
      crew: t.crews?.name ?? null, warranty_status: t.warranty_status, warranty_note: t.warranty_note,
      cause: t.cause, work_done: t.work_done, generation_kwh: t.generation_kwh, resolved_at: t.resolved_at,
      charge_amount: t.charge_amount, customer_rating: t.customer_rating, customer_feedback: t.customer_feedback,
      started_at: t.started_at ?? null, signed_by: t.signed_by_name ?? null, confirmed_via: t.confirmed_via ?? null, confirmed_at: t.customer_confirmed_at ?? null,
      // The exact unit the ticket is about, so the page can show its warranty as a clean row
      unit: t.order_serials ? {
        what: t.order_serials.order_items?.description ?? null, serial_no: t.order_serials.serial_no, warranty_end: t.order_serials.warranty_end,
      } : null,
    })),
  };
}

// ---------- Report a problem ----------
async function createTicket(l: Row, input: Row) {
  const category = String(input.category ?? "");
  const description = String(input.description ?? "").trim().slice(0, 2000);
  const photos = Math.max(0, Math.min(MAX_PHOTOS, Number(input.photos) || 0));
  if (!CATEGORIES.includes(category)) return json({ error: "Choose what the problem is" }, 400);
  if (description.length < 5) return json({ error: "Please describe the problem in a few words" }, 400);

  const { count } = await sb.from("service_tickets").select("id", { count: "exact", head: true })
    .eq("lead_id", l.id).in("status", ["open", "scheduled", "in_progress"]);
  if ((count ?? 0) >= MAX_OPEN_TICKETS) return json({ error: `You already have ${count} open requests. Please call us on ${COMPANY_PHONE}.` }, 429);

  const { data: t, error } = await sb.from("service_tickets").insert({
    lead_id: l.id, kind: "breakdown", category, description, source: "portal", created_by: "Customer (portal)",
  }).select("id, ticket_number, priority, sla_due_at, warranty_status, warranty_note").single();
  if (error) return json({ error: error.message }, 500);

  // The page uploads the photos straight to storage with these one-time links
  const uploads = [];
  for (let i = 0; i < photos; i++) {
    const path = `${t.id}/customer-${crypto.randomUUID()}.jpg`;
    const { data } = await sb.storage.from("service-photos").createSignedUploadUrl(path);
    if (data) uploads.push({ path, token: data.token });
  }
  return json({ ok: true, ticket: t, uploads });
}

async function ownTicket(l: Row, id: unknown) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data } = await sb.from("service_tickets").select("*").eq("id", id).eq("lead_id", l.id).maybeSingle();
  return data;
}

async function attachPhotos(l: Row, input: Row) {
  const t = await ownTicket(l, input.ticket_id);
  if (!t) return json({ error: "Request not found" }, 404);
  const re = new RegExp(`^${t.id}/customer-[0-9a-f-]{36}\\.jpg$`);
  const paths: string[] = (Array.isArray(input.paths) ? input.paths : []).map(String).filter((p: string) => re.test(p));
  const current: string[] = Array.isArray(t.photos) ? t.photos : [];
  const next = [...new Set([...current, ...paths])].slice(0, current.length + MAX_PHOTOS);
  await sb.from("service_tickets").update({ photos: next }).eq("id", t.id);
  return json({ ok: true, photos: next.length });
}

async function rate(l: Row, input: Row) {
  const t = await ownTicket(l, input.ticket_id);
  if (!t) return json({ error: "Request not found" }, 404);
  const rating = Math.round(Number(input.rating));
  if (!(rating >= 1 && rating <= 5)) return json({ error: "Choose 1 to 5 stars" }, 400);
  if (t.status !== "resolved") return json({ error: "You can rate once the request is resolved" }, 400);
  // Rating = the customer confirms everything works, which closes the ticket
  const { error } = await sb.from("service_tickets").update({
    customer_rating: rating, customer_feedback: String(input.feedback ?? "").trim().slice(0, 1000) || null, status: "closed",
    customer_confirmed_at: new Date().toISOString(), confirmed_via: "portal",
  }).eq("id", t.id);
  if (error) return json({ error: error.message }, 500);
  await sb.from("lead_activities").insert({
    lead_id: l.id, type: "note", created_by: "Customer (portal)",
    body: `${t.ticket_number} rated ${"★".repeat(rating)}${"☆".repeat(5 - rating)}${input.feedback ? `: ${String(input.feedback).slice(0, 300)}` : ""}`,
  });
  return json({ ok: true });
}

// ---------- Localhost users sign-in ----------
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function login(input: Row) {
  const username = String(input.username ?? "").trim().slice(0, 40);
  const password = String(input.password ?? "").slice(0, 72);
  if (!username || !password) return json({ error: "Enter your phone number and password." }, 400);
  const { data: res, error } = await sb.rpc("customer_login", { p_username: username, p_password: password });
  if (error) return json({ error: "Sign-in isn't available right now. Please call us." }, 500);
  if (!res?.ok) return json({ error: res?.error || "Wrong phone number or password." }, 401);
  const session = randomToken();
  await sb.from("customer_sessions").delete().lt("expires_at", new Date().toISOString()); // tidy up old sessions
  const { error: e2 } = await sb.from("customer_sessions").insert({
    token_hash: await sha256(session), lead_id: res.lead_id, expires_at: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
  });
  if (e2) return json({ error: e2.message }, 500);
  return json({ ok: true, session, must_change: res.must_change });
}

async function changePassword(l: Row, input: Row) {
  const { data: res, error } = await sb.rpc("customer_change_password", {
    p_lead_id: l.id, p_current: String(input.current ?? "").slice(0, 72), p_new: String(input.new ?? "").slice(0, 72),
  });
  if (error) return json({ error: error.message }, 500);
  if (!res?.ok) return json({ error: res?.error || "Couldn't change the password." }, 400);
  await sb.from("lead_activities").insert({ lead_id: l.id, type: "note", created_by: "Customer (Localhost users)", body: "Customer set their own Localhost users password." });
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // deno-lint-ignore no-explicit-any
  let input: any;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (input?.action === "login") return await login(input);

  // Signed in with the passport login, or opened from the private link
  let l: Row | null = null;
  let via = "link";
  const session = String(input?.session ?? "");
  if (session) {
    if (!/^[0-9a-f]{64}$/.test(session)) return json({ error: "Please sign in again.", signed_out: true }, 401);
    const hash = await sha256(session);
    if (input.action === "logout") {
      await sb.from("customer_sessions").delete().eq("token_hash", hash);
      return json({ ok: true });
    }
    const { data: s } = await sb.from("customer_sessions").select("lead_id").eq("token_hash", hash).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (s) ({ data: l } = await sb.from("leads").select("*").eq("id", s.lead_id).maybeSingle());
    if (!l) return json({ error: "Please sign in again.", signed_out: true }, 401);
    via = "session";
  } else {
    const token = String(input?.token ?? "");
    if (!/^[0-9a-f]{64}$/.test(token)) return json({ error: "This link isn't valid. Ask Sun Power for a new one." }, 401);
    ({ data: l } = await sb.from("leads").select("*").eq("portal_token_hash", await sha256(token)).maybeSingle());
    if (!l) return json({ error: "This link has expired. Ask Sun Power for a new one." }, 401);
  }

  try {
    switch (input.action) {
      case "get": return json(await overview(l, via));
      case "change_password":
        return via === "session" ? await changePassword(l, input) : json({ error: "Sign in with your phone number first." }, 400);
      case "create_ticket": return await createTicket(l, input);
      case "attach_photos": return await attachPhotos(l, input);
      case "rate": return await rate(l, input);
      default: return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
