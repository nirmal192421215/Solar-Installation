// Products catalogue (prices, stock, movements) and kit templates (the parts list behind every final quote)
(() => {
  const { sb, state, esc, toast, fmtDateTime, registerView, viewOpen, isLowStock, loadTiles } = window.CRM;
  const $ = (id) => document.getElementById(id);

  const CATEGORIES = {
    panel: "Solar panel", inverter: "Inverter", battery: "Battery", charge_controller: "Charge controller",
    structure: "Structure", dc_cable: "DC cable", ac_cable: "AC cable", acdb_dcdb: "ACDB / DCDB", earthing: "Earthing",
    lightning_arrestor: "Lightning arrestor", connector: "Connector", service: "Service", other: "Other",
  };
  const UNITS = { pcs: "pcs", m: "metre", set: "set", kw: "per kW", job: "job" };
  const MOVES = { purchase: "Purchase", adjustment: "Adjustment", reserve: "Reserved", unreserve: "Unreserved", dispatch: "Dispatched", return: "Returned" };
  const QTY_MODES = {
    fixed: "Fixed", per_kw: "Per kW", per_panel: "Per panel",
    from_survey_dc_cable: "DC cable from survey (m)", from_survey_ac_cable: "AC cable from survey (m)",
  };
  const SYSTEM_TYPES = { on_grid: "On-grid", off_grid: "Off-grid", hybrid: "Hybrid" };

  const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
  const available = (p) => Number(p.stock_qty) - Number(p.reserved_qty);
  const options = (map, selected) => Object.entries(map).map(([k, v]) => `<option value="${k}"${k === selected ? " selected" : ""}>${esc(v)}</option>`).join("");

  let products = [];
  let search = "";
  let category = "";
  let lowOnly = false;

  // ---------- Products screen ----------
  async function loadProducts() {
    const { data, error } = await sb.from("products").select("*").order("category").order("name");
    if (error) {
      $("productRows").innerHTML = "";
      $("productsEmpty").hidden = false;
      $("productsEmpty").textContent = "Products aren't set up yet (run orders.sql).";
      return false;
    }
    products = data;
    return true;
  }

  function renderProducts() {
    const q = search.toLowerCase();
    const rows = products.filter((p) => (!q || [p.name, p.sku].some((v) => v.toLowerCase().includes(q)))
      && (!category || p.category === category) && (!lowOnly || (!p.is_service && isLowStock(p))));
    const low = products.filter((p) => p.active && !p.is_service && isLowStock(p)).length;
    $("productsSub").textContent = `${products.length} products${low ? ` · ${low} low on stock` : ""}`;
    $("productsEmpty").hidden = rows.length > 0;
    $("productsEmpty").textContent = "No products match these filters.";
    $("productRows").innerHTML = rows.map((p) => {
      const isLow = !p.is_service && isLowStock(p);
      return `<tr data-id="${p.id}" class="${p.active ? "" : "is-inactive"}">
        <td><span class="name">${esc(p.name)}</span><span class="code">${esc(p.sku)}</span>${p.active ? "" : ` <span class="badge">inactive</span>`}<span class="sub">${esc(CATEGORIES[p.category])}${p.warranty_months ? ` · ${esc(p.warranty_months / 12)} yr warranty` : ""}${p.serial_tracked ? " · serial no." : ""}</span></td>
        <td class="right">${esc(inr(p.sell_price))}<span class="sub">cost ${esc(inr(p.cost_price))} · GST ${esc(p.gst_percent)}%</span></td>
        ${p.is_service
          ? `<td class="right" colspan="3"><span class="sub none">service, not stocked</span></td>`
          : `<td class="right">${esc(p.stock_qty)} <small class="muted">${esc(p.unit)}</small></td>
             <td class="right">${esc(p.reserved_qty)}</td>
             <td class="right"><b>${esc(available(p))}</b>${isLow ? ` <span class="badge s-short">Low</span>` : ""}<span class="sub">low at ${esc(p.low_stock_level)}</span></td>`}
        <td class="right actions">${p.is_service ? "" : `<button type="button" class="btn btn--ghost btn--sm" data-stock="purchase">+ Stock</button>
          <button type="button" class="btn btn--ghost btn--sm" data-stock="adjustment">Adjust</button>`}</td>
      </tr>`;
    }).join("");
  }

  $("productSearch").addEventListener("input", (e) => { search = e.target.value.trim(); renderProducts(); });
  $("productCategory").innerHTML = `<option value="">All categories</option>${options(CATEGORIES)}`;
  $("productCategory").addEventListener("change", (e) => { category = e.target.value; renderProducts(); });
  $("productLow").addEventListener("change", (e) => { lowOnly = e.target.checked; renderProducts(); });
  $("productRows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const p = products.find((x) => x.id === tr.dataset.id);
    const stockBtn = e.target.closest("button[data-stock]");
    if (stockBtn) return openStock(p, stockBtn.dataset.stock);
    openProduct(p);
  });
  $("addProductBtn").addEventListener("click", () => openProduct(null));

  registerView("products", async () => {
    if (state.viewFilter?.products === "low") {
      lowOnly = true;
      $("productLow").checked = true;
      state.viewFilter = null;
    }
    if (await loadProducts()) renderProducts();
    window.Purchases?.loadRecent();
  });

  // ---------- Add / edit a product ----------
  let editingProduct = null;
  const PRODUCT_FIELDS = ["sku", "name", "category", "unit", "cost_price", "sell_price", "gst_percent", "low_stock_level", "warranty_months", "hsn_code"];
  const NUMERIC = new Set(["cost_price", "sell_price", "gst_percent", "low_stock_level", "warranty_months"]);

  function openProduct(p) {
    editingProduct = p;
    const f = $("productForm");
    f.reset();
    f.category.innerHTML = options(CATEGORIES, p?.category || "panel");
    f.unit.innerHTML = options(UNITS, p?.unit || "pcs");
    $("productTitle").textContent = p ? p.name : "Add a product";
    PRODUCT_FIELDS.forEach((k) => { if (p) f[k].value = p[k] ?? ""; });
    if (!p) f.gst_percent.value = 12;
    f.serial_tracked.checked = Boolean(p?.serial_tracked);
    f.is_service.checked = Boolean(p?.is_service);
    f.active.checked = p ? p.active : true;
    f.opening_stock.closest("label").hidden = Boolean(p);
    $("productHistory").hidden = !p || p.is_service;
    $("productError").textContent = "";
    $("productModal").hidden = false;
    if (p && !p.is_service) loadHistory(p, $("productMoves"));
  }

  // Services (installation, net metering) are charged at 18% and never stocked
  $("productForm").category.addEventListener("change", (e) => {
    const f = $("productForm");
    if (e.target.value === "service") {
      f.is_service.checked = true;
      f.gst_percent.value = 18;
    }
    if (["inverter", "battery", "charge_controller"].includes(e.target.value)) f.serial_tracked.checked = true;
  });

  $("productForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const row = {};
    PRODUCT_FIELDS.forEach((k) => {
      const v = f[k].value.trim();
      row[k] = v === "" ? null : NUMERIC.has(k) ? Number(v) : v;
    });
    row.sku = row.sku?.toUpperCase();
    ["cost_price", "sell_price", "low_stock_level"].forEach((k) => (row[k] = row[k] ?? 0));
    row.gst_percent = row.gst_percent ?? 12;
    row.serial_tracked = f.serial_tracked.checked;
    row.is_service = f.is_service.checked;
    row.active = f.active.checked;
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      if (editingProduct) {
        const { error } = await sb.from("products").update(row).eq("id", editingProduct.id);
        if (error) throw error;
      } else {
        const { data, error } = await sb.from("products").insert(row).select().single();
        if (error) throw error;
        const opening = Number(f.opening_stock.value) || 0;
        if (opening > 0 && !row.is_service) {
          const { error: moveError } = await sb.rpc("move_stock", { p_product_id: data.id, p_qty: opening, p_type: "purchase", p_note: "Opening stock" });
          if (moveError) throw moveError;
        }
      }
      $("productModal").hidden = true;
      toast(editingProduct ? "Product saved" : "Product added");
      await loadProducts();
      renderProducts();
      loadTiles();
    } catch (err) {
      $("productError").textContent = /duplicate key|products_sku_key/i.test(err.message) ? `SKU ${row.sku} is already used.` : err.message;
    } finally {
      btn.disabled = false;
    }
  });
  document.querySelectorAll("[data-close-product]").forEach((el) => el.addEventListener("click", () => ($("productModal").hidden = true)));

  // ---------- Stock in / adjust (always through move_stock) ----------
  let stockProduct = null;

  function openStock(p, type) {
    stockProduct = p;
    const f = $("stockForm");
    f.reset();
    f.type.value = type;
    $("stockTitle").textContent = `${type === "purchase" ? "Add stock" : "Adjust stock"} · ${p.name}`;
    $("stockMeta").textContent = `In stock ${p.stock_qty} ${p.unit} · reserved ${p.reserved_qty} · available ${available(p)}`;
    syncStockForm();
    $("stockError").textContent = "";
    $("stockModal").hidden = false;
    loadHistory(p, $("stockMoves"));
  }

  function syncStockForm() {
    const f = $("stockForm");
    const adjust = f.type.value === "adjustment";
    f.qty.min = adjust ? "" : "0.01";
    $("stockQtyLabel").textContent = adjust ? "Change (+ found / − damaged or lost)" : `Quantity received (${stockProduct.unit})`;
    f.note.placeholder = adjust ? "Why? e.g. stock count, 2 damaged in transit (required)" : "Supplier / invoice no (optional)";
    f.note.required = adjust;
  }
  $("stockForm").type.addEventListener("change", syncStockForm);

  $("stockForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const qty = Number(f.qty.value);
    if (!qty || (f.type.value === "purchase" && qty < 0)) return ($("stockError").textContent = "Enter a quantity.");
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    const { data, error } = await sb.rpc("move_stock", {
      p_product_id: stockProduct.id, p_qty: qty, p_type: f.type.value, p_note: f.note.value.trim() || null,
    });
    btn.disabled = false;
    if (error) return ($("stockError").textContent = error.message);
    $("stockModal").hidden = true;
    toast(`Stock updated: ${data} ${stockProduct.unit} available`);
    await loadProducts();
    renderProducts();
    loadTiles();
  });
  document.querySelectorAll("[data-close-stock]").forEach((el) => el.addEventListener("click", () => ($("stockModal").hidden = true)));

  async function loadHistory(p, el) {
    el.innerHTML = `<li class="m-empty">Loading…</li>`;
    const { data, error } = await sb.from("stock_movements").select("*").eq("product_id", p.id).order("created_at", { ascending: false }).limit(50);
    if (error) return (el.innerHTML = `<li class="m-empty">Couldn't load the history.</li>`);
    el.innerHTML = data.length
      ? data.map((m) => `<li>
          <span class="mv-qty ${m.qty < 0 ? "out" : "in"}">${m.qty > 0 ? "+" : ""}${esc(m.qty)}</span>
          <span><b>${esc(MOVES[m.type] || m.type)}</b>${m.note ? ` · ${esc(m.note)}` : ""}<small>${esc(fmtDateTime(m.created_at))} · ${esc(m.created_by || "")}</small></span>
        </li>`).join("")
      : `<li class="m-empty">No stock movements yet.</li>`;
  }

  // ---------- Kit templates ----------
  let templates = [];

  async function loadKits() {
    const [{ data, error }, ok] = await Promise.all([
      sb.from("kit_templates").select("*, kit_template_items(*)").order("system_type").order("size_kw"),
      products.length ? true : loadProducts(),
    ]);
    if (error || !ok) return ($("kitList").innerHTML = `<p class="empty">Kit templates aren't set up yet (run orders.sql).</p>`);
    templates = data;
    const byId = new Map(products.map((p) => [p.id, p]));
    $("kitList").innerHTML = templates.length
      ? templates.map((t) => {
          const items = [...t.kit_template_items].sort((a, b) => a.sort - b.sort);
          return `<button type="button" class="kit-card${t.active ? "" : " is-inactive"}" data-kit="${t.id}">
            <span class="kit-card__head"><b>${esc(t.name)}</b>${t.active ? "" : ` <span class="badge">inactive</span>`}</span>
            <span class="m-meta">${esc(SYSTEM_TYPES[t.system_type])} · ${esc(t.size_kw)} kW · ${items.length} items</span>
            <span class="kit-card__items">${items.slice(0, 5).map((i) => esc(byId.get(i.product_id)?.name || "?")).join(" · ")}${items.length > 5 ? " …" : ""}</span>
          </button>`;
        }).join("")
      : `<p class="empty">No kit templates yet.</p>`;
  }

  $("kitList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-kit]");
    if (b) openKit(templates.find((t) => t.id === b.dataset.kit));
  });
  $("addKitBtn").addEventListener("click", () => openKit(null));
  registerView("kits", loadKits);

  let editingKit = null;
  let kitRows = []; // [{ id?, product_id, qty_mode, qty }]

  function openKit(t) {
    editingKit = t;
    kitRows = t ? [...t.kit_template_items].sort((a, b) => a.sort - b.sort).map((i) => ({ ...i })) : [];
    const f = $("kitForm");
    f.reset();
    f.name.value = t?.name || "";
    f.system_type.innerHTML = options(SYSTEM_TYPES, t?.system_type || "on_grid");
    f.size_kw.value = t?.size_kw ?? "";
    f.active.checked = t ? t.active : true;
    f.notes.value = t?.notes || "";
    $("kitTitle").textContent = t ? t.name : "New kit template";
    $("kitError").textContent = "";
    renderKitRows();
    $("kitModal").hidden = false;
  }

  function renderKitRows() {
    const productOptions = (selected) => products.filter((p) => p.active || p.id === selected)
      .map((p) => `<option value="${p.id}"${p.id === selected ? " selected" : ""}>${esc(p.name)} (${esc(p.sku)})</option>`).join("");
    $("kitRows").innerHTML = kitRows.map((r, i) => `<tr data-i="${i}">
        <td><select data-k="product_id">${productOptions(r.product_id)}</select></td>
        <td><select data-k="qty_mode">${options(QTY_MODES, r.qty_mode)}</select></td>
        <td class="num"><input type="number" data-k="qty" min="0" step="any" value="${esc(r.qty)}" title="${r.qty_mode.startsWith("from_survey") ? "Used only if the survey has no cable length" : ""}"></td>
        <td class="kit-move">
          <button type="button" class="icon-btn" data-move="-1" aria-label="Move up">↑</button>
          <button type="button" class="icon-btn" data-move="1" aria-label="Move down">↓</button>
          <button type="button" class="icon-btn" data-remove aria-label="Remove">✕</button>
        </td>
      </tr>`).join("") || `<tr><td colspan="4" class="muted">No items yet.</td></tr>`;
  }

  $("kitRows").addEventListener("change", (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (!tr || !e.target.dataset.k) return;
    const r = kitRows[Number(tr.dataset.i)];
    r[e.target.dataset.k] = e.target.dataset.k === "qty" ? Number(e.target.value) || 0 : e.target.value;
    if (e.target.dataset.k === "qty_mode") renderKitRows();
  });
  $("kitRows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (!tr) return;
    const i = Number(tr.dataset.i);
    const move = e.target.closest("[data-move]");
    if (move) {
      const j = i + Number(move.dataset.move);
      if (j < 0 || j >= kitRows.length) return;
      [kitRows[i], kitRows[j]] = [kitRows[j], kitRows[i]];
    } else if (e.target.closest("[data-remove]")) {
      kitRows.splice(i, 1);
    } else return;
    renderKitRows();
  });
  $("kitAddItem").addEventListener("click", () => {
    const first = products.find((p) => p.active);
    if (!first) return toast("Add products first.");
    kitRows.push({ product_id: first.id, qty_mode: "fixed", qty: 1 });
    renderKitRows();
  });

  $("kitForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!kitRows.length) return ($("kitError").textContent = "Add at least one item.");
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const row = {
        name: f.name.value.trim(), system_type: f.system_type.value, size_kw: Number(f.size_kw.value),
        active: f.active.checked, notes: f.notes.value.trim() || null,
      };
      let id = editingKit?.id;
      if (id) {
        const { error } = await sb.from("kit_templates").update(row).eq("id", id);
        if (error) throw error;
      } else {
        const { data, error } = await sb.from("kit_templates").insert(row).select().single();
        if (error) throw error;
        id = data.id;
      }
      // Save the items: update kept rows, add new ones, then remove the ones taken out
      const items = kitRows.map((r, i) => ({ template_id: id, product_id: r.product_id, qty_mode: r.qty_mode, qty: Number(r.qty) || 0, sort: (i + 1) * 10 }));
      const added = items.filter((_, i) => !kitRows[i].id);
      const removed = (editingKit?.kit_template_items || []).map((i) => i.id).filter((x) => !kitRows.some((r) => r.id === x));
      for (const [i, r] of kitRows.entries()) {
        if (!r.id) continue;
        const { error } = await sb.from("kit_template_items").update(items[i]).eq("id", r.id);
        if (error) throw error;
      }
      if (added.length) {
        const { error } = await sb.from("kit_template_items").insert(added);
        if (error) throw error;
      }
      if (removed.length) {
        const { error } = await sb.from("kit_template_items").delete().in("id", removed);
        if (error) throw error;
      }
      $("kitModal").hidden = true;
      toast("Kit template saved");
      await loadKits();
    } catch (err) {
      $("kitError").textContent = /duplicate key|kit_templates_name_key/i.test(err.message) ? "A template with this name already exists." : err.message;
    } finally {
      btn.disabled = false;
    }
  });
  document.querySelectorAll("[data-close-kit]").forEach((el) => el.addEventListener("click", () => ($("kitModal").hidden = true)));

  // Stock changes made elsewhere (orders reserving stock) show up without a reload
  setInterval(async () => {
    if (viewOpen("products") && $("productModal").hidden && $("stockModal").hidden && (await loadProducts())) renderProducts();
  }, 30000);
})();
