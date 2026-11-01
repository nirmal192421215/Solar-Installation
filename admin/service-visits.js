// Technician: service visits in "My jobs" (breakdowns and pre-monsoon checkups) and the visit form
(() => {
  const { sb, esc, toast, todayISO, fmtDay, fmtDateTime } = window.CRM;
  const $ = (id) => document.getElementById(id);

  // Same keys as public.checkup_checklist_keys()
  const CHECKUP = [
    ["panels_cleaned", "Panels cleaned (dust, bird droppings)"],
    ["earthing_tested", "Earthing resistance tested"],
    ["cables_checked", "Cables checked for cuts, rodent or sun damage"],
    ["junctions_sealed", "Junction boxes and MC4 joints sealed against water"],
    ["structure_tightened", "Structure bolts tightened, rust treated"],
    ["inverter_checked", "Inverter checked: no errors, vents clear"],
    ["acdb_spd", "ACDB, surge protection and breakers checked"],
    ["drainage_clear", "Roof drainage clear around the structure"],
  ];
  const PHOTO_SLOTS = [["before", "Before", true], ["after", "After", true], ["other", "Other", false]];
  const PRIORITY = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
  const slotOf = (path) => (path.split("/")[1] || "").split("-")[0];

  let visits = [];
  let parts = []; // stock list for "parts used" (no prices)

  async function home() {
    const { data, error } = await sb.rpc("my_service_visits");
    if (error) return ($("techVisitsBlock").hidden = true); // service.sql not run yet
    visits = data || [];
    $("techVisitsBlock").hidden = !visits.length;
    const today = todayISO();
    const cat = (v) => (v.kind === "checkup" ? "Pre-monsoon checkup" : window.Service?.CATEGORY[v.category] || v.category);
    $("techVisits").innerHTML = visits.map((v) => {
      const done = ["resolved", "closed"].includes(v.status);
      return `<li class="${done ? "is-past" : ""}" data-visit="${v.ticket_id}">
        <div class="m-head"><span class="m-title">${esc(v.client_name)}</span>
          <span class="m-badge ${done ? "done" : v.priority === "urgent" ? "p-urgent" : "scheduled"}">${done ? "Done" : v.status === "in_progress" ? "In progress" : esc(PRIORITY[v.priority] || "")}</span></div>
        <div class="eng-id">${esc(v.ticket_number)} · <b>${esc(cat(v))}</b></div>
        <div class="m-meta">Client ID <b>${esc(v.client_code || "—")}</b>${v.area ? ` · ${esc(v.area)}` : ""} · <b>${v.visit_date === today ? "Today" : esc(fmtDay(v.visit_date))}</b>, ${esc(v.visit_slot || "")}</div>
        ${v.description && v.kind !== "checkup" ? `<p class="m-text">${esc(v.description)}</p>` : ""}
        <div class="m-actions">
          ${done ? `<span class="m-meta">Resolved ${esc(fmtDateTime(v.resolved_at))}</span>`
            : v.status === "in_progress" ? `<button type="button" class="btn btn--primary btn--sm" data-open>Continue visit</button>`
            : `<button type="button" class="btn btn--primary btn--sm" data-begin>Start visit</button>`}
          ${v.area ? `<a class="btn btn--ghost btn--sm" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.area)}">Map</a>` : ""}
        </div>
      </li>`;
    }).join("");
  }

  $("techVisits").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-visit]");
    if (!li) return;
    const v = visits.find((x) => x.ticket_id === li.dataset.visit);
    if (e.target.closest("[data-begin]")) {
      window.Schedule.openSafety(`${v.ticket_number} · ${v.client_name}`, async (safety) => {
        const { error } = await sb.rpc("start_service_visit", { p_ticket_id: v.ticket_id, p_safety: safety });
        if (error) throw error;
        toast("Visit started");
        await home();
        openVisit(visits.find((x) => x.ticket_id === v.ticket_id));
      });
    }
    if (e.target.closest("[data-open]")) openVisit(v);
  });

  // ---------- Visit form ----------
  let visit = null;
  let photos = [];
  let used = []; // [{ product_id, qty }]
  const pad = window.Schedule.makePad($("svcSignature"));

  async function openVisit(v) {
    visit = v;
    photos = Array.isArray(v.photos) ? [...v.photos] : [];
    used = [];
    if (!parts.length) parts = (await sb.rpc("service_parts")).data || [];
    const f = $("svcForm");
    f.reset();
    const checkup = v.kind === "checkup";
    $("svcTitle").textContent = `${checkup ? "Checkup" : "Service visit"} · ${v.client_name}`;
    $("svcMeta").textContent = `${v.ticket_number} · Client ID ${v.client_code || "—"} · ${v.system_size_kw ?? "?"} kW · started ${fmtDateTime(v.started_at)}`;
    $("svcProblem").innerHTML = `
      ${checkup ? `<p>Free pre-monsoon checkup: tick every item as you go.</p>` : `<p><b>${esc(window.Service?.CATEGORY[v.category] || v.category)}</b>${v.description ? `: ${esc(v.description)}` : ""}</p>`}
      <p class="m-meta">${esc(v.warranty_note || "")}</p>
      ${v.serials?.length ? `<details><summary>Equipment serial numbers (${v.serials.length})</summary><ul class="tech-items">${v.serials.map((s) =>
        `<li><span>${esc(s.description)}</span><b>${esc(s.serial_no)}</b></li>`).join("")}</ul></details>` : ""}
      <div class="photos" id="svcCustomerPhotos"></div>`;
    $("svcChecklistBlock").hidden = !checkup;
    $("svcChecklist").innerHTML = CHECKUP.map(([k, label]) => `<label class="check"><input type="checkbox" name="ck_${k}" ${v.checklist?.[k] ? "checked" : ""}> ${esc(label)}</label>`).join("");
    $("svcFixBlock").hidden = checkup;
    f.cause.value = v.cause || "";
    f.work_done.value = v.work_done || "";
    f.generation_kwh.value = v.generation_kwh ?? "";
    $("svcError").textContent = "";
    renderParts();
    $("svcModal").hidden = false;
    pad.clear();
    renderPhotos();
    if (v.customer_photos?.length) {
      const { data } = await sb.storage.from("service-photos").createSignedUrls(v.customer_photos, 3600);
      $("svcCustomerPhotos").innerHTML = (data || []).map((p) => `<figure><a href="${esc(p.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(p.signedUrl)}" alt="Customer's photo"></a><figcaption>From customer</figcaption></figure>`).join("");
    }
  }

  // ---------- Parts used (taken out of stock on completion) ----------
  function renderParts() {
    const opts = (sel) => parts.map((p) => `<option value="${p.product_id}"${p.product_id === sel ? " selected" : ""}>${esc(p.name)} (${esc(p.available)} ${esc(p.unit)} in stock)</option>`).join("");
    $("svcParts").innerHTML = used.map((u, i) => `<div class="part-row" data-i="${i}">
        <select data-k="product_id">${opts(u.product_id)}</select>
        <input type="number" data-k="qty" min="0" step="any" value="${esc(u.qty)}" aria-label="Quantity">
        <button type="button" class="icon-btn" data-rm aria-label="Remove">✕</button>
      </div>`).join("") || `<p class="muted">No parts used.</p>`;
  }
  $("svcAddPart").addEventListener("click", () => {
    if (!parts.length) return toast("No parts in stock.");
    used.push({ product_id: parts[0].product_id, qty: 1 });
    renderParts();
  });
  $("svcParts").addEventListener("change", (e) => {
    const row = e.target.closest("[data-i]");
    if (!row) return;
    const u = used[Number(row.dataset.i)];
    u[e.target.dataset.k] = e.target.dataset.k === "qty" ? Number(e.target.value) || 0 : e.target.value;
  });
  $("svcParts").addEventListener("click", (e) => {
    const row = e.target.closest("[data-i]");
    if (!row || !e.target.closest("[data-rm]")) return;
    used.splice(Number(row.dataset.i), 1);
    renderParts();
  });

  // ---------- Before / after photos ----------
  async function renderPhotos() {
    const { data } = photos.length ? await sb.storage.from("service-photos").createSignedUrls(photos, 3600) : { data: [] };
    const url = Object.fromEntries((data || []).map((p) => [p.path, p.signedUrl]));
    $("svcSlots").innerHTML = PHOTO_SLOTS.map(([slot, label, req]) => {
      const mine = photos.map((p, i) => [p, i]).filter(([p]) => slotOf(p) === slot);
      return `<div class="photo-slot${mine.length ? " is-done" : req ? " is-missing" : ""}">
        <div class="photo-slot__head"><b>${esc(label)}</b>${req ? "" : ` <small>(optional)</small>`}${mine.length ? ` <span class="ok">✓</span>` : ""}</div>
        <div class="photos">${mine.map(([p, i]) => `<figure>
            <a href="${esc(url[p] || "#")}" target="_blank" rel="noopener"><img src="${esc(url[p] || "")}" alt="${esc(label)} photo" loading="lazy"></a>
            <button type="button" class="icon-btn" data-remove-photo="${i}" aria-label="Remove photo">✕</button>
          </figure>`).join("")}
          <label class="photo-tile" title="Add a photo">＋<input type="file" accept="image/*" capture="environment" multiple hidden data-slot="${slot}"></label>
        </div>
      </div>`;
    }).join("");
  }

  function readVisit() {
    const f = $("svcForm");
    const g = f.generation_kwh.value.trim();
    return {
      p_ticket_id: visit.ticket_id,
      p_cause: f.cause.value.trim() || null,
      p_work_done: f.work_done.value.trim() || null,
      p_checklist: Object.fromEntries(CHECKUP.map(([k]) => [k, f[`ck_${k}`].checked])),
      p_photos: photos,
      p_generation_kwh: g === "" ? null : Number(g),
    };
  }

  $("svcSlots").addEventListener("change", async (e) => {
    const input = e.target.closest("input[data-slot]");
    if (!input || !visit) return;
    const files = [...input.files];
    const slot = input.dataset.slot;
    input.value = "";
    if (!files.length) return;
    input.closest(".photo-slot").classList.add("is-busy");
    for (const file of files) {
      try {
        const blob = await window.Surveys.compress(file);
        const path = `${visit.ticket_id}/${slot}-${crypto.randomUUID()}.jpg`;
        const { error } = await sb.storage.from("service-photos").upload(path, blob, { contentType: "image/jpeg" });
        if (error) throw error;
        photos.push(path);
      } catch (err) {
        toast("Photo upload failed: " + (err.message || err));
      }
    }
    await sb.rpc("save_service_visit", readVisit()); // keep the photos even if the phone loses signal later
    renderPhotos();
  });
  $("svcSlots").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-remove-photo]");
    if (!b) return;
    const [path] = photos.splice(Number(b.dataset.removePhoto), 1);
    await sb.storage.from("service-photos").remove([path]);
    await sb.rpc("save_service_visit", readVisit());
    renderPhotos();
  });

  $("svcClearSig").addEventListener("click", () => pad.clear());

  $("svcForm").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-svc]");
    if (!b || !visit) return;
    $("svcError").textContent = "";
    b.disabled = true;
    try {
      if (b.dataset.svc === "save") {
        const { error } = await sb.rpc("save_service_visit", readVisit());
        if (error) throw error;
        toast("Progress saved");
      } else {
        const name = $("svcForm").signed_by.value.trim();
        if (!name) throw new Error("Type the customer's name.");
        if (!pad.signed()) throw new Error("Ask the customer to sign in the box.");
        const path = `${visit.ticket_id}/signature.png`;
        const { error: upError } = await sb.storage.from("service-photos").upload(path, await pad.blob(), { contentType: "image/png", upsert: true });
        if (upError) throw upError;
        const { error } = await sb.rpc("complete_service_visit", {
          ...readVisit(), p_parts: used.filter((u) => u.qty > 0), p_signed_by: name, p_signature_path: path,
        });
        if (error) throw error;
        $("svcModal").hidden = true;
        toast("Visit completed. The customer gets a WhatsApp now.");
      }
      await home();
    } catch (err) {
      $("svcError").textContent = err.message || String(err);
    } finally {
      b.disabled = false;
    }
  });
  document.querySelectorAll("[data-close-svc]").forEach((el) => el.addEventListener("click", () => ($("svcModal").hidden = true)));

  window.Visits = { home };
})();
