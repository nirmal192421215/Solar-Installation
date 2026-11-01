// Stock purchases from suppliers: bill details, items at cost, GST. Stock goes up and each product's
// cost price becomes the weighted average (public.record_purchase), so job profit uses real costs.
(() => {
  const { sb, esc, toast, todayISO, fmtDay, registerView, loadTiles } = window.CRM;
  const $ = (id) => document.getElementById(id);
  const inr = (n) => "₹" + (Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

  let products = [];
  let lines = []; // [{ product_id, qty, unit_cost }]

  async function loadRecent() {
    const { data, error } = await sb.from("purchases").select("*").order("created_at", { ascending: false }).limit(12);
    if (error) return ($("purchaseList").innerHTML = ""); // extras.sql not run yet
    $("purchaseBlock").hidden = false;
    $("purchaseList").innerHTML = data.length ? `<div class="table-wrap"><table class="dtable">
      <thead><tr><th>Purchase</th><th>Supplier</th><th>Bill</th><th>Items</th><th class="right">Total</th></tr></thead>
      <tbody>${data.map((p) => `<tr>
        <td><b>${esc(p.purchase_number)}</b><span class="sub">${esc(fmtDay(p.bill_date))}</span></td>
        <td>${esc(p.supplier)}${p.supplier_gstin ? `<span class="sub">GSTIN ${esc(p.supplier_gstin)}</span>` : ""}</td>
        <td>${esc(p.bill_no || "—")}</td>
        <td>${p.lines.map((l) => `${esc(l.name)} × ${esc(l.qty)}`).join("<br>")}</td>
        <td class="right">${esc(inr(p.total))}<span class="sub">GST ${esc(inr(p.gst))}</span></td>
      </tr>`).join("")}</tbody></table></div>` : `<p class="muted">No purchases recorded yet.</p>`;
  }

  async function openPurchase() {
    const { data } = await sb.from("products").select("id, sku, name, unit, cost_price, stock_qty").eq("active", true).eq("is_service", false).order("category").order("name");
    products = data || [];
    lines = [{ product_id: products[0]?.id, qty: 1, unit_cost: Number(products[0]?.cost_price) || 0 }];
    const f = $("purchaseForm");
    f.reset();
    f.bill_date.value = todayISO();
    $("purchaseError").textContent = "";
    renderLines();
    $("purchaseModal").hidden = false;
  }

  function renderLines() {
    const opts = (sel) => products.map((p) => `<option value="${p.id}"${p.id === sel ? " selected" : ""}>${esc(p.name)} (${esc(p.sku)})</option>`).join("");
    $("purchaseLines").innerHTML = lines.map((l, i) => `<div class="part-row purchase-row" data-i="${i}">
        <select data-k="product_id" aria-label="Product">${opts(l.product_id)}</select>
        <input type="number" data-k="qty" min="0.01" step="any" value="${esc(l.qty)}" aria-label="Quantity" placeholder="Qty">
        <input type="number" data-k="unit_cost" min="0" step="0.01" value="${esc(l.unit_cost)}" aria-label="Cost per unit (₹, excl. GST)" placeholder="Cost/unit ₹">
        <button type="button" class="icon-btn" data-rm aria-label="Remove">✕</button>
      </div>`).join("");
    total();
  }
  function total() {
    const taxable = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.unit_cost) || 0), 0);
    const gst = Number($("purchaseForm").gst.value) || 0;
    $("purchaseTotal").textContent = `Taxable ${inr(taxable)} + GST ${inr(gst)} = ${inr(taxable + gst)}`;
  }

  $("purchaseLines").addEventListener("change", (e) => {
    const row = e.target.closest("[data-i]");
    if (!row) return;
    const l = lines[Number(row.dataset.i)];
    const k = e.target.dataset.k;
    l[k] = k === "product_id" ? e.target.value : Number(e.target.value) || 0;
    if (k === "product_id") {
      l.unit_cost = Number(products.find((p) => p.id === l.product_id)?.cost_price) || 0; // last known cost as a starting point
      renderLines();
    } else total();
  });
  $("purchaseLines").addEventListener("click", (e) => {
    if (!e.target.closest("[data-rm]")) return;
    lines.splice(Number(e.target.closest("[data-i]").dataset.i), 1);
    renderLines();
  });
  $("purchaseAddLine").addEventListener("click", () => {
    lines.push({ product_id: products[0]?.id, qty: 1, unit_cost: Number(products[0]?.cost_price) || 0 });
    renderLines();
  });
  $("purchaseForm").gst.addEventListener("input", total);

  let saving = false; // a double click must not record the bill twice
  $("purchaseForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (saving) return;
    const f = e.target;
    if (!lines.length) return ($("purchaseError").textContent = "Add at least one item.");
    saving = true;
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    const { error } = await sb.rpc("record_purchase", {
      p_supplier: f.supplier.value.trim(), p_gstin: f.supplier_gstin.value.trim() || null, p_bill_no: f.bill_no.value.trim() || null,
      p_bill_date: f.bill_date.value, p_lines: lines, p_gst: Number(f.gst.value) || 0, p_notes: f.notes.value.trim() || null,
    });
    saving = false;
    btn.disabled = false;
    if (error) {
      return ($("purchaseError").textContent = /purchases_supplier_bill_idx|duplicate/.test(error.message)
        ? "This supplier bill is already recorded." : error.message);
    }
    $("purchaseModal").hidden = true;
    toast("Purchase recorded: stock and cost prices updated");
    loadRecent();
    window.CRM.showView("products"); // refresh stock figures
    loadTiles();
  });

  $("purchaseBtn").addEventListener("click", openPurchase);
  document.querySelectorAll("[data-close-purchase]").forEach((el) => el.addEventListener("click", () => ($("purchaseModal").hidden = true)));
  window.Purchases = { loadRecent }; // the Products screen also lists recent purchases (products.js)
})();
