// Shared camera barcode scanner. Exposes window.Scanner.scan(opts) which opens
// a full-screen overlay, decodes one Code128 barcode via the vendored
// html5-qrcode library (/vendor/html5-qrcode.min.js, loaded before this file),
// and resolves with the barcode string — or null if the user cancels.
//
// If the camera can't start (no camera, permission denied, non-HTTPS page) the
// overlay collapses to manual-entry mode, so every flow still works typed.
(function () {
  const STYLE = `
    .scn-overlay { position: fixed; inset: 0; background: rgba(15,23,42,.96); z-index: 1000;
      display: flex; flex-direction: column; align-items: center; padding: 18px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #fff; }
    .scn-title { font-size: 17px; font-weight: 700; margin: 6px 0 14px; text-align: center; }
    .scn-video { width: 100%; max-width: 420px; border-radius: 12px; overflow: hidden; background: #000; }
    .scn-video video { width: 100% !important; display: block; }
    .scn-hint { color: #94a3b8; font-size: 13px; margin: 12px 0; text-align: center; max-width: 420px; }
    .scn-manual { display: flex; gap: 8px; width: 100%; max-width: 420px; margin-top: 4px; }
    .scn-manual input { flex: 1; padding: 13px 12px; border-radius: 10px; border: 1px solid #475569;
      background: #1e293b; color: #fff; font-size: 16px; text-transform: uppercase; }
    .scn-manual button { padding: 13px 18px; border-radius: 10px; border: none; background: #2563eb;
      color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
    .scn-cancel { margin-top: 18px; padding: 13px 26px; min-height: 44px; border-radius: 10px;
      border: 1px solid #475569; background: transparent; color: #cbd5e1; font-size: 15px; cursor: pointer; }
  `;

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    const s = document.createElement('style');
    s.textContent = STYLE;
    document.head.appendChild(s);
    styleInjected = true;
  }

  /**
   * Open the scan overlay.
   * @param {object} opts
   * @param {string} [opts.title]  heading shown above the camera view
   * @returns {Promise<string|null>} decoded/typed barcode (trimmed, uppercased) or null on cancel
   */
  function scan({ title = 'Scan barcode' } = {}) {
    injectStyle();
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'scn-overlay';
      overlay.innerHTML = `
        <div class="scn-title"></div>
        <div class="scn-video" id="scn-reader"></div>
        <div class="scn-hint">Point the camera at a barcode…</div>
        <div class="scn-manual">
          <input type="text" placeholder="Type it instead" autocapitalize="characters" autocomplete="off" />
          <button type="button">Add</button>
        </div>
        <button type="button" class="scn-cancel">Cancel</button>
      `;
      overlay.querySelector('.scn-title').textContent = title;
      document.body.appendChild(overlay);

      let reader = null;
      let settled = false;
      async function finish(value) {
        if (settled) return;
        settled = true;
        if (reader) {
          try { await reader.stop(); } catch { /* already stopped */ }
          try { reader.clear(); } catch { /* ignore */ }
        }
        overlay.remove();
        resolve(value);
      }

      const input = overlay.querySelector('.scn-manual input');
      const submitManual = () => {
        const v = input.value.trim().toUpperCase();
        if (v) finish(v);
      };
      overlay.querySelector('.scn-manual button').addEventListener('click', submitManual);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitManual(); });
      overlay.querySelector('.scn-cancel').addEventListener('click', () => finish(null));

      const hint = overlay.querySelector('.scn-hint');
      const videoBox = overlay.querySelector('.scn-video');

      if (typeof Html5Qrcode === 'undefined') {
        videoBox.style.display = 'none';
        hint.textContent = 'Scanner library not loaded — type the barcode below.';
        return;
      }

      reader = new Html5Qrcode('scn-reader', {
        formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128],
        // Use the browser's native detector when available (faster), with the
        // bundled ZXing decoder as the cross-browser fallback (iOS Safari).
        useBarCodeDetectorIfSupported: true,
        verbose: false,
      });
      reader
        .start(
          { facingMode: 'environment' },
          // Wide box suits 1D Code128 barcodes.
          { fps: 10, qrbox: (w, h) => ({ width: Math.min(w * 0.9, 380), height: Math.min(h * 0.5, 160) }) },
          (decoded) => finish(String(decoded).trim().toUpperCase()),
          () => { /* per-frame decode misses are normal — ignore */ }
        )
        .catch(() => {
          // No camera / permission denied / insecure context → manual entry only.
          if (settled) return;
          reader = null;
          videoBox.style.display = 'none';
          hint.textContent = 'Camera unavailable (needs permission and HTTPS) — type the barcode below.';
          input.focus();
        });
    });
  }

  window.Scanner = { scan };
})();
