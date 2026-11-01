(() => {
  const WHATSAPP_NUMBER = "919342626096";
  // Supabase project that stores leads for the CRM (publishable key is safe to expose)
  const SUPABASE_URL = "https://iekfgtyfwmplsauutegs.supabase.co";
  const SUPABASE_KEY = "sb_publishable_T3VNvcPRVWugOHRAWGk8UA_dTsQ3jdP";
  const PAGE_LOADED_AT = Date.now();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Header state, progress bar & parallax ----------
  const header = document.getElementById("header");
  const progress = document.getElementById("progress");
  const parallax = [...document.querySelectorAll("[data-parallax]")];
  let ticking = false;
  const onScroll = () => {
    const y = window.scrollY;
    header.classList.toggle("is-top", y < 40);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
    if (!reduceMotion) {
      parallax.forEach((el) => {
        if (y < window.innerHeight * 1.2) el.style.transform = `translate3d(0, ${y * Number(el.dataset.parallax)}px, 0)`;
      });
    }
    ticking = false;
  };
  window.addEventListener("scroll", () => {
    if (!ticking) { requestAnimationFrame(onScroll); ticking = true; }
  }, { passive: true });
  onScroll();

  // ---------- Split headings into words ----------
  const splitTargets = document.querySelectorAll("[data-split], .section-title");
  splitTargets.forEach((el) => {
    let i = 0;
    const walk = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(" ")); return; }
            const outer = document.createElement("span");
            outer.className = "w";
            const inner = document.createElement("span");
            inner.style.setProperty("--i", i++);
            inner.textContent = part;
            outer.appendChild(inner);
            frag.appendChild(outer);
          });
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== "BR") {
          walk(child);
        }
      });
    };
    walk(el);
    el.classList.add("is-split");
  });

  // ---------- Preloader ----------
  const preloader = document.getElementById("preloader");
  const heroSplit = document.querySelectorAll(".hero .is-split");
  let loaded = false;
  const finishLoading = () => {
    if (loaded) return;
    loaded = true;
    preloader.classList.add("is-done");
    setTimeout(() => heroSplit.forEach((el) => el.classList.add("is-visible")), 250);
  };
  window.addEventListener("load", () => setTimeout(finishLoading, 400));
  setTimeout(finishLoading, 2500);

  // ---------- Count-up numbers ----------
  const animateCount = (el) => {
    const target = Number(el.dataset.count);
    const decimals = Number(el.dataset.decimals || 0);
    if (reduceMotion) { el.textContent = target.toFixed(decimals); return; }
    const start = performance.now();
    const dur = 1600;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = (target * eased).toFixed(decimals);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // ---------- Mobile menu ----------
  const nav = document.getElementById("nav");
  const toggle = document.getElementById("menuToggle");
  const setMenu = (open) => {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  toggle.addEventListener("click", () => setMenu(!nav.classList.contains("is-open")));
  nav.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setMenu(false)));

  // ---------- Reveal on scroll ----------
  const reveals = document.querySelectorAll(".reveal");
  const splits = [...document.querySelectorAll(".is-split")].filter((el) => !el.closest(".hero"));
  const counters = document.querySelectorAll("[data-count]");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("is-visible");
          e.target.querySelectorAll("[data-count]").forEach(animateCount);
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    reveals.forEach((el, i) => {
      el.style.transitionDelay = `${(i % 4) * 70}ms`;
      io.observe(el);
    });
    splits.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("is-visible"));
    splits.forEach((el) => el.classList.add("is-visible"));
    counters.forEach(animateCount);
  }

  // ---------- Active nav link ----------
  const links = [...nav.querySelectorAll('a[href^="#"]:not(.btn)')];
  const sections = links.map((l) => document.querySelector(l.getAttribute("href"))).filter(Boolean);
  if ("IntersectionObserver" in window) {
    const navIo = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        links.forEach((l) => l.classList.toggle("is-active", l.getAttribute("href") === `#${e.target.id}`));
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    sections.forEach((s) => navIo.observe(s));
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
  const typeBtns = document.querySelectorAll(".calc__type button");
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

    if (type === "home") {
      out.subsidy.textContent = inr(subsidyFor(kw));
      subsidyBox.classList.remove("is-muted");
    } else {
      out.subsidy.textContent = "0";
      subsidyBox.classList.add("is-muted");
    }

    const pct = ((bill - range.min) / (range.max - range.min)) * 100;
    range.style.background = `linear-gradient(90deg, var(--orange) ${pct}%, var(--tint) ${pct}%)`;
  }

  // Pre-fill the form's bill range, property type and system size from the calculator
  function syncFormFromCalculator() {
    const bill = Number(range.value);
    const billIdx = bill < 2000 ? 0 : bill <= 4000 ? 1 : bill <= 6000 ? 2 : 3;
    const billInputs = document.querySelectorAll('#leadForm input[name="bill"]');
    if (billInputs[billIdx]) billInputs[billIdx].checked = true;

    const property = document.querySelector(`#leadForm input[name="property"][value="${type === "home" ? "Home" : "Shop"}"]`);
    if (property) property.checked = true;

    const kw = Number(out.size.textContent);
    const sizeValue = Number.isInteger(kw) && kw >= 1 && kw <= 5 ? `${kw} kW` : "Not sure";
    const size = document.querySelector(`#leadForm input[name="size"][value="${sizeValue}"]`);
    if (size) size.checked = true;
  }

  range.addEventListener("input", calculate);
  typeBtns.forEach((btn) => btn.addEventListener("click", () => {
    type = btn.dataset.type;
    typeBtns.forEach((b) => {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", String(active));
    });
    calculate();
  }));
  document.getElementById("calcCta").addEventListener("click", syncFormFromCalculator);
  calculate();

  // ---------- Lead form -> WhatsApp ----------
  const form = document.getElementById("leadForm");
  const note = document.getElementById("formNote");

  const phoneBox = form.querySelector(".phone-input");
  const consentLabel = form.querySelector(".consent");

  // Keep the phone field to 10 digits, dropping a pasted +91 or leading 0
  form.phone.addEventListener("input", () => {
    let digits = form.phone.value.replace(/\D/g, "");
    if (digits.length > 10 && digits.startsWith("91")) digits = digits.slice(2);
    else if (digits.length > 10 && digits.startsWith("0")) digits = digits.slice(1);
    form.phone.value = digits.slice(0, 10);
  });

  const showNote = (text, kind) => {
    note.textContent = text;
    note.className = `form__note is-${kind}`;
  };

  // Swap the form for the thank-you panel
  const success = document.getElementById("formSuccess");
  const CALL_WHEN = {
    "Call me now": "in the next few minutes",
    "Later today": "later today",
    "Tomorrow": "tomorrow",
  };
  const showSuccess = (lead) => {
    document.getElementById("successName").textContent = lead.name.split(" ")[0];
    document.getElementById("successWhen").textContent = CALL_WHEN[lead.preferredCallTime] || "shortly";
    document.getElementById("successPhone").textContent = lead.phone.replace(/^\+91(\d{5})(\d{5})$/, "+91 $1 $2");
    note.textContent = "";
    note.className = "form__note";
    form.reset();
    form.querySelectorAll(".is-invalid").forEach((el) => el.classList.remove("is-invalid"));
    form.classList.add("is-sent");
    success.hidden = false;
    success.focus({ preventScroll: true });
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  document.getElementById("formAgain").addEventListener("click", () => {
    form.classList.remove("is-sent");
    success.hidden = true;
    form.name.focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const get = (k) => (data.get(k) || "").toString().trim();

    const lead = {
      name: get("name"),
      phone: "+91" + get("phone"),
      location: get("location"),
      address: get("address"),
      consent: data.get("consent") === "on",
      email: get("email"),
      propertyType: get("property"),
      monthlyBill: get("bill"),
      systemSize: get("size"),
      systemType: get("system"),
      wantsSubsidy: get("subsidy"),
      preferredCallTime: get("callTime"),
      submittedAt: new Date().toISOString(),
    };

    const nameOk = lead.name.length > 1;
    const phoneOk = /^[6-9]\d{9}$/.test(get("phone"));
    const locationOk = lead.location.length > 1;
    const emailOk = !lead.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email);

    form.name.classList.toggle("is-invalid", !nameOk);
    phoneBox.classList.toggle("is-invalid", !phoneOk);
    form.location.classList.toggle("is-invalid", !locationOk);
    form.email.classList.toggle("is-invalid", !emailOk);
    consentLabel.classList.toggle("is-invalid", !lead.consent);

    if (!nameOk) return showNote("Please enter your full name.", "error");
    if (!phoneOk) return showNote("Please enter a valid 10-digit Indian mobile number.", "error");
    if (!locationOk) return showNote("Please enter your city or pincode.", "error");
    if (!emailOk) return showNote("Please check your email address.", "error");
    if (!lead.consent) return showNote("Please agree to receive a call so our advisor can reach you.", "error");

    // Only treat it as a bot when the hidden trap is filled AND the form was sent
    // inhumanly fast; browser autofill alone must never drop a real lead.
    const secondsOnPage = (Date.now() - PAGE_LOADED_AT) / 1000;
    if (get("sp_check") && secondsOnPage < 4) {
      showSuccess(lead);
      return;
    }

    // Save to the CRM
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    showNote("Sending…", "info");
    const orNull = (v) => v || null;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          name: lead.name,
          phone: lead.phone,
          location: lead.location,
          address: orNull(lead.address),
          consent: lead.consent,
          email: orNull(lead.email),
          property_type: orNull(lead.propertyType),
          monthly_bill: orNull(lead.monthlyBill),
          system_size: orNull(lead.systemSize),
          system_type: orNull(lead.systemType),
          wants_subsidy: orNull(lead.wantsSubsidy),
          preferred_call_time: orNull(lead.preferredCallTime),
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      showSuccess(lead);
      return;
    } catch (err) {
      console.error("Lead save failed, falling back to WhatsApp:", err);
    } finally {
      btn.disabled = false;
    }

    // Fallback: send the lead over WhatsApp so it isn't lost
    const lines = [
      "Hi Sun Power Solar, I'd like a free solar quote.",
      "",
      `Name: ${lead.name}`,
      `Phone: ${lead.phone}`,
      `City / pincode: ${lead.location}`,
    ];
    const optional = [
      ["Email", lead.email],
      ["Property type", lead.propertyType],
      ["Monthly bill", lead.monthlyBill],
      ["System size", lead.systemSize],
      ["System type", lead.systemType],
      ["Want subsidy", lead.wantsSubsidy],
      ["Preferred call time", lead.preferredCallTime],
    ];
    optional.forEach(([label, value]) => { if (value) lines.push(`${label}: ${value}`); });
    lines.push("", "I agree to receive a call from SunPower's AI energy advisor.");

    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join("\n"))}`, "_blank", "noopener");
    showNote("We couldn't save your request online, so we've opened WhatsApp. Just hit send and we'll get back to you.", "success");
    form.reset();
  });

  // ---------- Footer year ----------
  document.getElementById("year").textContent = new Date().getFullYear();
})();
