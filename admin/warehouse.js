// Warehouse: packing lists → serial numbers → dispatch, plus stock levels. No prices and no phone numbers here.
(() => {
  const { sb, esc, toast, fmtDay, fmtDateTime, registerView, viewOpen, loadTiles, state } = window.CRM;
  const $ = (id) => document.getElementById(id);

  let tab = "pack";
  let lists = [];
  let stock = [];
  let focusItem = null; // keep the cursor in the serial box between scans

  async function load() {
    const [{ data, error }, { data: s, error: stockError }] = await Promise.all([sb.rpc("packing_lists"), sb.rpc("warehouse_stock")]);
    if (error || stockError) {
      $("whBody").innerHTML = `<p class="empty">The warehouse isn't set up yet (run orders.sql and installation.sql). ${esc((error || stockError).message)}</p>`;
      return;
    }
    lists = data || [];
    stock = s || [];
    render();
  }

  const packedCount = (o) => o.items.filter((i) => Number(i.packed_qty) >= Number(i.qty)).length;
  const serialsNeeded = (o) => o.items.filter((i) => i.serial_tracked).reduce((a, i) => a + Math.ceil(Number(i.qty)), 0);
  const serialsDone = (o) => o.items.filter((i) => i.serial_tracked).reduce((a, i) => a + Math.min(i.serials.length, Math.ceil(Number(i.qty))), 0);

  function render() {
    const toPack = lists.filter((o) => ["confirmed", "packing"].includes(o.status));
    const ready = lists.filter((o) => o.status === "packed");
    const gone = lists.filter((o) => o.status === "dispatched");
    const low = stock.filter((p) => p.is_low);
    $("whTabs").innerHTML = [
      ["pack", "To pack", toPack.length, toPack.some((o) => o.stock_short)],
      ["ready", "Ready to dispatch", ready.length, false],
      ["dispatched", "Dispatched", gone.length, false],
      ["low", "Low stock", low.length, low.length > 0],
    ].map(([k, label, n, alert]) => `<button type="button" data-tab="${k}" class="${tab === k ? "is-active" : ""}">${label} <em class="${alert ? "alert" : ""}">${n}</em></button>`).join("");
    if (state.role === "warehouse") {
      // The warehouse login doesn't load the Leads screen, so keep its own nav badge up to date
      const el = document.querySelector('.topnav [data-view="warehouse"] .count');
      el.textContent = toPack.length + ready.length;
      el.hidden = !(toPack.length + ready.length);
      el.classList.toggle("count--alert", toPack.some((o) => o.stock_short));
    }

    if (tab === "low") return renderStock();
    const list = { pack: toPack, ready, dispatched: gone }[tab];
    const empty = {
      pack: "Nothing to pack. Confirmed orders appear here automatically.",
      ready: "Nothing waiting for dispatch.",
      dispatched: "Nothing dispatched in the last 14 days.",
    }[tab];
    $("whBody").innerHTML = list.length ? `<div class="pack-grid">${list.map(card).join("")}</div>` : `<p class="empty">${empty}</p>`;
    if (focusItem) document.querySelector(`[data-serial-input="${focusItem}"]`)?.focus();
  }

  function serialBox(o, i) {
    if (!i.serial_tracked) return "";
    const need = Math.ceil(Number(i.qty));
    const open = o.status !== "dispatched";
    const chips = i.serials.map((s) => `<span class="serial">${esc(s.serial_no)}${open ? `<button type="button" data-remove-serial="${s.id}" aria-label="Remove ${esc(s.serial_no)}">✕</button>` : ""}</span>`).join("");
    const more = need - i.serials.length;
    return `<div class="serials">
      <span class="serials__label${more > 0 ? " overdue" : ""}">Serial no. ${i.serials.length} / ${need}</span>${chips}
      ${open && more > 0 ? `<span class="serial-add">
        <input data-serial-input="${i.id}" placeholder="Scan or type serial, then Enter" autocomplete="off" autocapitalize="characters">
        ${window.Scanner.available ? `<button type="button" class="btn btn--ghost btn--sm" data-camera="${i.id}" title="Scan with the camera">📷</button>` : ""}
      </span>` : ""}
    </div>`;
  }

  function card(o) {
    const packing = ["confirmed", "packing"].includes(o.status);
    const done = packedCount(o);
    const need = serialsNeeded(o);
    const got = serialsDone(o);
    let foot;
    if (packing) {
      foot = `<span class="m-meta" data-progress>${done} / ${o.items.length} lines packed</span>
        <div class="m-actions">
          <button type="button" class="btn btn--ghost btn--sm" data-slip>Packing slip (PDF)</button>
          <button type="button" class="btn btn--primary btn--sm" data-all>Mark all packed</button>
        </div>`;
    } else if (o.status === "packed") {
      foot = `<div class="dispatch-form">
          <input data-vehicle placeholder="Vehicle no (e.g. TS09AB1234)" autocomplete="off">
          <input data-driver placeholder="Driver name" autocomplete="off">
        </div>
        <div class="m-actions">
          <button type="button" class="btn btn--ghost btn--sm" data-slip>Packing slip (PDF)</button>
          <button type="button" class="btn btn--primary btn--sm" data-dispatch ${got < need ? `disabled title="Scan ${need - got} more serial number(s) first"` : ""}>Dispatch</button>
        </div>
        ${got < need ? `<p class="stock-tag">Scan ${need - got} more serial number(s) to dispatch.</p>` : ""}`;
    } else {
      foot = `<span class="m-meta">Dispatched ${esc(fmtDateTime(o.dispatched_at))}${o.dispatch_vehicle ? ` · ${esc(o.dispatch_vehicle)}` : ""}${o.dispatch_driver ? ` · ${esc(o.dispatch_driver)}` : ""}</span>
        <div class="m-actions"><button type="button" class="btn btn--ghost btn--sm" data-slip>Delivery note (PDF)</button></div>`;
    }
    return `<article class="pack-card${o.stock_short && packing ? " is-short" : ""}" data-order="${o.order_id}">
      <header class="pack-head">
        <div>
          <b>${esc(o.order_number)}</b> <span class="code">${esc(o.client_code || "—")}</span>
          ${o.stock_short && packing ? `<span class="badge s-short">Stock short</span>` : ""}
          ${need ? `<span class="badge ${got >= need ? "o-installed" : "o-wait"}">Serials ${got}/${need}</span>` : ""}
        </div>
        <div class="m-meta">${o.install_date ? `Install ${esc(fmtDay(o.install_date))} · ${esc(o.time_slot || "")} · ${esc(o.crew_name || "no crew")}` : "Installation not scheduled yet"}</div>
      </header>
      <table class="pack-items">
        <thead><tr><th></th><th>Item</th><th class="right">Qty</th><th class="right">Packed</th></tr></thead>
        <tbody>${o.items.map((i) => {
          const ok = Number(i.packed_qty) >= Number(i.qty);
          const short = Number(i.reserved_qty) < Number(i.qty);
          return `<tr data-item="${i.id}" class="${ok ? "is-done" : ""}">
            <td><input type="checkbox" data-tick ${ok ? "checked" : ""} ${packing ? "" : "disabled"} aria-label="Packed"></td>
            <td>${esc(i.description)}<small class="bom-sku">${esc(i.sku || "")}</small>${short && packing ? `<small class="stock-tag">only ${esc(i.reserved_qty)} reserved</small>` : ""}${serialBox(o, i)}</td>
            <td class="right">${esc(i.qty)} ${esc(i.unit || "")}</td>
            <td class="right"><input type="number" data-qty min="0" max="${esc(i.qty)}" step="any" value="${esc(i.packed_qty)}" ${packing ? "" : "disabled"} aria-label="Packed quantity"></td>
          </tr>`;
        }).join("")}</tbody>
      </table>
      <footer class="pack-foot">${foot}</footer>
    </article>`;
  }

  function renderStock() {
    if (!stock.length) return ($("whBody").innerHTML = `<p class="empty">No stocked products yet.</p>`);
    $("whBody").innerHTML = `<div class="table-wrap"><table class="table table--plain">
      <thead><tr><th>Item</th><th class="right">In stock</th><th class="right">Reserved</th><th class="right">Available</th><th class="right">Low level</th></tr></thead>
      <tbody>${stock.map((p) => `<tr class="${p.is_low ? "is-low" : ""}">
        <td><span class="name">${esc(p.name)}</span><span class="code">${esc(p.sku)}</span>${p.is_low ? ` <span class="badge s-short">Low</span>` : ""}</td>
        <td class="right">${esc(p.stock_qty)} ${esc(p.unit)}</td>
        <td class="right">${esc(p.reserved_qty)}</td>
        <td class="right"><b>${esc(p.available)}</b></td>
        <td class="right">${esc(p.low_stock_level)}</td>
      </tr>`).join("")}</tbody></table></div>`;
  }

  $("whTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    focusItem = null;
    render();
  });
  $("whRefresh").addEventListener("click", async () => { await load(); toast("Warehouse refreshed"); });

  // ---------- Packing ----------
  // Tick or type the packed quantity: saved straight away
  async function setPacked(row, qty) {
    const o = lists.find((x) => x.order_id === row.closest("[data-order]").dataset.order);
    const item = o?.items.find((i) => i.id === row.dataset.item);
    if (!item) return;
    const { data, error } = await sb.rpc("set_packed", { p_order_item_id: item.id, p_qty: qty });
    if (error) {
      toast("Couldn't save: " + error.message);
      return render();
    }
    item.packed_qty = data;
    const ok = Number(data) >= Number(item.qty);
    row.classList.toggle("is-done", ok);
    row.querySelector("[data-tick]").checked = ok;
    row.querySelector("[data-qty]").value = data;
    row.closest(".pack-card").querySelector("[data-progress]").textContent = `${packedCount(o)} / ${o.items.length} lines packed`;
  }

  $("whBody").addEventListener("change", (e) => {
    const row = e.target.closest("tr[data-item]");
    if (!row) return;
    const item = lists.flatMap((o) => o.items).find((i) => i.id === row.dataset.item);
    if (e.target.matches("[data-tick]")) setPacked(row, e.target.checked ? Number(item.qty) : 0);
    if (e.target.matches("[data-qty]")) setPacked(row, Math.max(0, Math.min(Number(item.qty), Number(e.target.value) || 0)));
  });

  // ---------- Serial numbers (a USB / Bluetooth scanner types the number and presses Enter) ----------
  async function addSerial(itemId, value) {
    const serial = value.trim();
    if (!serial) return false;
    const { error } = await sb.rpc("add_serial", { p_order_item_id: itemId, p_serial: serial });
    if (error) {
      toast(error.message);
      return false;
    }
    toast(`Serial ${serial.toUpperCase()} added`);
    focusItem = itemId;
    await load();
    return true;
  }

  $("whBody").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches("[data-serial-input]")) return;
    e.preventDefault();
    addSerial(e.target.dataset.serialInput, e.target.value);
  });

  $("whBody").addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-remove-serial]");
    if (rm) {
      const { error } = await sb.rpc("remove_serial", { p_serial_id: rm.dataset.removeSerial });
      if (error) return toast(error.message);
      return load();
    }
    const cam = e.target.closest("[data-camera]");
    if (cam) return openScanner(cam.dataset.camera);

    const cardEl = e.target.closest("[data-order]");
    if (!cardEl) return;
    const o = lists.find((x) => x.order_id === cardEl.dataset.order);
    if (e.target.closest("[data-slip]")) {
      await window.Quotes.loadSettings(); // business details for the header
      return packingSlip(o).save(`${o.order_number}-${o.status === "dispatched" ? "delivery-note" : "packing-slip"}.pdf`);
    }

    const all = e.target.closest("[data-all]");
    if (all) {
      if (!confirm(`Everything for ${o.order_number} is packed and checked?`)) return;
      all.disabled = true;
      const { error } = await sb.rpc("mark_order_packed", { p_order_id: o.order_id });
      if (error) {
        all.disabled = false;
        return toast("Couldn't mark it packed: " + error.message);
      }
      toast(`${o.order_number} packed. Scan the serial numbers and dispatch it from "Ready to dispatch".`);
      tab = "ready";
      await load();
      if (state.role !== "warehouse") loadTiles();
      return;
    }

    const go = e.target.closest("[data-dispatch]");
    if (go) {
      const vehicle = cardEl.querySelector("[data-vehicle]").value.trim();
      const driver = cardEl.querySelector("[data-driver]").value.trim();
      if (!vehicle && !confirm("No vehicle number entered. Dispatch anyway?")) return;
      if (!confirm(`Dispatch ${o.order_number}? The goods leave the warehouse and the stock goes down.`)) return;
      go.disabled = true;
      const { error } = await sb.rpc("dispatch_order", { p_order_id: o.order_id, p_vehicle: vehicle || null, p_driver: driver || null });
      if (error) {
        go.disabled = false;
        return toast("Couldn't dispatch: " + error.message);
      }
      toast(`${o.order_number} dispatched. The crew can now start the installation.`);
      tab = "dispatched";
      await load();
      if (state.role !== "warehouse") loadTiles();
    }
  });

  // ---------- Camera scanning (scanner.js) ----------
  async function openScanner(itemId) {
    const item = lists.flatMap((o) => o.items).find((i) => i.id === itemId);
    const code = await window.Scanner.scan(`Scan serial: ${item?.description || ""}`);
    if (code) await addSerial(itemId, code);
  }

  // ---------- Packing slip / delivery note (printable) ----------
  function packingSlip(o) {
    const P = window.Quotes.pdf;
    const { W, M, orange, navy, muted } = P;
    const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    const delivered = o.status === "dispatched";
    P.header(doc);
    let y = 46;
    doc.setTextColor(...navy).setFont("helvetica", "bold").setFontSize(20).text(delivered ? "DELIVERY NOTE" : "PACKING SLIP", M, y);
    doc.setFontSize(9).setFont("helvetica", "normal").setTextColor(...muted);
    doc.text(`Order no: ${o.order_number}`, W - M, y - 7, { align: "right" });
    doc.text(`Client ID: ${o.client_code || "-"}`, W - M, y - 2.5, { align: "right" });
    doc.text(`Printed: ${P.date(new Date())}`, W - M, y + 2, { align: "right" });

    y += 8;
    doc.setDrawColor(230, 225, 218).setFillColor(248, 246, 242);
    doc.roundedRect(M, y, W - 2 * M, delivered ? 20 : 14, 2, 2, "FD");
    doc.setTextColor(...orange).setFont("helvetica", "bold").setFontSize(8).text("INSTALLATION", M + 5, y + 5.5);
    doc.setTextColor(...navy).setFontSize(10).text(o.install_date
      ? `${P.date(o.install_date + "T00:00:00")}  ·  ${o.time_slot || ""}  ·  ${o.crew_name || "Crew to be confirmed"}`
      : "Not scheduled yet", M + 5, y + 10.5);
    if (delivered) {
      doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(60, 60, 60).text(
        `Dispatched ${new Date(o.dispatched_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}${o.dispatch_vehicle ? `  ·  Vehicle ${o.dispatch_vehicle}` : ""}${o.dispatch_driver ? `  ·  Driver ${o.dispatch_driver}` : ""}`,
        M + 5, y + 16);
    }

    doc.autoTable({
      startY: y + (delivered ? 26 : 20), margin: { left: M, right: M },
      head: [["#", "Item", "SKU", "Qty", "Serial numbers", "Packed", "Checked"]],
      body: o.items.map((i, n) => [n + 1, i.description, i.sku || "", `${i.qty} ${i.unit || ""}`.trim(), i.serials.map((s) => s.serial_no).join("\n"), "", ""]),
      theme: "grid",
      styles: { font: "helvetica", fontSize: 9, cellPadding: 2.6, lineColor: [230, 225, 218], minCellHeight: 9 },
      headStyles: { fillColor: navy, textColor: 255 },
      columnStyles: { 0: { cellWidth: 9, halign: "center" }, 2: { cellWidth: 25 }, 3: { cellWidth: 17, halign: "right" }, 4: { cellWidth: 34 }, 5: { cellWidth: 17 }, 6: { cellWidth: 19 } },
      didDrawCell: (d) => {
        // Empty tick boxes for the packer and the checker
        if (d.section === "body" && (d.column.index === 5 || d.column.index === 6)) {
          doc.setDrawColor(...navy).rect(d.cell.x + d.cell.width / 2 - 2.5, d.cell.y + d.cell.height / 2 - 2.5, 5, 5);
        }
      },
    });

    let sy = Math.max(doc.lastAutoTable.finalY + 22, 240);
    if (sy > 270) { doc.addPage(); sy = 40; }
    doc.setDrawColor(...muted);
    (delivered ? [["Delivered by", M], ["Received by (crew)", W / 2 + 4]] : [["Packed by", M], ["Checked by", W / 2 + 4]]).forEach(([label, x]) => {
      doc.line(x, sy, x + 70, sy);
      doc.setFontSize(8.5).setTextColor(...muted).text(`${label} (name, signature, date)`, x, sy + 5);
    });
    P.footer(doc);
    return doc;
  }

  registerView("warehouse", load);

  // New confirmed orders appear without a reload (skipped while someone is typing or scanning)
  setInterval(() => {
    if (viewOpen("warehouse") && $("scanModal").hidden && !document.activeElement?.matches?.("#whBody input")) load();
  }, 30000);
})();
