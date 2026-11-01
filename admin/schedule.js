// Installation schedule: week view (Mon–Sat × crews), rescheduling, and the technician's "My jobs"
(() => {
  const { sb, state, esc, toast, todayISO, fmtDay, fmtDateTime, addDays, mondayOf, registerView, viewOpen, loadTiles } = window.CRM;
  const $ = (id) => document.getElementById(id);

  const SLOTS = ["Morning 9–1", "Afternoon 2–6", "Full day"];
  const units = (slot) => (slot === "Full day" ? 2 : 1); // a crew has 2 half-day units per working day
  const SHORT_TYPE = { on_grid: "On-grid", hybrid: "Hybrid", off_grid: "Off-grid", panel_set: "Panel set" };
  const JOB_SELECT = "*, orders!install_jobs_order_id_fkey(order_number, status, system_size_kw, system_type), leads!install_jobs_lead_id_fkey(name, client_code, location)";

  let week = null; // Monday of the week shown
  let crews = [];
  let jobs = [];
  let visits = []; // service visits (service.sql) share the crews' days

  // ---------- Week view ----------
  async function load() {
    week = week || mondayOf(todayISO());
    const [{ data: c, error }, { data: j }, { data: v }] = await Promise.all([
      sb.from("crews").select("*").order("name"),
      sb.from("install_jobs").select(JOB_SELECT)
        .gte("scheduled_date", week).lte("scheduled_date", addDays(week, 5)).neq("status", "cancelled"),
      sb.from("service_tickets").select("id, ticket_number, kind, category, priority, status, crew_id, visit_date, visit_slot, leads(name, client_code)")
        .gte("visit_date", week).lte("visit_date", addDays(week, 5)).in("status", ["scheduled", "in_progress", "resolved", "closed"]),
    ]);
    if (error) return ($("schedBody").innerHTML = `<p class="empty">The schedule isn't set up yet (run orders.sql).</p>`);
    crews = c || [];
    jobs = (j || []).sort((a, b) => SLOTS.indexOf(a.time_slot) - SLOTS.indexOf(b.time_slot));
    visits = (v || []).filter((x) => x.crew_id).sort((a, b) => SLOTS.indexOf(a.visit_slot) - SLOTS.indexOf(b.visit_slot));
    render();
  }

  function jobCard(j) {
    const o = j.orders || {};
    const [label, cls] = window.Orders?.ORDER_STATUS[o.status] || [o.status || "", ""];
    return `<button type="button" class="job ${cls}" data-job="${j.id}" title="${esc(`${j.leads?.name || ""} · ${label}. Click to reschedule.`)}">
      <b>${esc(j.leads?.client_code || "—")}</b> · ${esc(o.system_size_kw ?? "")} kW ${esc(SHORT_TYPE[o.system_type] || "")}
      <small>${esc(j.time_slot)}</small>
      <small>${esc(label)}${j.status === "rescheduled" ? " · moved" : ""}</small>
    </button>`;
  }

  // Service visit card: opens the ticket (service.js)
  function visitCard(t) {
    const done = ["resolved", "closed"].includes(t.status);
    return `<button type="button" class="job job--svc${t.kind === "checkup" ? " job--checkup" : ""}${done ? " is-done" : ""}" data-ticket="${t.id}"
      title="${esc(`${t.leads?.name || ""} · ${t.ticket_number}`)}">
      <b>${esc(t.leads?.client_code || "—")}</b> · ${t.kind === "checkup" ? "Checkup" : esc(window.Service?.CATEGORY[t.category] || "Service")}
      <small>${esc(t.visit_slot || "")}</small>
      <small>${esc(t.ticket_number)}${done ? " · done" : t.priority === "urgent" ? " · URGENT" : ""}</small>
    </button>`;
  }

  function render() {
    const days = [0, 1, 2, 3, 4, 5].map((i) => addDays(week, i));
    const today = todayISO();
    $("schedWeek").textContent = `${fmtDay(days[0])} – ${fmtDay(days[5])}`;
    const rows = crews.filter((c) => c.active || jobs.some((j) => j.crew_id === c.id));
    if (jobs.some((j) => !j.crew_id)) rows.push({ id: null, name: "No crew", active: true });
    if (!rows.length) return ($("schedBody").innerHTML = `<p class="empty">No crews yet. Add them in Supabase (see SETUP-ORDERS.md).</p>`);
    $("schedBody").innerHTML = `<div class="week">
      <div class="week__corner">${jobs.length} install${jobs.length === 1 ? "" : "s"}${visits.length ? ` · ${visits.length} visit${visits.length === 1 ? "" : "s"}` : ""}</div>
      ${days.map((d) => `<div class="week__day${d === today ? " is-today" : ""}">${esc(fmtDay(d))}</div>`).join("")}
      ${rows.map((c) => `<div class="week__crew">${esc(c.name)}${c.active ? "" : " <small>(inactive)</small>"}</div>
        ${days.map((d) => {
          const here = jobs.filter((j) => (j.crew_id || null) === c.id && j.scheduled_date === d);
          const calls = visits.filter((t) => t.crew_id === c.id && t.visit_date === d);
          const load = here.reduce((a, j) => a + units(j.time_slot), 0)
            + calls.filter((t) => !["resolved", "closed"].includes(t.status)).reduce((a, t) => a + (t.kind === "checkup" ? 0.5 : 1), 0);
          return `<div class="week__cell${load >= 2 && c.id ? " is-full" : ""}${d < today ? " is-past" : ""}">${here.map(jobCard).join("")}${calls.map(visitCard).join("")}</div>`;
        }).join("")}`).join("")}
    </div>`;
  }

  $("schedPrev").addEventListener("click", () => { week = addDays(week, -7); load(); });
  $("schedNext").addEventListener("click", () => { week = addDays(week, 7); load(); });
  $("schedToday").addEventListener("click", () => { week = mondayOf(todayISO()); load(); });
  $("schedBody").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-job]");
    if (b) openJob(b.dataset.job);
    const t = e.target.closest("button[data-ticket]");
    if (t) window.Service?.openTicket(t.dataset.ticket);
  });

  registerView("schedule", load);

  // ---------- Reschedule ----------
  let editing = null;
  let onSaved = null;

  async function openJob(id, after) {
    const { data: j, error } = await sb.from("install_jobs").select(JOB_SELECT).eq("id", id).single();
    if (error) return toast("Couldn't open the job: " + error.message);
    if (!crews.length) crews = (await sb.from("crews").select("*").order("name")).data || [];
    editing = j;
    onSaved = after || null;
    const f = $("jobForm");
    $("jobTitle").textContent = `Reschedule ${j.orders?.order_number || "installation"}`;
    $("jobMeta").textContent = [j.leads?.name, j.leads?.client_code, j.leads?.location,
      `${j.orders?.system_size_kw ?? "?"} kW ${SHORT_TYPE[j.orders?.system_type] || ""}`, j.est_hours ? `about ${j.est_hours} h` : ""]
      .filter(Boolean).join(" · ");
    f.scheduled_date.value = j.scheduled_date;
    f.time_slot.value = j.time_slot;
    f.crew_id.innerHTML = `<option value="">No crew</option>` +
      crews.filter((c) => c.active || c.id === j.crew_id).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    f.crew_id.value = j.crew_id || "";
    f.reason.value = "";
    $("jobError").textContent = "";
    $("jobModal").hidden = false;
    await checkConflict();
  }

  // Warn (don't block) when the crew is already full that day
  async function checkConflict() {
    const f = $("jobForm");
    const date = f.scheduled_date.value;
    const slot = f.time_slot.value;
    const msgs = [];
    if (date && new Date(date + "T00:00:00Z").getUTCDay() === 0) msgs.push("That's a Sunday: crews work Monday to Saturday.");
    if (date && date < todayISO()) msgs.push("That date is in the past.");
    if (date && f.crew_id.value) {
      const crew = crews.find((c) => c.id === f.crew_id.value)?.name || "This crew";
      const [{ data: load }, { data: same }] = await Promise.all([
        sb.rpc("crew_day_load", { p_crew_id: f.crew_id.value, p_date: date, p_exclude_job: editing.id }),
        sb.from("install_jobs").select("id, time_slot, leads!install_jobs_lead_id_fkey(client_code)")
          .eq("crew_id", f.crew_id.value).eq("scheduled_date", date).neq("status", "cancelled").neq("id", editing.id),
      ]);
      const others = (same || []).map((j) => `${j.leads?.client_code || "a job"} (${j.time_slot})`).join(", ");
      if ((load || 0) + units(slot) > 2) {
        msgs.push(`${crew} is already ${load >= 2 ? "fully booked" : "booked for half the day"} on ${fmtDay(date)}${others ? ` (${others})` : ""}. A ${slot.toLowerCase()} job doesn't fit.`);
      } else if ((same || []).some((j) => j.time_slot === slot)) {
        msgs.push(`${crew} already has ${others} in the ${slot.toLowerCase()} slot on ${fmtDay(date)}.`);
      }
    }
    $("jobWarn").hidden = !msgs.length;
    $("jobWarn").innerHTML = msgs.map(esc).join("<br>");
    $("jobSave").textContent = msgs.length ? "Save anyway" : "Save";
    return msgs;
  }

  $("jobForm").addEventListener("change", checkConflict);

  $("jobForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const reason = f.reason.value.trim();
    if (!reason) return ($("jobError").textContent = "Give a reason for the change; it goes in the lead's activity.");
    const btn = $("jobSave");
    btn.disabled = true;
    const date = f.scheduled_date.value;
    const slot = f.time_slot.value;
    const crew = crews.find((c) => c.id === f.crew_id.value);
    const moved = date !== editing.scheduled_date || slot !== editing.time_slot || (f.crew_id.value || null) !== editing.crew_id;
    const { error } = await sb.from("install_jobs").update({
      scheduled_date: date, time_slot: slot, crew_id: f.crew_id.value || null,
      status: moved && editing.status === "scheduled" ? "rescheduled" : editing.status,
      notes: [editing.notes, `${todayISO()}: ${reason}`].filter(Boolean).join("\n"),
    }).eq("id", editing.id);
    btn.disabled = false;
    if (error) return ($("jobError").textContent = error.message);
    const oldCrew = crews.find((c) => c.id === editing.crew_id)?.name || "no crew";
    await sb.from("lead_activities").insert({
      lead_id: editing.lead_id, type: "note", created_by: state.me.email,
      body: `Installation for ${editing.orders?.order_number || "the order"} moved to ${fmtDay(date)}, ${slot}, ${crew?.name || "no crew"} (was ${fmtDay(editing.scheduled_date)}, ${editing.time_slot}, ${oldCrew}): ${reason}`,
    });
    $("jobModal").hidden = true;
    toast("Installation rescheduled");
    if (viewOpen("schedule")) load();
    onSaved?.();
    loadTiles();
  });

  document.querySelectorAll("[data-close-job]").forEach((el) => el.addEventListener("click", () => ($("jobModal").hidden = true)));

  // ---------- Technician portal: My jobs ----------
  const CHECKLIST = [
    ["panels_mounted", "Panels mounted, structure bolted and level"],
    ["dc_wiring", "DC wiring and MC4 connectors checked"],
    ["inverter", "Inverter installed and powered on"],
    ["earthing", "Earthing done and tested"],
    ["lightning_arrestor", "Lightning arrestor installed"],
    ["acdb_dcdb", "ACDB / DCDB connected"],
    ["generation", "System generating power"],
    ["handover", "Site cleaned; customer shown how it works"],
  ];
  let myJobs = [];

  async function technicianHome() {
    const { data, error } = await sb.rpc("my_install_jobs");
    if (error) return ($("techList").innerHTML = `<li class="m-empty">Couldn't load your jobs: ${esc(error.message)}</li>`);
    myJobs = data || [];
    window.Visits?.home(); // service visits (service-visits.js)
    const today = todayISO();
    const open = myJobs.filter((j) => j.job_status !== "done");
    $("techSub").textContent = open.length ? `${open.length} to do` : "All done";
    $("techList").innerHTML = myJobs.length
      ? myJobs.map((j) => {
          const done = j.job_status === "done";
          const going = j.job_status === "in_progress";
          const ready = j.packing_status === "Dispatched";
          const badge = done ? ["Installed", "done"] : going ? ["In progress", "scheduled"] : [j.packing_status, ready ? "done" : ""];
          return `<li class="${done || (j.scheduled_date < today && !going) ? "is-past" : ""}" data-job="${j.job_id}">
          <div class="m-head"><span class="m-title">${esc(j.client_name)}</span><span class="m-badge ${badge[1]}">${esc(badge[0])}</span></div>
          <div class="eng-id">Client ID <b>${esc(j.client_code || "—")}</b>${j.area ? ` · ${esc(j.area)}` : ""}</div>
          <div class="m-meta"><b>${j.scheduled_date === today ? "Today" : esc(fmtDay(j.scheduled_date))}</b> · ${esc(j.time_slot)} · ${esc(j.crew_name || "")} · ${esc(j.system_size_kw)} kW ${esc(SHORT_TYPE[j.system_type] || j.system_type || "")}</div>
          <details${j.scheduled_date === today && !done ? " open" : ""}>
            <summary>Items to carry (${j.items.length})</summary>
            <ul class="tech-items">${j.items.map((i) => `<li><span>${esc(i.description)}${i.serials?.length ? `<small>S/N ${esc(i.serials.join(", "))}</small>` : ""}</span><b>${esc(i.qty)} ${esc(i.unit || "")}</b></li>`).join("")}</ul>
          </details>
          <div class="m-actions">
            ${done
              ? `<span class="m-meta">Completed ${esc(fmtDateTime(j.finished_at))} · signed by ${esc(j.signed_by_name || "")}</span>`
              : going
                ? `<button type="button" class="btn btn--primary btn--sm" data-install>Continue installation</button>`
                : ready
                  ? `<button type="button" class="btn btn--primary btn--sm" data-start>Start installation</button>`
                  : `<button type="button" class="btn btn--ghost btn--sm" disabled>Waiting for dispatch</button>`}
            ${j.area ? `<a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(j.area)}">Map</a>` : ""}
          </div>
        </li>`;
        }).join("")
      : `<li class="m-empty">No installation jobs for your crew yet.</li>`;
  }

  // Safety checks before work can start (same keys as public.install_safety_keys)
  const SAFETY = [
    ["ppe", "Helmet, gloves and safety shoes on"],
    ["harness", "Safety harness worn and anchored on the roof"],
    ["ladder", "Ladder secured / safe access to the roof"],
    ["weather", "Weather is safe (no rain, lightning or strong wind)"],
    ["dc_isolation", "DC isolator OFF and panels covered while wiring"],
    ["first_aid", "First-aid kit on site"],
  ];
  // Photo slots (same as public.install_photo_slots); a photo's file name starts with its slot
  const PHOTO_SLOTS = [
    ["before", "Before work", true], ["panels", "Panels & structure", true], ["inverter", "Inverter", true],
    ["earthing", "Earthing pit", true], ["acdb", "ACDB / DCDB", true], ["meter", "Meter", false], ["after", "After work", true],
  ];
  const slotOf = (path) => (path.split("/")[1] || "").split("-")[0];

  $("techList").addEventListener("click", async (e) => {
    const li = e.target.closest("li[data-job]");
    if (!li) return;
    const j = myJobs.find((x) => x.job_id === li.dataset.job);
    if (e.target.closest("[data-start]")) {
      return openSafety(`${j.client_name} · Client ID ${j.client_code || "—"}`, async (safety) => {
        const { error } = await sb.rpc("start_installation", { p_job_id: j.job_id, p_safety: safety });
        if (error) throw error;
        toast("Installation started");
        await technicianHome();
        openInstall(myJobs.find((x) => x.job_id === j.job_id));
      });
    }
    if (e.target.closest("[data-install]")) openInstall(j);
  });
  $("techRefresh").addEventListener("click", technicianHome);

  // ---------- Safety first (installations and service visits) ----------
  let onSafe = null;

  function openSafety(meta, start) {
    onSafe = start;
    $("safetyMeta").textContent = meta;
    $("safetyList").innerHTML = SAFETY.map(([k, label]) => `<label class="check"><input type="checkbox" name="sf_${k}"> ${esc(label)}</label>`).join("");
    $("safetyError").textContent = "";
    $("safetyModal").hidden = false;
  }

  $("safetyStart").addEventListener("click", async () => {
    const f = $("safetyForm");
    const safety = Object.fromEntries(SAFETY.map(([k]) => [k, f[`sf_${k}`].checked]));
    if (Object.values(safety).some((v) => !v)) return ($("safetyError").textContent = "Tick every safety check before going on the roof.");
    const btn = $("safetyStart");
    btn.disabled = true;
    try {
      await onSafe(safety);
      $("safetyModal").hidden = true;
    } catch (err) {
      $("safetyError").textContent = err.message || String(err);
    } finally {
      btn.disabled = false;
    }
  });
  document.querySelectorAll("[data-close-safety]").forEach((el) => el.addEventListener("click", () => ($("safetyModal").hidden = true)));

  // ---------- Installation form: checklist, photos, panel serials, generation, customer signature ----------
  let job = null;
  let photos = [];

  function openInstall(j) {
    job = j;
    photos = Array.isArray(j.photos) ? [...j.photos] : [];
    const f = $("installForm");
    f.reset();
    $("instTitle").textContent = `Installation · ${j.client_name}`;
    $("instMeta").textContent = `Client ID ${j.client_code || "—"} · ${j.system_size_kw} kW ${SHORT_TYPE[j.system_type] || ""} · started ${fmtDateTime(j.started_at)}`;
    $("instChecklist").innerHTML = CHECKLIST.map(([k, label]) =>
      `<label class="check"><input type="checkbox" name="ck_${k}" ${j.checklist?.[k] ? "checked" : ""}> ${esc(label)}</label>`).join("");
    f.generation_kwh.value = j.generation_kwh ?? "";
    f.installed_kw.value = j.installed_kw ?? j.system_size_kw ?? "";
    f.install_notes.value = j.install_notes || "";
    $("instError").textContent = "";
    $("installModal").hidden = false;
    clearSignature(); // sized to the pad as shown, so strokes land under the finger
    renderSerials();
    renderPhotos();
  }

  function readInstall() {
    const f = $("installForm");
    const g = f.generation_kwh.value.trim();
    return {
      p_job_id: job.job_id,
      p_checklist: Object.fromEntries(CHECKLIST.map(([k]) => [k, f[`ck_${k}`].checked])),
      p_photos: photos,
      p_generation_kwh: g === "" ? null : Number(g),
      p_notes: f.install_notes.value.trim() || null,
    };
  }

  // ---------- Panel serial numbers, scanned on the roof ----------
  function renderSerials(focusId) {
    const items = job.items.filter((i) => i.site_serial);
    $("instSerialsBlock").hidden = !items.length;
    $("instSerials").innerHTML = items.map((i) => {
      const need = Math.ceil(Number(i.qty));
      const list = i.serial_list || [];
      return `<div class="site-serials" data-item="${i.id}">
        <div class="site-serials__head"><b>${esc(i.description)}</b><span class="${list.length < need ? "overdue" : "ok"}">${list.length} / ${need} scanned</span></div>
        <div class="serials">${list.map((s) => `<span class="serial">${esc(s.serial_no)}<button type="button" data-rm-serial="${s.id}" aria-label="Remove ${esc(s.serial_no)}">✕</button></span>`).join("")}</div>
        ${list.length < need ? `<span class="serial-add">
          <input data-site-serial="${i.id}" placeholder="Scan or type panel serial, then Enter" autocomplete="off" autocapitalize="characters">
          ${window.Scanner.available ? `<button type="button" class="btn btn--ghost btn--sm" data-site-cam="${i.id}" title="Scan with the camera">📷</button>` : ""}
        </span>` : ""}
      </div>`;
    }).join("");
    if (focusId) document.querySelector(`[data-site-serial="${focusId}"]`)?.focus();
  }

  // Fresh serial list from the database after each change
  async function reloadJob() {
    const { data } = await sb.rpc("my_install_jobs");
    const fresh = (data || []).find((x) => x.job_id === job.job_id);
    if (fresh) job.items = fresh.items;
  }

  async function addSiteSerial(itemId, value) {
    const serial = value.trim();
    if (!serial) return;
    const { error } = await sb.rpc("add_site_serial", { p_job_id: job.job_id, p_order_item_id: itemId, p_serial: serial });
    if (error) return toast(error.message);
    toast(`Serial ${serial.toUpperCase()} added`);
    await reloadJob();
    renderSerials(itemId);
  }

  $("instSerials").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches("[data-site-serial]")) return;
    e.preventDefault();
    addSiteSerial(e.target.dataset.siteSerial, e.target.value);
  });
  $("instSerials").addEventListener("click", async (e) => {
    const cam = e.target.closest("[data-site-cam]");
    if (cam) {
      const code = await window.Scanner.scan("Scan panel serial");
      if (code) await addSiteSerial(cam.dataset.siteCam, code);
      return;
    }
    const rm = e.target.closest("[data-rm-serial]");
    if (!rm) return;
    const { error } = await sb.rpc("remove_site_serial", { p_job_id: job.job_id, p_serial_id: rm.dataset.rmSerial });
    if (error) return toast(error.message);
    await reloadJob();
    renderSerials();
  });

  // ---------- Photos: one slot per required view ----------
  async function renderPhotos() {
    const { data } = photos.length ? await sb.storage.from("install-photos").createSignedUrls(photos, 3600) : { data: [] };
    const url = Object.fromEntries((data || []).map((p) => [p.path, p.signedUrl]));
    const missing = PHOTO_SLOTS.filter(([slot, , req]) => req && !photos.some((p) => slotOf(p) === slot)).length;
    $("instPhotoCount").textContent = missing ? `${missing} required photo${missing === 1 ? "" : "s"} still to take` : "All required photos taken ✓";
    $("instSlots").innerHTML = PHOTO_SLOTS.map(([slot, label, req]) => {
      const mine = photos.map((p, i) => [p, i]).filter(([p]) => slotOf(p) === slot);
      return `<div class="photo-slot${mine.length ? " is-done" : req ? " is-missing" : ""}">
        <div class="photo-slot__head"><b>${esc(label)}</b>${req ? "" : ` <small>(optional)</small>`}${mine.length ? ` <span class="ok">✓</span>` : ""}</div>
        <div class="photos">${mine.map(([p, i]) => `<figure>
            <a href="${esc(url[p] || "#")}" target="_blank" rel="noopener"><img src="${esc(url[p] || "")}" alt="${esc(label)} photo" loading="lazy"></a>
            <button type="button" class="icon-btn" data-remove-photo="${i}" aria-label="Remove photo">✕</button>
          </figure>`).join("")}
          <label class="photo-tile" title="Add a ${esc(label)} photo">＋<input type="file" accept="image/*" capture="environment" multiple hidden data-slot="${slot}"></label>
        </div>
      </div>`;
    }).join("");
  }

  $("instSlots").addEventListener("change", async (e) => {
    const input = e.target.closest("input[data-slot]");
    if (!input || !job) return;
    const files = [...input.files];
    const slot = input.dataset.slot;
    input.value = "";
    if (!files.length) return;
    const tile = input.closest(".photo-slot");
    tile.classList.add("is-busy");
    for (const file of files) {
      try {
        const blob = await window.Surveys.compress(file);
        const path = `${job.job_id}/${slot}-${crypto.randomUUID()}.jpg`;
        const { error } = await sb.storage.from("install-photos").upload(path, blob, { contentType: "image/jpeg" });
        if (error) throw error;
        photos.push(path);
      } catch (err) {
        toast("Photo upload failed: " + (err.message || err));
      }
    }
    await sb.rpc("save_installation", readInstall()); // keep the photos even if the phone loses signal later
    renderPhotos();
  });

  $("instSlots").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-remove-photo]");
    if (!b) return;
    const [path] = photos.splice(Number(b.dataset.removePhoto), 1);
    await sb.storage.from("install-photos").remove([path]);
    await sb.rpc("save_installation", readInstall());
    renderPhotos();
  });

  // Signature pad: finger, stylus or mouse. Call clear() once the pad is visible, so it matches its size on screen.
  function makePad(canvas) {
    const ctx = canvas.getContext("2d");
    let drawing = false;
    let signed = false;
    const at = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    canvas.addEventListener("pointerdown", (e) => {
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      ctx.beginPath();
      ctx.moveTo(...at(e));
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      ctx.lineTo(...at(e));
      ctx.stroke();
      signed = true;
    });
    ["pointerup", "pointercancel"].forEach((t) => canvas.addEventListener(t, () => (drawing = false)));
    return {
      clear() {
        const r = canvas.getBoundingClientRect();
        const scale = window.devicePixelRatio || 1;
        canvas.width = Math.round((r.width || 600) * scale);
        canvas.height = Math.round((r.height || 180) * scale);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#0E2233";
        signed = false;
      },
      signed: () => signed,
      blob: () => new Promise((resolve) => canvas.toBlob(resolve, "image/png")),
    };
  }

  const pad = makePad($("instSignature"));
  const clearSignature = () => pad.clear();
  $("instClearSig").addEventListener("click", clearSignature);

  $("installForm").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-inst]");
    if (!b || !job) return;
    $("instError").textContent = "";
    b.disabled = true;
    try {
      if (b.dataset.inst === "save") {
        const { error } = await sb.rpc("save_installation", readInstall());
        if (error) throw error;
        toast("Progress saved");
      } else {
        const name = $("installForm").signed_by.value.trim();
        if (!name) throw new Error("Type the customer's name.");
        if (!pad.signed()) throw new Error("Ask the customer to sign in the box.");
        const kw = Number($("installForm").installed_kw.value);
        if (!(kw > 0)) throw new Error("Confirm the installed system size (kW).");
        const { error: kwError } = await sb.rpc("confirm_installed_size", { p_job_id: job.job_id, p_kw: kw });
        if (kwError) throw kwError;
        const blob = await pad.blob();
        const path = `${job.job_id}/signature.png`;
        const { error: upError } = await sb.storage.from("install-photos").upload(path, blob, { contentType: "image/png", upsert: true });
        if (upError) throw upError;
        const { error } = await sb.rpc("complete_installation", { ...readInstall(), p_signed_by: name, p_signature_path: path });
        if (error) throw error;
        $("installModal").hidden = true;
        toast("Installation completed. The customer gets a WhatsApp now.");
      }
      await technicianHome();
    } catch (err) {
      $("instError").textContent = err.message || String(err);
    } finally {
      b.disabled = false;
    }
  });
  document.querySelectorAll("[data-close-install]").forEach((el) => el.addEventListener("click", () => ($("installModal").hidden = true)));

  // Jobs booked by the office appear without a reload
  setInterval(() => {
    if (viewOpen("schedule") && $("jobModal").hidden) load();
    if (!$("techView").hidden && $("installModal").hidden && $("safetyModal").hidden && $("svcModal").hidden) technicianHome();
  }, 30000);

  window.Schedule = { openJob, technicianHome, openSafety, makePad, reload: () => viewOpen("schedule") && load() };
})();
