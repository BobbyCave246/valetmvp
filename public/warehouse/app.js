// Warehouse phone scan station — put-away, pull-out, and bin intake.
// After each result it auto-resets for the next bin, scan-gun style.

let mode = null;
let lastResult = null;

$('#modePutaway').addEventListener('click', () => openFlow('putaway'));
$('#modePullout').addEventListener('click', () => openFlow('pullout'));
$('#modeIntake').addEventListener('click', () => openFlow('intake'));
$('#backBtn').addEventListener('click', () => {
  mode = null;
  lastResult = null;
  $('#flowView').hidden = true;
  $('#modeView').hidden = false;
});

function openFlow(m, binBarcode = null) {
  mode = m;
  lastResult = null;
  if (m === 'intake') intakeSku = null;
  $('#modeView').hidden = true;
  $('#flowView').hidden = false;
  renderFlow(m, binBarcode);
}

function bannerHtml() {
  if (!lastResult) return '';
  return `<div class="banner ${lastResult.ok ? 'ok' : 'err'}">${esc(lastResult.text)}</div>`;
}

async function renderFlow(m, binBarcode = null) {
  if (m === 'putaway') renderPutaway(binBarcode);
  else if (m === 'intake') renderIntake();
  else renderPullout(binBarcode);
}

async function renderPutaway(binBarcode = null) {
  const body = $('#flowBody');
  body.innerHTML = `
    ${bannerHtml()}
    <div class="card">
      <h2>📥 Put away</h2>
      <div class="scan-step ${binBarcode ? 'done' : ''}">
        <div class="num">1</div>
        <div>${binBarcode ? `Bin <code>${esc(binBarcode)}</code> ✓` : 'Scan the bin barcode'}</div>
      </div>
      <div class="scan-step">
        <div class="num">2</div>
        <div>${binBarcode ? 'Scan the rack location — or tap a free slot below' : 'Then scan its rack location'}</div>
      </div>
      <div style="margin-top:12px;">
        <button class="btn" id="scanStep">📷 ${binBarcode ? 'Scan location' : 'Scan bin'}</button>
      </div>
      <div id="freeSlots"></div>
    </div>
  `;

  $('#scanStep').addEventListener('click', async () => {
    if (!binBarcode) {
      const code = await Scanner.scan({ title: 'Scan the bin barcode' });
      if (code) renderPutaway(code);
    } else {
      const loc = await Scanner.scan({ title: 'Scan the rack location' });
      if (loc) storeBin(binBarcode, loc);
    }
  });

  if (binBarcode) {
    try {
      const locations = await api.get('/locations');
      const free = locations.filter((l) => !l.occupied);
      const box = $('#freeSlots');
      if (!free.length) {
        box.innerHTML = '<div class="muted" style="margin-top:12px;">No free slots on the rack.</div>';
        return;
      }
      box.innerHTML = '<div class="muted" style="margin-top:14px;">Free slots — tap to use:</div><div class="slot-list"></div>';
      const list = box.querySelector('.slot-list');
      free.forEach((l) => {
        const chip = el(`<button class="slot-chip">${esc(l.barcode)}</button>`);
        chip.addEventListener('click', () => storeBin(binBarcode, l.barcode));
        list.appendChild(chip);
      });
    } catch (e) {
      toast(e.message, true);
    }
  }
}

async function storeBin(bin, loc) {
  try {
    const res = await api.post(`/bins/${bin}/store`, { locationBarcode: loc });
    lastResult = { ok: true, text: `✓ ${res.bin.barcode} stored @ ${res.location.barcode}` };
  } catch (e) {
    lastResult = { ok: false, text: `✗ ${bin}: ${e.message}` };
  }
  renderPutaway();
}

const SKU_LABELS = {
  bin: { label: 'Standard bin', icon: '📦' },
  wardrobe: { label: 'Wardrobe box', icon: '👔' },
  odd: { label: 'Odd / bulky item', icon: '🚲' },
};
let intakeSku = null;
let intakeCount = 0;

function renderIntake() {
  const body = $('#flowBody');
  if (!intakeSku) {
    intakeCount = 0;
    body.innerHTML = `
      ${bannerHtml()}
      <div class="card">
        <h2>🆕 Add new bins</h2>
        <p class="muted">What type are the bins you're adding?</p>
        <div id="skuPick"></div>
      </div>
    `;
    const pick = $('#skuPick');
    Object.entries(SKU_LABELS).forEach(([key, s]) => {
      const btn = el(`<button class="btn ghost" style="margin-top:10px;">${s.icon} ${esc(s.label)}</button>`);
      btn.addEventListener('click', () => {
        intakeSku = key;
        renderIntake();
      });
      pick.appendChild(btn);
    });
    return;
  }

  const s = SKU_LABELS[intakeSku];
  body.innerHTML = `
    ${bannerHtml()}
    <div class="card">
      <h2>🆕 Adding: ${s.icon} ${esc(s.label)}</h2>
      <p class="muted">Scan each new bin's barcode — it's added to the pool instantly.
        <strong>${intakeCount}</strong> added this session.</p>
      <button class="btn green" id="scanStep">📷 Scan new bin</button>
      <button class="btn ghost" id="switchSku" style="margin-top:10px;">Change bin type</button>
    </div>
  `;
  $('#switchSku').addEventListener('click', () => {
    intakeSku = null;
    lastResult = null;
    renderIntake();
  });
  $('#scanStep').addEventListener('click', async () => {
    const code = await Scanner.scan({ title: `Scan new ${s.label.toLowerCase()} barcode` });
    if (!code) return;
    try {
      const res = await api.post('/bins', { barcode: code, skuType: intakeSku });
      intakeCount++;
      lastResult = {
        ok: true,
        text: `✓ ${res.bin.barcode} added — pool now ${res.pool.total} bins (${res.pool.available} available)`,
      };
    } catch (e) {
      lastResult = { ok: false, text: `✗ ${code}: ${e.message}` };
    }
    renderIntake();
  });
}

function renderPullout(prefillBin = null) {
  const body = $('#flowBody');
  body.innerHTML = `
    ${bannerHtml()}
    <div class="card">
      <h2>📤 Pull out</h2>
      <p class="muted">Scan a stored bin to pull it from the rack for return delivery.</p>
      ${prefillBin ? `<p>Bin <code>${esc(prefillBin)}</code> from admin queue.</p><button class="btn green" id="confirmPull">Pull out ${esc(prefillBin)}</button>` : ''}
      <button class="btn" id="scanStep">📷 Scan bin</button>
    </div>
  `;
  const runScanOut = async (code) => {
    if (!code) return;
    try {
      const res = await api.post(`/bins/${code}/scan-out`, {});
      lastResult = {
        ok: true,
        text: `✓ ${res.bin.barcode} → ${res.bin.status}` + (res.freedLocation ? ` (freed ${res.freedLocation.barcode})` : ''),
      };
    } catch (e) {
      lastResult = { ok: false, text: `✗ ${code}: ${e.message}` };
    }
    renderPullout();
  };
  $('#scanStep').addEventListener('click', async () => {
    const code = await Scanner.scan({ title: 'Scan the bin barcode' });
    await runScanOut(code);
  });
  if (prefillBin) {
    $('#confirmPull').addEventListener('click', () => runScanOut(prefillBin));
  }
}

function applyDeepLink() {
  const params = new URLSearchParams(location.search);
  const modeParam = params.get('mode');
  const bin = params.get('bin')?.trim().toUpperCase() || null;
  if (!modeParam) return;
  const allowed = ['putaway', 'pullout', 'intake'];
  if (!allowed.includes(modeParam)) return;
  openFlow(modeParam, bin);
}

Session.guard('warehouse').then(applyDeepLink);
