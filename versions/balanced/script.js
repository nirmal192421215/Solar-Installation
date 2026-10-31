(() => {
  const WHATSAPP_NUMBER = "918885551536";

  // ---------- Mobile menu ----------
  const nav = document.getElementById("nav");
  const toggle = document.getElementById("menuToggle");
  const setMenu = (open) => {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Close" : "Menu";
  };
  toggle.addEventListener("click", () => setMenu(!nav.classList.contains("is-open")));
  nav.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setMenu(false)));

  // ---------- Fade-in on scroll ----------
  const fades = document.querySelectorAll(".fade");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add("is-visible");
        io.unobserve(e.target);
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });
    fades.forEach((el) => io.observe(el));
  } else {
    fades.forEach((el) => el.classList.add("is-visible"));
  }

  // ---------- Savings calculator ----------
  // Indicative assumptions for Hyderabad
  const UNITS_PER_KW_MONTH = 120;
  const TARIFF = { home: 8, business: 10 };   // ₹ per unit, effective
  const MAX_KW = { home: 10, business: 500 };
  const YEARS = 25;

  const range = document.getElementById("billRange");
  const out = {
    bill: document.getElementById("billValue"),
    size: document.getElementById("rSize"),
    monthly: document.getElementById("rMonthly"),
    life: document.getElementById("rLife"),
    subsidy: document.getElementById("rSubsidy"),
    area: document.getElementById("rArea"),
  };
  const subsidyBox = document.getElementById("subsidyBox");
  const typeBtns = document.querySelectorAll(".toggle button");
  const formBill = document.getElementById("formBill");
  let type = "home";

  const inr = (n) => Math.round(n).toLocaleString("en-IN");
  const short = (n) => {
    if (n >= 1e7) return (n / 1e7).toFixed(2).replace(/\.?0+$/, "") + " Cr";
    if (n >= 1e5) return (n / 1e5).toFixed(1).replace(/\.0$/, "") + "L";
    return inr(n);
  };
  // PM Surya Ghar: ₹30k/kW for first 2 kW, ₹18k for the 3rd kW, max ₹78k
  const subsidyFor = (kw) => Math.min(kw, 2) * 30000 + Math.max(0, Math.min(kw - 2, 1)) * 18000;

  function calculate() {
    const bill = Number(range.value);
    const tariff = TARIFF[type];
    const units = bill / tariff;
    const kw = Math.min(MAX_KW[type], Math.max(1, Math.round((units / UNITS_PER_KW_MONTH) * 2) / 2));
    const monthly = Math.min(kw * UNITS_PER_KW_MONTH * tariff, bill) * 0.9; // fixed charges remain

    out.bill.textContent = inr(bill);
    out.size.textContent = kw % 1 ? kw.toFixed(1) : kw;
    out.monthly.textContent = inr(monthly);
    out.life.textContent = short(monthly * 12 * YEARS);
    out.area.textContent = inr(kw * 100);
    out.subsidy.textContent = type === "home" ? inr(subsidyFor(kw)) : "0";
    subsidyBox.classList.toggle("is-muted", type !== "home");

    const pct = ((bill - range.min) / (range.max - range.min)) * 100;
    range.style.background = `linear-gradient(90deg, var(--accent) ${pct}%, var(--line) ${pct}%)`;
  }

  range.addEventListener("input", calculate);
  typeBtns.forEach((btn) => btn.addEventListener("click", () => {
    type = btn.dataset.type;
    typeBtns.forEach((b) => {
      b.classList.toggle("is-active", b === btn);
      b.setAttribute("aria-selected", String(b === btn));
    });
    calculate();
  }));
  document.getElementById("calcCta").addEventListener("click", () => {
    const bill = Number(range.value);
    formBill.selectedIndex = bill < 2000 ? 0 : bill <= 5000 ? 1 : bill <= 10000 ? 2 : bill <= 25000 ? 3 : 4;
  });
  calculate();

  // ---------- Lead form -> WhatsApp ----------
  const form = document.getElementById("leadForm");
  const note = document.getElementById("formNote");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const name = data.get("name").trim();
    const phone = data.get("phone").trim();
    const phoneOk = /^[0-9+\s-]{10,15}$/.test(phone);

    form.name.classList.toggle("is-invalid", !name);
    form.phone.classList.toggle("is-invalid", !phoneOk);
    if (!name || !phoneOk) {
      note.textContent = "Please enter your name and a valid phone number.";
      note.className = "form__note is-error";
      return;
    }

    const lines = [
      "Hi Sun Power Solar, I'd like a free solar quote.",
      "",
      `Name: ${name}`,
      `Phone: ${phone}`,
      `Property: ${data.get("type")}`,
      `Monthly bill: ${data.get("bill")}`,
    ];
    const area = data.get("area").trim();
    if (area) lines.push(`Area: ${area}`);

    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join("\n"))}`, "_blank", "noopener");
    note.textContent = "Opening WhatsApp. Press send and we'll get back to you.";
    note.className = "form__note is-success";
    form.reset();
  });

  document.getElementById("year").textContent = new Date().getFullYear();
})();
