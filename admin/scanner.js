// Camera barcode / QR scanner for serial numbers (phones with Chrome). A hand scanner or typing works everywhere.
(() => {
  const $ = (id) => document.getElementById(id);
  let stream = null;
  let timer = null;
  let finish = null;

  function close(value = null) {
    clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    $("scanModal").hidden = true;
    const done = finish;
    finish = null;
    done?.(value);
  }

  // Resolves with the scanned text, or null if closed
  function scan(title) {
    return new Promise(async (resolve) => {
      finish = resolve;
      $("scanTitle").textContent = title;
      $("scanStatus").textContent = "Point the camera at the serial-number barcode or QR code.";
      $("scanModal").hidden = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch (err) {
        $("scanStatus").textContent = "Couldn't open the camera: " + (err.message || err);
        return;
      }
      const video = $("scanVideo");
      video.srcObject = stream;
      await video.play();
      const detector = new window.BarcodeDetector({ formats: await window.BarcodeDetector.getSupportedFormats() });
      let busy = false;
      timer = setInterval(async () => {
        if (busy || video.readyState < 2) return;
        busy = true;
        try {
          const [code] = await detector.detect(video);
          if (code?.rawValue) return close(code.rawValue.trim());
        } catch {
          // keep trying
        }
        busy = false;
      }, 300);
    });
  }

  document.querySelectorAll("[data-close-scan]").forEach((el) => el.addEventListener("click", () => close(null)));

  window.Scanner = { available: "BarcodeDetector" in window, scan };
})();
