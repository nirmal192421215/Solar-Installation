// GST tax invoices: for orders (issued once the goods have gone out) and chargeable repairs (issued automatically).
// The numbers are worked out in the database (public.issue_order_invoice / issue_service_invoice); this file shows them,
// makes the PDF, stores it in the private "invoices" bucket and sends it on WhatsApp.
(() => {
  const { sb, state, esc, toast, fmtDateTime } = window.CRM;

  const WHATSAPP_FUNCTION = "send-whatsapp";
  const inr = (n) => "₹" + (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rs = (n) => "Rs. " + (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

  // Rupees in words, Indian style (lakh, crore), for the invoice
  function inWords(amount) {
    const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
      "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
    const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
    const two = (n) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? " " + ones[n % 10] : ""}`);
    const three = (n) => `${n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? " " : ""}` : ""}${n % 100 ? two(n % 100) : ""}`;
    let n = Math.round(Number(amount) || 0);
    if (!n) return "Rupees Zero Only";
    const parts = [];
    [[1e7, "Crore"], [1e5, "Lakh"], [1e3, "Thousand"]].forEach(([size, name]) => {
      if (n >= size) {
        parts.push(`${three(Math.floor(n / size))} ${name}`);
        n %= size;
      }
    });
    if (n) parts.push(three(n));
    return `Rupees ${parts.join(" ")} Only`;
  }

  // ---------- PDF ----------
  async function buildPdf(inv) {
    await window.Quotes.loadSettings();
    const settings = window.Quotes.getSettings();
    const P = window.Quotes.pdf;
    const { W, M, orange, navy, muted } = P;
    const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    P.header(doc);

    let y = 46;
    doc.setTextColor(...navy).setFont("helvetica", "bold").setFontSize(19).text("TAX INVOICE", M, y);
    if (inv.status === "cancelled") doc.setTextColor(198, 40, 40).setFontSize(12).text("CANCELLED", M + 62, y);
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...muted);
    doc.text(`Invoice no: ${inv.invoice_number}`, W - M, y - 7, { align: "right" });
    doc.text(`Date: ${fmtDate(inv.invoice_date)}`, W - M, y - 2.5, { align: "right" });
    doc.text(`Place of supply: ${inv.place_of_supply || ""}`, W - M, y + 2, { align: "right" });

    y += 8;
    const half = (W - 2 * M - 6) / 2;
    const col2 = M + half + 6;
    doc.setDrawColor(230, 225, 218).setFillColor(248, 246, 242);
    doc.roundedRect(M, y, half, 30, 2, 2, "FD");
    doc.roundedRect(col2, y, half, 30, 2, 2, "FD");
    doc.setTextColor(...orange).setFont("helvetica", "bold").setFontSize(8).text("SUPPLIER", M + 5, y + 6);
    doc.text("BILL TO", col2 + 5, y + 6);
    doc.setTextColor(...navy).setFontSize(10).text("Sun Power Solar Solutions", M + 5, y + 12);
    doc.text(inv.customer_name || "", col2 + 5, y + 12);
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(60, 60, 60);
    doc.text([settings.gstin ? `GSTIN ${settings.gstin}` : "GSTIN: (add in Quote settings)", settings.company_state || "Telangana"], M + 5, y + 17);
    doc.text([...doc.splitTextToSize(inv.customer_address || "", half - 10).slice(0, 2), inv.customer_gstin ? `GSTIN ${inv.customer_gstin}` : "Unregistered (no GSTIN)"], col2 + 5, y + 17);

    const gstHead = inv.intra_state ? "CGST + SGST" : "IGST";
    doc.autoTable({
      startY: y + 36, margin: { left: M, right: M },
      head: [["#", "Description", "HSN/SAC", "Qty", "Rate", "Taxable", "GST %", gstHead]],
      body: inv.lines.map((l, i) => [i + 1, l.description, l.hsn || "", `${l.qty} ${l.unit || ""}`.trim(), rs(l.rate), rs(l.taxable), `${l.gst_rate}%`, rs(l.gst)]),
      theme: "grid",
      styles: { font: "helvetica", fontSize: 8, cellPadding: 1.8, lineColor: [230, 225, 218] },
      headStyles: { fillColor: navy, textColor: 255 },
      columnStyles: { 0: { cellWidth: 7, halign: "center" }, 2: { cellWidth: 16 }, 3: { cellWidth: 15, halign: "right" }, 4: { cellWidth: 22, halign: "right" },
        5: { cellWidth: 24, halign: "right" }, 6: { cellWidth: 13, halign: "right" }, 7: { cellWidth: 22, halign: "right" } },
      didParseCell: (d) => { if (d.section === "head" && d.column.index >= 3) d.cell.styles.halign = "right"; },
    });
    y = doc.lastAutoTable.finalY + 4;

    const totals = [
      ...(Number(inv.discount) > 0 ? [["Discount (already deducted above)", rs(inv.discount)]] : []),
      ["Taxable value", rs(inv.taxable)],
      ...(inv.intra_state ? [["CGST", rs(inv.cgst)], ["SGST", rs(inv.sgst)]] : [["IGST", rs(inv.igst)]]),
      ...(Number(inv.rounding) ? [["Rounding", rs(inv.rounding)]] : []),
      ["Invoice total", rs(inv.total)],
    ];
    if (y + totals.length * 7 + 40 > 282) { doc.addPage(); y = 20; }
    doc.autoTable({
      startY: y, margin: { left: W - M - 90, right: M }, body: totals, theme: "plain",
      styles: { fontSize: 9, cellPadding: 1.5 }, columnStyles: { 1: { halign: "right", fontStyle: "bold" } },
      didParseCell: (d) => { if (d.row.raw[0] === "Invoice total") { d.cell.styles.textColor = orange; d.cell.styles.fontStyle = "bold"; } },
    });
    y = doc.lastAutoTable.finalY + 4;
    doc.setFontSize(8.5).setTextColor(60, 60, 60).setFont("helvetica", "bold").text(inWords(inv.total), M, y + 2, { maxWidth: W - 2 * M });
    doc.setFont("helvetica", "normal").setFontSize(7.5).setTextColor(...muted);
    const notes = [inv.kind === "service" ? "Out-of-warranty repair: parts at selling price plus the service visit charge." : "Payments received are shown on your receipts. Subsidy, if any, is paid by the Government to the customer.",
      settings.bank_details ? `Bank: ${String(settings.bank_details).replace(/\s*\n\s*/g, ", ")}` : ""].filter(Boolean);
    doc.text(notes, M, y + 9, { maxWidth: W - 2 * M - 80 });

    const sy = Math.max(y + 30, 250);
    doc.setDrawColor(...muted).line(W - M - 70, sy, W - M, sy);
    doc.setFontSize(8.5).text("For Sun Power Solar Solutions · Authorised signatory", W - M, sy + 5, { align: "right" });
    doc.setFontSize(7.5).text("This is a computer-generated invoice.", M, sy + 5);
    P.footer(doc);
    return doc;
  }

  // Store the PDF once; reuse it afterwards
  async function ensurePdf(inv) {
    if (inv.pdf_path) return inv.pdf_path;
    const doc = await buildPdf(inv);
    const path = `${inv.lead_id}/${inv.invoice_number.replace(/\//g, "-")}.pdf`;
    const up = await sb.storage.from("invoices").upload(path, doc.output("blob"), { contentType: "application/pdf", upsert: true });
    if (up.error) throw up.error;
    const { error } = await sb.from("invoices").update({ pdf_path: path }).eq("id", inv.id);
    if (error) throw error;
    inv.pdf_path = path;
    return path;
  }

  // ---------- The invoice block inside an order or a ticket ----------
  // el: container; ctx: { orderId?, ticketId?, leadId, canIssue, onChange }
  async function section(el, ctx) {
    let q = sb.from("invoices").select("*").order("created_at", { ascending: false });
    q = ctx.ticketId ? q.eq("ticket_id", ctx.ticketId).eq("kind", "service") : q.eq("order_id", ctx.orderId).eq("kind", "order");
    const { data, error } = await q;
    if (error) return (el.innerHTML = ""); // finance.sql not run yet
    const live = data.find((i) => i.status === "issued");
    const old = data.filter((i) => i.status === "cancelled");
    el.innerHTML = `
      <h3 class="form-section">Tax invoice</h3>
      ${live ? `<div class="inv-card">
          <div class="m-head"><span class="m-title">${esc(live.invoice_number)} · ${esc(inr(live.total))}</span>
            <span class="badge ${live.sent_at ? "o-installed" : "o-wait"}">${live.sent_at ? "Sent" : "Not sent yet"}</span></div>
          <div class="m-meta">${esc(fmtDate(live.invoice_date))} · taxable ${esc(inr(live.taxable))} · ${live.intra_state ? `CGST ${esc(inr(live.cgst))} + SGST ${esc(inr(live.sgst))}` : `IGST ${esc(inr(live.igst))}`}
            ${live.customer_gstin ? ` · GSTIN ${esc(live.customer_gstin)}` : ""}${live.sent_at ? ` · sent ${esc(fmtDateTime(live.sent_at))}` : ""}
            ${live.kind === "service" ? ` · ${live.paid_on ? `paid ${esc(fmtDate(live.paid_on))} (${esc(live.paid_method || "")})` : "<b class=\"overdue\">unpaid</b>"}` : ""}</div>
          <div class="m-actions">
            <button type="button" class="btn btn--ghost btn--sm" data-inv="pdf">Invoice PDF</button>
            <button type="button" class="btn btn--primary btn--sm" data-inv="send">${live.sent_at ? "Send again" : "Send on WhatsApp"}</button>
            ${live.kind === "service" && !live.paid_on ? `<button type="button" class="btn btn--ghost btn--sm" data-inv="paid">Mark paid</button>` : ""}
            ${state.isManager ? `<button type="button" class="danger-link" data-inv="cancel">Cancel invoice</button>` : ""}
          </div>
        </div>`
      : ctx.canIssue ? `<div class="manage inv-issue">
          <label class="span-2"><span>Billing address</span><input name="inv_address" placeholder="House no, street, area, city, PIN"></label>
          <label><span>Customer GSTIN (businesses only)</span><input name="inv_gstin" maxlength="15" placeholder="optional" autocapitalize="characters"></label>
          <div class="form-foot"><button type="button" class="btn btn--primary btn--sm" data-inv="issue">Issue tax invoice</button></div>
        </div>`
      : `<p class="muted">${ctx.ticketId ? "No invoice: this repair is free under warranty." : "The tax invoice can be issued once the goods have been dispatched."}</p>`}
      ${old.length ? `<p class="m-meta">Cancelled: ${old.map((i) => `${esc(i.invoice_number)} (${esc(i.cancelled_reason || "")})`).join(", ")}</p>` : ""}`;

    el.onclick = async (e) => {
      const b = e.target.closest("button[data-inv]");
      if (!b) return;
      const act = b.dataset.inv;
      // Open the tab during the click itself, or the browser's pop-up blocker stops it after the await
      const tab = act === "pdf" ? window.open("about:blank", "_blank") : null;
      b.disabled = true;
      try {
        if (act === "issue") {
          const address = el.querySelector('[name="inv_address"]').value.trim();
          const gstin = el.querySelector('[name="inv_gstin"]').value.trim().toUpperCase();
          if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(gstin)) throw new Error("That GSTIN doesn't look right (15 characters, e.g. 36ABCDE1234F1Z5).");
          if (!address && !confirm("No billing address entered: the invoice will show the city / PIN only. Issue anyway?")) return;
          if (!confirm("Issue the tax invoice? Once issued it can't be edited (only cancelled by a manager and re-issued).")) return;
          const { data: id, error: e1 } = await sb.rpc("issue_order_invoice", { p_order_id: ctx.orderId, p_address: address || null, p_gstin: gstin || null });
          if (e1) throw e1;
          const { data: inv } = await sb.from("invoices").select("*").eq("id", id).single();
          await ensurePdf(inv);
          toast(`Tax invoice ${inv.invoice_number} issued`);
        }
        if (act === "pdf") {
          const path = await ensurePdf(live);
          const { data: url, error: e2 } = await sb.storage.from("invoices").createSignedUrl(path, 3600);
          if (e2) throw e2;
          if (tab) tab.location.href = url.signedUrl; else window.location.href = url.signedUrl;
        }
        if (act === "send") {
          await ensurePdf(live);
          const { error: e3 } = await sb.functions.invoke(WHATSAPP_FUNCTION, { body: { kind: "invoice", lead_id: live.lead_id, invoice_id: live.id } });
          if (e3) {
            let msg = e3.message;
            try { msg = (await e3.context.json()).error || msg; } catch {}
            throw new Error(msg);
          }
          toast("Invoice sent on WhatsApp ✓");
        }
        if (act === "paid") {
          const method = prompt("Paid how? (upi / cash / bank / card)", "upi");
          if (method === null) return;
          const ref = prompt("Payment reference (UTR / receipt no), optional:", "") ?? "";
          const { error: e4 } = await sb.from("invoices").update({ paid_on: window.CRM.todayISO(), paid_method: method.trim() || "upi", paid_reference: ref.trim() || null }).eq("id", live.id);
          if (e4) throw e4;
          toast("Marked paid");
        }
        if (act === "cancel") {
          const why = prompt(`Cancel ${live.invoice_number}? It stays on record as cancelled. Reason:`);
          if (why === null) return;
          const { error: e5 } = await sb.from("invoices").update({ status: "cancelled", cancelled_reason: why.trim() }).eq("id", live.id);
          if (e5) throw e5;
          toast("Invoice cancelled");
        }
        await section(el, ctx);
        ctx.onChange?.();
      } catch (err) {
        tab?.close();
        toast(err.message || String(err));
      } finally {
        b.disabled = false;
      }
    };
  }

  window.Invoices = { section, buildPdf, inWords };
})();
