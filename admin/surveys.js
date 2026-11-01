// Site surveys: engineers fill in the form (with photos) → managers approve → final quote
(() => {
  const { sb, state, esc, toast, todayISO, loadActivity, loadMeetings, openDrawer, staffName, refreshLead } = window.CRM;
  const $ = (id) => document.getElementById(id);

  const STATUS = {
    draft: ["Draft", ""],
    submitted: ["Waiting for approval", "scheduled"],
    approved: ["Approved", "done"],
    changes_requested: ["Changes requested", "cancelled"],
  };
  const FIELDS = ["visited_at", "roof_direction", "roof_tilt", "roof_type", "roof_condition", "usable_area_sqft",
    "structure_height", "shading", "dc_cable_m", "ac_cable_m", "phase", "sanctioned_load_kw", "inverter_location",
    "earthing_location", "system_type", "panel_count", "recommended_kw", "notes"];
  const NUMERIC = new Set(["usable_area_sqft", "dc_cable_m", "ac_cable_m", "sanctioned_load_kw", "panel_count", "recommended_kw"]);
  // Must be filled before an engineer can submit
  const REQUIRED = [["roof_direction", "Roof direction"], ["roof_type", "Roof type"], ["usable_area_sqft", "Usable area"],
    ["dc_cable_m", "DC cable length"], ["ac_cable_m", "AC cable length"], ["phase", "Meter phase"],
    ["system_type", "System type"], ["panel_count", "Number of panels"]];

  const fmtDay = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  const me = () => state.me.email.toLowerCase();

  let current = null; // { survey, meeting, lead }
  let photos = [];    // storage paths
  let panelWatt = 540;
  let tab = null;

  async function loadPanelWatt() {
    const { data } = await sb.from("quote_settings").select("settings").eq("id", 1).maybeSingle();
    panelWatt = Number(data?.settings?.panel_watt) || 540;
  }

  // ---------- Top bar count ----------
  async function refreshCount() {
    if (!state.me) return;
    let count = 0;
    if (state.isManager) {
      const { count: c } = await sb.from("surveys").select("id", { count: "exact", head: true }).eq("status", "submitted");
      count = c || 0;
    } else {
      const { count: c } = await sb.from("meetings").select("id", { count: "exact", head: true })
        .eq("type", "site_survey").eq("status", "scheduled").ilike("assigned_to", me()).gte("scheduled_date", todayISO());
      count = c || 0;
    }
    $("surveysCount").textContent = count;
    $("surveysCount").hidden = !count;
  }

  // ---------- Surveys list ----------
  $("surveysBtn").addEventListener("click", async () => {
    tab = tab || (state.isManager ? "approve" : "mine");
    $("surveysModal").hidden = false;
    await renderList();
  });
  document.querySelectorAll("[data-close-surveys]").forEach((el) => el.addEventListener("click", () => ($("surveysModal").hidden = true)));
  $("surveyTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    renderList();
  });

  async function renderList() {
    const tabs = [["mine", "My surveys"], ...(state.isManager ? [["approve", "To approve"]] : []), ["all", "All upcoming"]];
    $("surveyTabs").innerHTML = tabs.map(([k, l]) => `<button type="button" data-tab="${k}" class="${tab === k ? "is-active" : ""}">${l}</button>`).join("");
    $("surveysSub").textContent = state.isManager ? "Assign engineers from the lead's Meetings; approve submitted surveys here." : "Surveys assigned to you.";
    $("surveyList").innerHTML = `<li class="m-empty">Loading…</li>`;

    const since = new Date(Date.now() - 30 * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    let mq = sb.from("meetings").select("*").eq("type", "site_survey").neq("status", "cancelled").gte("scheduled_date", since).order("scheduled_date");
    if (tab === "mine") mq = mq.ilike("assigned_to", me());
    const [{ data: meetings, error }, { data: surveys }] = await Promise.all([
      mq, sb.from("surveys").select("*").order("updated_at", { ascending: false }).limit(300),
    ]);
    if (error) return ($("surveyList").innerHTML = `<li class="m-empty">Surveys aren't set up yet (run surveys.sql).</li>`);

    const byMeeting = new Map((surveys || []).filter((s) => s.meeting_id).map((s) => [s.meeting_id, s]));
    let rows = meetings.map((m) => ({ m, s: byMeeting.get(m.id) }));
    if (tab === "approve") rows = (surveys || []).filter((s) => s.status === "submitted").map((s) => ({ m: meetings.find((x) => x.id === s.meeting_id), s }));
    else if (tab === "all") rows = rows.filter(({ m, s }) => m.scheduled_date >= todayISO() || (s && s.status !== "approved"));
    else rows = rows.filter(({ m, s }) => !s || s.status !== "approved" || m.scheduled_date >= todayISO());

    if (!rows.length) return ($("surveyList").innerHTML = `<li class="m-empty">${tab === "approve" ? "Nothing waiting for approval." : "No surveys here."}</li>`);
    const leadIds = [...new Set(rows.map((r) => r.s?.lead_id || r.m?.lead_id))];
    const { data: leads } = await sb.from("leads").select("id,name,phone,location").in("id", leadIds);
    const leadOf = (id) => (leads || []).find((l) => l.id === id) || {};

    $("surveyList").innerHTML = rows.map(({ m, s }) => {
      const l = leadOf(s?.lead_id || m?.lead_id);
      const [label, cls] = s ? STATUS[s.status] : ["Not started", ""];
      const when = m ? `${fmtDay(m.scheduled_date)}${m.time_slot ? " · " + m.time_slot : ""}` : "";
      return `<li data-meeting="${m?.id || ""}" data-survey="${s?.id || ""}" data-lead="${l.id || ""}">
        <div class="m-head"><span class="m-title">${esc(l.name || "Lead")}</span><span class="m-badge ${cls}">${label}</span></div>
        <div class="m-meta">${esc(when)}${l.location ? " · " + esc(l.location) : ""}${m?.assigned_to ? " · " + esc(staffName(m.assigned_to)) : " · not assigned"}</div>
        <div class="m-actions">
          ${l.phone ? `<a class="btn btn--ghost btn--sm" href="tel:${esc(l.phone)}">Call ${esc(l.phone)}</a>` : ""}
          ${l.location ? `<a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.location)}">Map</a>` : ""}
          <button type="button" class="btn btn--primary btn--sm" data-open>${s ? (s.status === "submitted" && state.isManager ? "Review" : "Open form") : "Start survey"}</button>
        </div>
      </li>`;
    }).join("");
  }

  $("surveyList").addEventListener("click", async (e) => {
    if (!e.target.closest("button[data-open]")) return;
    const li = e.target.closest("li");
    if (li.dataset.survey) await openSurvey(li.dataset.survey);
    else await openForMeeting(li.dataset.meeting);
  });

  // ---------- Opening the form ----------
  async function openForMeeting(meetingId, lead) {
    const { data: m } = await sb.from("meetings").select("*").eq("id", meetingId).maybeSingle();
    if (!m) return toast("Meeting not found");
    const { data: s } = await sb.from("surveys").select("*").eq("meeting_id", meetingId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const l = lead?.id === m.lead_id ? lead : (await sb.from("leads").select("*").eq("id", m.lead_id).single()).data;
    showForm(s, m, l);
  }

  async function openSurvey(surveyId) {
    const { data: s } = await sb.from("surveys").select("*").eq("id", surveyId).maybeSingle();
    if (!s) return toast("Survey not found");
    const [{ data: m }, { data: l }] = await Promise.all([
      s.meeting_id ? sb.from("meetings").select("*").eq("id", s.meeting_id).maybeSingle() : Promise.resolve({ data: null }),
      sb.from("leads").select("*").eq("id", s.lead_id).single(),
    ]);
    showForm(s, m, l);
  }

  function editable(s) {
    if (state.isManager) return true;
    return !s || s.status === "draft" || s.status === "changes_requested";
  }

  async function showForm(s, m, l) {
    if (!isEngineer()) await loadPanelWatt();
    current = { survey: s, meeting: m, lead: l };
    photos = Array.isArray(s?.photos) ? [...s.photos] : [];
    const f = $("surveyForm");
    f.reset();

    $("sfTitle").textContent = `Site survey · ${l.name}`;
    const visit = m ? `${fmtDay(m.scheduled_date)}${m.time_slot ? " · " + m.time_slot : ""}` : "";
    $("sfMeta").textContent = isEngineer()
      ? [l.client_code ? `Client ID ${l.client_code}` : "", visit].filter(Boolean).join(" · ")
      : [l.client_code, l.phone, l.location, visit].filter(Boolean).join(" · ");

    // Defaults from what we already know about the lead
    const defaults = {
      visited_at: todayISO(),
      roof_type: /rcc|concrete/i.test(l.roof_type || "") ? "RCC (concrete)" : "",
      usable_area_sqft: parseFloat(String(l.roof_area || "").replace(/[^\d.]/g, "")) || "",
      shading: l.shading || "",
      system_type: /hybrid/i.test(l.system_type || "") ? "hybrid" : /off|battery/i.test(l.system_type || "") ? "off_grid" : /on/i.test(l.system_type || "") ? "on_grid" : "",
    };
    FIELDS.forEach((k) => { if (f[k]) f[k].value = s?.[k] ?? defaults[k] ?? ""; });
    f.engineer_email.value = staffName(s?.engineer_email || m?.assigned_to || state.me.email);

    const note = $("sfReviewNote");
    note.hidden = !(s?.manager_notes && s.status === "changes_requested");
    if (!note.hidden) note.textContent = `Manager's note: ${s.manager_notes}`;

    const canEdit = editable(s);
    [...f.elements].forEach((el) => { if (el.name && el.name !== "engineer_email") el.disabled = !canEdit; });
    $("sfPhotoAdd").hidden = !canEdit;
    renderActions(s);
    $("sfError").textContent = "";
    await renderPhotos();
    $("surveyModal").hidden = false;
  }

  document.querySelectorAll("[data-close-survey]").forEach((el) => el.addEventListener("click", () => ($("surveyModal").hidden = true)));

  function renderActions(s) {
    const status = s?.status || "draft";
    const btns = [];
    if (editable(s) && status !== "approved") {
      btns.push(`<button type="button" class="btn btn--ghost" data-sf="draft">Save draft</button>`);
      if (status !== "submitted") btns.push(`<button type="button" class="btn btn--primary" data-sf="submit">Submit for approval</button>`);
    }
    if (state.isManager && status === "submitted") {
      btns.push(`<textarea name="manager_notes" rows="2" placeholder="Note to the engineer (needed when requesting changes)"></textarea>`);
      btns.push(`<button type="button" class="btn btn--ghost" data-sf="changes">Request changes</button>`);
      btns.push(`<button type="button" class="btn btn--primary" data-sf="approve">Approve survey</button>`);
    }
    if (status === "approved") {
      btns.push(`<p class="muted">Approved by ${esc(staffName(s.reviewed_by))}${s.reviewed_at ? " on " + new Date(s.reviewed_at).toLocaleDateString("en-IN") : ""}.</p>`);
      if (state.isManager) btns.push(`<button type="button" class="btn btn--primary" data-sf="final">Prepare final quote</button>`);
    }
    $("sfActions").innerHTML = btns.join("");
  }

  // ---------- Photos ----------
  async function renderPhotos() {
    if (!photos.length) return ($("sfPhotos").innerHTML = `<p class="muted">No photos yet.</p>`);
    const { data } = await sb.storage.from("survey-photos").createSignedUrls(photos, 3600);
    const canEdit = editable(current.survey);
    $("sfPhotos").innerHTML = (data || []).map((p, i) => `<figure>
        <a href="${esc(p.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(p.signedUrl)}" alt="Survey photo ${i + 1}" loading="lazy"></a>
        ${canEdit ? `<button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove photo">✕</button>` : ""}
      </figure>`).join("");
  }

  // Shrink camera photos (often 5–10 MB) so they upload quickly on mobile data
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

  $("sfPhotoInput").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length || !current) return;
    const survey = await ensureSurvey();
    if (!survey) return;
    $("sfPhotoAdd").classList.add("is-busy");
    for (const file of files) {
      try {
        const blob = await compress(file);
        const path = `${current.lead.id}/${survey.id}/${crypto.randomUUID()}.jpg`;
        const { error } = await sb.storage.from("survey-photos").upload(path, blob, { contentType: "image/jpeg" });
        if (error) throw error;
        photos.push(path);
      } catch (err) {
        toast("Photo upload failed: " + (err.message || err));
      }
    }
    await sb.from("surveys").update({ photos }).eq("id", survey.id);
    $("sfPhotoAdd").classList.remove("is-busy");
    await renderPhotos();
  });

  $("sfPhotos").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-remove]");
    if (!b || !current?.survey) return;
    const [path] = photos.splice(Number(b.dataset.remove), 1);
    await sb.storage.from("survey-photos").remove([path]);
    await sb.from("surveys").update({ photos }).eq("id", current.survey.id);
    await renderPhotos();
  });

  // ---------- Saving ----------
  function readForm() {
    const f = $("surveyForm");
    const row = {};
    FIELDS.forEach((k) => {
      const v = f[k].value.trim();
      row[k] = v === "" ? null : NUMERIC.has(k) ? Number(v) : v;
    });
    // Size from the panel count, if the engineer didn't type it
    if (!row.recommended_kw && row.panel_count) row.recommended_kw = Math.round(row.panel_count * panelWatt) / 1000;
    return row;
  }

  // The survey row must exist before photos can be attached to it
  async function ensureSurvey() {
    if (current.survey) return current.survey;
    const { data, error } = await sb.from("surveys").insert({
      lead_id: current.lead.id, meeting_id: current.meeting?.id ?? null,
      engineer_email: current.meeting?.assigned_to || state.me.email, ...readForm(),
    }).select().single();
    if (error) { $("sfError").textContent = error.message; return null; }
    current.survey = data;
    return data;
  }

  async function note(body) {
    await sb.from("lead_activities").insert({ lead_id: current.lead.id, type: "note", created_by: state.me.email, body });
  }

  $("sfActions").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-sf]");
    if (!b || !current) return;
    const act = b.dataset.sf;
    $("sfError").textContent = "";

    if (act === "final") {
      $("surveyModal").hidden = true;
      $("surveysModal").hidden = true;
      await openDrawer(current.lead.id);
      window.CRM.showPane("deal");
      return window.Quotes?.prepareFinal(current.survey);
    }

    b.disabled = true;
    try {
      const survey = await ensureSurvey();
      if (!survey) return;
      const row = readForm();

      if (act === "draft") {
        const { data, error } = await sb.from("surveys").update({ ...row, photos }).eq("id", survey.id).select().single();
        if (error) throw error;
        current.survey = data;
        toast("Draft saved");
      }

      if (act === "submit") {
        const missing = REQUIRED.filter(([k]) => row[k] === null || row[k] === undefined).map(([, label]) => label);
        if (missing.length) throw new Error(`Please fill in: ${missing.join(", ")}`);
        if (!photos.length) throw new Error("Please add at least one photo of the roof.");
        const { data, error } = await sb.from("surveys").update({ ...row, photos, status: "submitted" }).eq("id", survey.id).select().single();
        if (error) throw error;
        current.survey = data;
        toast("Survey submitted for approval");
      }

      if (act === "approve" || act === "changes") {
        const managerNotes = $("sfActions").querySelector("textarea")?.value.trim() || null;
        if (act === "changes" && !managerNotes) throw new Error("Add a note telling the engineer what to change.");
        const status = act === "approve" ? "approved" : "changes_requested";
        const { data, error } = await sb.from("surveys").update({
          ...row, photos, status, manager_notes: managerNotes, reviewed_by: state.me.email, reviewed_at: new Date().toISOString(),
        }).eq("id", survey.id).select().single();
        if (error) throw error;
        current.survey = data;
        await note(act === "approve"
          ? `Site survey approved${managerNotes ? `: ${managerNotes}` : ""}. Ready for the final quote.`
          : `Site survey sent back to the engineer: ${managerNotes}`);
        toast(act === "approve" ? "Survey approved: prepare the final quote" : "Sent back to the engineer");
      }

      if (isEngineer()) {
        await engineerHome();
        if (act === "submit") $("surveyModal").hidden = true;
        else showForm(current.survey, current.meeting, current.lead);
        return;
      }
      showForm(current.survey, current.meeting, (await refreshLead(current.lead.id)) || current.lead);
      refreshCount();
      if (!$("surveysModal").hidden) renderList();
      if (state.current?.id === current.lead.id) {
        await Promise.all([loadActivity(current.lead.id), loadMeetings(current.lead.id), renderLead(current.lead)]);
      }
    } catch (err) {
      $("sfError").textContent = err.message || String(err);
    } finally {
      b.disabled = false;
    }
  });

  // ---------- Lead drawer: this lead's surveys ----------
  async function renderLead(l) {
    const { data, error } = await sb.from("surveys").select("*").eq("lead_id", l.id).order("created_at", { ascending: false });
    if (error) return ($("leadSurveys").innerHTML = `<li class="m-empty">Surveys aren't set up yet (run surveys.sql).</li>`);
    $("leadSurveys").innerHTML = data.length
      ? data.map((s) => {
          const [label, cls] = STATUS[s.status];
          return `<li data-survey="${s.id}">
            <div class="m-head"><span class="m-title">${s.panel_count ? `${s.panel_count} panels · ~${s.recommended_kw} kW` : "Survey"}${s.visited_at ? " · " + fmtDay(s.visited_at) : ""}</span><span class="m-badge ${cls}">${label}</span></div>
            <div class="m-meta">${esc(staffName(s.engineer_email))}${s.photos?.length ? ` · ${s.photos.length} photo(s)` : ""}</div>
            <div class="m-actions"><button type="button" class="btn btn--ghost btn--sm" data-open-survey>${s.status === "submitted" && state.isManager ? "Review" : "Open"}</button></div>
          </li>`;
        }).join("")
      : `<li class="m-empty">No survey yet. Open the site survey under Meetings to start one.</li>`;
  }

  $("leadSurveys").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-open-survey]");
    if (b) openSurvey(b.closest("li").dataset.survey);
  });

  // ---------- Engineer portal ----------
  function isEngineer() {
    return state.role === "engineer";
  }

  const JOB_STATUS = {
    none: ["To do", "scheduled"], draft: ["Draft saved", ""], submitted: ["Submitted", "done"],
    approved: ["Approved", "done"], changes_requested: ["Changes requested", "cancelled"],
  };
  let jobs = [];

  async function engineerHome() {
    const { data, error } = await sb.rpc("my_survey_jobs");
    if (error) return ($("engList").innerHTML = `<li class="m-empty">Couldn't load your surveys: ${esc(error.message)}</li>`);
    jobs = data || [];
    const today = todayISO();
    const open = jobs.filter((j) => !["submitted", "approved"].includes(j.survey_status));
    $("engSub").textContent = open.length ? `${open.length} to do` : "All done";
    $("engList").innerHTML = jobs.length
      ? jobs.map((j, i) => {
          const [label, cls] = JOB_STATUS[j.survey_status || "none"];
          const when = j.scheduled_date === today ? "Today" : fmtDay(j.scheduled_date);
          return `<li data-job="${i}">
            <div class="m-head"><span class="m-title">${esc(j.client_name)}</span><span class="m-badge ${cls}">${label}</span></div>
            <div class="eng-id">Client ID <b>${esc(j.client_code || "—")}</b></div>
            <div class="m-meta">${esc(when)}${j.time_slot ? " · " + esc(j.time_slot) : ""}</div>
          </li>`;
        }).join("")
      : `<li class="m-empty">No surveys assigned to you yet.</li>`;
  }

  async function openJob(j) {
    panelWatt = Number(j.panel_watt) || 540;
    const lead = { id: j.lead_id, name: j.client_name, client_code: j.client_code };
    const meeting = { id: j.meeting_id, lead_id: j.lead_id, scheduled_date: j.scheduled_date, time_slot: j.time_slot, status: j.meeting_status, assigned_to: state.me.email };
    let survey = null;
    if (j.survey_id) survey = (await sb.from("surveys").select("*").eq("id", j.survey_id).maybeSingle()).data;
    showForm(survey, meeting, lead);
  }

  $("engList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-job]");
    if (li) openJob(jobs[Number(li.dataset.job)]);
  });

  window.Surveys = { openForMeeting, openSurvey, renderLead, refreshCount, engineerHome, compress };
  setInterval(refreshCount, 60000);
})();
