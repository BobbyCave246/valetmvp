// Admin / warehouse console. All state lives in the API — this file only
// renders responses and POSTs actions. Nothing touches a DB directly.

const api = {
  async get(path) {
    const r = await fetch(`/api${path}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  },
};

const $ = (sel) => document.querySelector(sel);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
};

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  setTimeout(() => (t.className = ''), 2600);
}

// ---- tab switching ----------------------------------------------------------
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    refreshTab(btn.dataset.tab);
  });
});

function refreshTab(tab) {
  if (tab === 'queue') loadQueue();
  if (tab === 'assign') loadAssign();
  if (tab === 'jobs') loadJobs();
  if (tab === 'warehouse') loadWarehouse();
}

// ---- reset ------------------------------------------------------------------
$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('Wipe all data and re-seed the demo?')) return;
  await api.post('/admin/reset');
  toast('Demo reset to seed data');
  refreshTab(document.querySelector('nav button.active').dataset.tab);
});

// ---- queue ------------------------------------------------------------------
async function loadQueue() {
  const list = $('#queueList');
  const bookings = await api.get('/bookings');
  if (bookings.length === 0) {
    list.innerHTML = '<div class="empty">No bookings yet. Create one on the booking site.</div>';
    return;
  }
  list.innerHTML = '';
  for (const b of bookings) {
    const sku = Object.entries(b.sku_breakdown || {}).map(([k, v]) => `${v} ${k}`).join(', ');
    const card = el(`
      <div class="card">
        <div class="row">
          <div>
            <div><strong>${b.customer?.name || 'Unknown'}</strong> · ${b.bin_count} bins <span class="muted">(${sku})</span></div>
            <div class="muted">Delivery date: ${b.delivery_date} · ref <code>${b.id}</code></div>
            <div class="summary" style="margin-top:6px;">${b.summary.text}</div>
          </div>
          <div><span class="status-pill">${b.customer?.phone || ''}</span></div>
        </div>
      </div>
    `);
    list.appendChild(card);
  }
}

// ---- assign -----------------------------------------------------------------
let assignSelected = new Set();

async function loadAssign() {
  assignSelected = new Set();
  const select = $('#assignBooking');
  const bookings = await api.get('/bookings');
  select.innerHTML = bookings
    .map((b) => `<option value="${b.id}">${b.customer?.name} — ${b.bin_count} bins — ${b.delivery_date}</option>`)
    .join('');
  await renderAvailableBins();
  renderAssignSelected();
  updateAssignSummary();
}

$('#assignBooking').addEventListener('change', updateAssignSummary);

async function updateAssignSummary() {
  const id = $('#assignBooking').value;
  if (!id) return ($('#assignSummary').textContent = '');
  const booking = await api.get(`/bookings/${id}`);
  $('#assignSummary').textContent = booking.summary.text;
}

async function renderAvailableBins() {
  const bins = await api.get('/bins/available');
  const box = $('#availableBins');
  if (bins.length === 0) {
    box.innerHTML = '<span class="muted">No unassigned bins left.</span>';
    return;
  }
  box.innerHTML = '';
  bins.forEach((bin) => {
    const chip = el(`<span class="chip" data-barcode="${bin.barcode}">${bin.barcode} <span class="muted">${bin.sku_type}</span></span>`);
    chip.addEventListener('click', () => {
      toggleAssign(bin.barcode);
      chip.classList.toggle('selected', assignSelected.has(bin.barcode));
    });
    box.appendChild(chip);
  });
}

function toggleAssign(barcode) {
  if (assignSelected.has(barcode)) assignSelected.delete(barcode);
  else assignSelected.add(barcode);
  renderAssignSelected();
}

function renderAssignSelected() {
  const box = $('#assignSelected');
  if (assignSelected.size === 0) {
    box.innerHTML = '<span class="muted">none selected</span>';
    return;
  }
  box.innerHTML = '';
  [...assignSelected].forEach((bc) => {
    const chip = el(`<span class="chip selected">${bc} ✕</span>`);
    chip.addEventListener('click', () => {
      assignSelected.delete(bc);
      renderAssignSelected();
      renderAvailableBins();
    });
    box.appendChild(chip);
  });
}

$('#assignAddBarcode').addEventListener('click', () => {
  const v = $('#assignBarcode').value.trim().toUpperCase();
  if (!v) return;
  assignSelected.add(v);
  $('#assignBarcode').value = '';
  renderAssignSelected();
});
$('#assignBarcode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#assignAddBarcode').click();
});

$('#assignSubmit').addEventListener('click', async () => {
  const id = $('#assignBooking').value;
  if (!id || assignSelected.size === 0) return toast('Pick a booking and at least one bin', true);
  try {
    const res = await api.post(`/bookings/${id}/assign-bins`, { barcodes: [...assignSelected] });
    toast(`Assigned: ${res.summary.text}`);
    loadAssign();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---- jobs -------------------------------------------------------------------
const JOB_LABEL = {
  deliver_empty: 'Deliver empty bins',
  collect_full: 'Collect filled bins',
  deliver_back: 'Deliver bins back',
};

async function loadJobs() {
  const list = $('#jobsList');
  const jobs = await api.get('/jobs');
  if (jobs.length === 0) {
    list.innerHTML = '<div class="empty">No jobs scheduled.</div>';
    return;
  }
  list.innerHTML = '';
  jobs.forEach((j) => {
    const done = j.status === 'Done';
    const card = el(`
      <div class="card">
        <div class="row">
          <div>
            <div><strong>${JOB_LABEL[j.type] || j.type}</strong> <span class="status-pill">${j.status}</span></div>
            <div class="muted">${j.booking?.customer_id ? 'booking ' : ''}<code>${j.booking_id}</code> · date ${j.scheduled_date || '—'} · ${j.bin_ids.length} bins</div>
          </div>
          <div></div>
        </div>
      </div>
    `);
    if (!done) {
      const btn = el(`<button class="btn green">Mark done</button>`);
      btn.addEventListener('click', async () => {
        try {
          const res = await api.post(`/jobs/${j.id}/done`, {});
          toast(`Done — bins now ${res.advanced[0]?.status}`);
          loadJobs();
        } catch (e) {
          toast(e.message, true);
        }
      });
      card.querySelector('.row > div:last-child').appendChild(btn);
    }
    list.appendChild(card);
  });
}

// ---- warehouse --------------------------------------------------------------
async function loadWarehouse() {
  const free = await api.get('/locations/free');
  const box = $('#freeLocations');
  if (free.length === 0) {
    box.innerHTML = '<span class="muted">No free locations.</span>';
    return;
  }
  box.innerHTML = '';
  free.forEach((loc) => {
    const chip = el(`<span class="chip">${loc.barcode}</span>`);
    chip.addEventListener('click', () => ($('#storeLoc').value = loc.barcode));
    box.appendChild(chip);
  });
}

$('#storeSubmit').addEventListener('click', async () => {
  const bin = $('#storeBin').value.trim().toUpperCase();
  const loc = $('#storeLoc').value.trim().toUpperCase();
  if (!bin || !loc) return toast('Enter a bin and a location', true);
  try {
    const res = await api.post(`/bins/${bin}/store`, { locationBarcode: loc });
    toast(`${res.bin.barcode} → Stored @ ${res.location.barcode}`);
    $('#storeBin').value = '';
    $('#storeLoc').value = '';
    loadWarehouse();
  } catch (e) {
    toast(e.message, true);
  }
});

$('#scanOutSubmit').addEventListener('click', async () => {
  const bin = $('#scanOutBin').value.trim().toUpperCase();
  if (!bin) return toast('Enter a bin barcode', true);
  try {
    const res = await api.post(`/bins/${bin}/scan-out`, {});
    toast(`${res.bin.barcode} → ${res.bin.status}` + (res.freedLocation ? ` (freed ${res.freedLocation.barcode})` : ''));
    $('#scanOutBin').value = '';
    loadWarehouse();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---- explorer ---------------------------------------------------------------
$('#explorerSearch').addEventListener('click', searchBin);
$('#explorerBarcode').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchBin(); });

async function searchBin() {
  const bc = $('#explorerBarcode').value.trim().toUpperCase();
  const box = $('#explorerResult');
  if (!bc) return;
  try {
    const { bin, movements } = await api.get(`/bins/${bc}/movements`);
    const rows = movements
      .map(
        (m) => `<li>
          <div>${m.from_status || '(unassigned)'} → <strong>${m.to_status}</strong>
            ${m.location ? `<span class="muted">@ ${m.location.barcode}</span>` : ''}
            <span class="status-pill">${m.actor}</span></div>
          <div class="ts">${new Date(m.ts).toLocaleString()}</div>
        </li>`
      )
      .join('');
    box.innerHTML = `
      <div><strong>${bin.barcode}</strong> · ${bin.sku_type} · current: <span class="summary">${bin.status || 'unassigned'}</span></div>
      <ul class="timeline" style="margin-top:10px;">${rows || '<li class="muted">No movements yet.</li>'}</ul>`;
  } catch (e) {
    box.innerHTML = `<div class="muted">${e.message}</div>`;
  }
}

// ---- boot -------------------------------------------------------------------
loadQueue();
