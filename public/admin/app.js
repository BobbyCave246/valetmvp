// Admin / warehouse console. All state lives in the API — this file only
// renders responses and POSTs actions. Nothing touches a DB directly.

// A lost session (expired cookie) surfaces as 401/403 — bounce to login.
function guard401(r) {
  if (r.status === 401 || r.status === 403) Session.onUnauthorized();
}
const api = {
  async get(path) {
    const r = await fetch(`/api${path}`, { credentials: 'same-origin' });
    if (!r.ok) { guard401(r); throw new Error((await r.json().catch(() => ({}))).error || r.statusText); }
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { guard401(r); throw new Error(data.error || r.statusText); }
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
// Context handed from a queue card's action button to the destination tab.
let pendingAssign = null;     // { bookingId }
let pendingWarehouse = null;  // { binBarcode, mode: 'store' | 'scanout' }

function activeTab() {
  return document.querySelector('nav button.active').dataset.tab;
}

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    refreshTab(btn.dataset.tab);
  });
});

// Programmatically switch tabs, optionally passing context for the destination.
function switchTab(name, ctx = {}) {
  if (name === 'assign') pendingAssign = ctx;
  if (name === 'warehouse') pendingWarehouse = ctx;
  [...document.querySelectorAll('nav button')].find((b) => b.dataset.tab === name)?.click();
}

function refreshTab(tab) {
  if (tab === 'queue') loadQueue();
  if (tab === 'assign') loadAssign();
  if (tab === 'warehouse') loadWarehouse();
  if (tab === 'leads') loadLeads();
  if (tab === 'settings') loadSettings();
  if (tab === 'staff') loadStaff();
}

// ---- queue filters ----------------------------------------------------------
let queueBookingsCache = [];
let queueJobsCache = [];
let queueFilter = 'all';
let queueSearch = '';
let queueSort = 'delivery';

$('#queueSearch')?.addEventListener('input', (e) => {
  queueSearch = e.target.value.trim().toLowerCase();
  renderQueueFromCache();
});
$('#queueSort')?.addEventListener('change', (e) => {
  queueSort = e.target.value;
  renderQueueFromCache();
});
document.querySelectorAll('#queueFilters .chip-filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#queueFilters .chip-filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    queueFilter = btn.dataset.filter;
    renderQueueFromCache();
  });
});

function bookingFilterKind(b) {
  const na = b.nextAction?.kind;
  if (na === 'assign') return 'assign';
  if (na === 'wait' || na === 'idle') return 'wait';
  if (na === 'job' || na === 'warehouse') return 'jobs';
  if (na === 'done') return 'done';
  if (b.summary?.counts?.Stored) return 'stored';
  return 'all';
}

function bookingMatchesSearch(b, jobs) {
  if (!queueSearch) return true;
  const hay = [
    b.id,
    b.customer?.name,
    b.customer?.phone,
    b.customer?.address,
    b.delivery_date,
    b.summary?.text,
    ...(jobs || []).flatMap((j) => (j.bins || []).map((bin) => bin.barcode)),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(queueSearch);
}

function sortBookings(list) {
  const copy = [...list];
  if (queueSort === 'newest') {
    copy.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  } else if (queueSort === 'urgency') {
    const rank = { assign: 0, job: 1, warehouse: 2, wait: 3, idle: 4, done: 5 };
    copy.sort((a, b) => (rank[a.nextAction?.kind] ?? 9) - (rank[b.nextAction?.kind] ?? 9));
  } else {
    copy.sort((a, b) => (a.delivery_date || '').localeCompare(b.delivery_date || ''));
  }
  return copy;
}

function skuProgress(b) {
  const breakdown = b.sku_breakdown || {};
  const assigned = b.assignedCount || 0;
  const total = b.bin_count || 0;
  const pct = total ? Math.round((assigned / total) * 100) : 0;
  return `<div class="sku-progress" title="${assigned} of ${total} bins assigned"><div class="sku-progress-bar" style="width:${pct}%"></div></div>`;
}

// ---- reset ------------------------------------------------------------------
$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('Wipe all data and re-seed the demo?')) return;
  await api.post('/admin/reset');
  toast('Demo reset to seed data');
  loadStats();
  refreshTab(document.querySelector('nav button.active').dataset.tab);
});

// ---- dashboard stats bar ----------------------------------------------------
async function loadStats() {
  try {
    const s = await api.get('/stats');
    const bs = s.bins.byStatus;
    const inTransit = (bs['In transit (inbound)'] || 0) + (bs['In transit (outbound)'] || 0);
    const withCustomer =
      (bs['Out for filling'] || 0) + (bs['Returned to customer'] || 0);
    const tiles = [
      ['Bins', s.bins.total],
      ['Stored', bs['Stored'] || 0],
      ['Out for filling', bs['Out for filling'] || 0],
      ['In transit', inTransit],
      ['With customer', withCustomer],
      ['Rack', `${s.locations.occupied}/${s.locations.total} · ${s.locations.occupancyPct}%`],
      ['Bookings', s.bookings.total],
      ['Jobs scheduled', s.jobs.scheduled],
    ];
    $('#statsBar').innerHTML = tiles
      .map(([label, val]) => `<div class="stat"><div class="stat-val">${val}</div><div class="stat-label">${label}</div></div>`)
      .join('');
  } catch {
    /* stats are non-critical; ignore transient failures */
  }
}

// ---- queue ------------------------------------------------------------------
async function loadQueue() {
  const [bookings, allJobs] = await Promise.all([api.get('/bookings'), api.get('/jobs')]);
  queueBookingsCache = bookings;
  queueJobsCache = allJobs;
  renderQueueFromCache();
}

function renderQueueFromCache() {
  const list = $('#queueList');
  const jobsByBooking = {};
  for (const j of queueJobsCache) (jobsByBooking[j.booking_id] ||= []).push(j);

  let bookings = queueBookingsCache.filter((b) => {
    if (queueFilter !== 'all' && bookingFilterKind(b) !== queueFilter) return false;
    return bookingMatchesSearch(b, jobsByBooking[b.id]);
  });
  bookings = sortBookings(bookings);

  if (bookings.length === 0) {
    list.innerHTML = '<div class="empty">No bookings match your filters.</div>';
    return;
  }

  list.innerHTML = '';
  for (const b of bookings) {
    const sku = Object.entries(b.sku_breakdown || {}).map(([k, v]) => `${v} ${k}`).join(', ');
    const assignBadge = `<span class="badge ${b.assignedCount < b.bin_count ? 'warn' : 'ok'}">${b.assignedCount} of ${b.bin_count} assigned</span>`;
    const phoneLink = b.customer?.phone
      ? `<a href="tel:${esc(b.customer.phone)}" class="contact-link">${esc(b.customer.phone)}</a>`
      : '';
    const card = el(`
      <div class="card">
        <div class="row">
          <div>
            <div><strong>${esc(b.customer?.name || 'Unknown')}</strong> · ${esc(b.bin_count)} bins <span class="muted">(${esc(sku)})</span> ${assignBadge}</div>
            <div class="muted">${phoneLink}${b.customer?.address ? ` · ${esc(b.customer.address)}` : ''}</div>
            <div class="muted">Delivery: ${esc(b.delivery_date)}${b.delivery_slot ? ' · ' + esc(slotLabel(b.delivery_slot)) : ''} · ref <code>${esc(b.id)}</code> · <a href="#" class="cancel-link" style="color:#b91c1c;">cancel booking</a></div>
            ${skuProgress(b)}
            <div class="summary" style="margin-top:6px;">${esc(b.summary.text)}</div>
          </div>
          <div class="next-action"></div>
        </div>
        <div class="booking-jobs"></div>
      </div>
    `);
    card.querySelector('.next-action').appendChild(nextActionControl(b));

    card.querySelector('.cancel-link').addEventListener('click', async (e) => {
      e.preventDefault();
      const n = b.assignedCount || 0;
      if (!confirm(`Cancel booking ${b.id}?\nThis deletes its jobs and releases ${n} assigned bin${n === 1 ? '' : 's'} back to inventory.`)) return;
      try {
        const res = await api.post(`/bookings/${b.id}/cancel`, {});
        toast(`Booking cancelled — ${res.releasedBins} bin${res.releasedBins === 1 ? '' : 's'} released`);
        loadQueue();
        loadStats();
      } catch (err) {
        toast(err.message, true);
      }
    });

    // Nested jobs for this booking (open first, then a collapsed Done set).
    const jobsBox = card.querySelector('.booking-jobs');
    const jobs = jobsByBooking[b.id] || [];
    const open = jobs.filter((j) => j.status !== 'Done');
    const done = jobs.filter((j) => j.status === 'Done');
    const nextJobId = b.nextAction?.kind === 'job' ? b.nextAction.jobId : null;
    open.forEach((j) => jobsBox.appendChild(jobCard(j, false, nextJobId)));
    if (done.length) {
      const details = el(`<details class="done-group"><summary>${done.length} done</summary></details>`);
      done.forEach((j) => details.appendChild(jobCard(j, true)));
      jobsBox.appendChild(details);
    }
    list.appendChild(card);
  }
}

// Renders the contextual "next step" control for a queue card from b.nextAction.
function nextActionControl(b) {
  const na = b.nextAction || { kind: 'idle', label: '' };
  if (na.kind === 'assign') {
    // Primary path: one-click auto-assign matching free bins. Manual is a fallback.
    const wrap = document.createElement('div');
    wrap.className = 'action-stack';
    wrap.appendChild(
      mkActionBtn('btn', 'Auto-assign bins', async () => {
        const res = await api.post(`/bookings/${b.id}/auto-assign`, {});
        const n = res.assigned.length;
        toast(n ? `Reserved ${n} bin${n === 1 ? '' : 's'} — pick list shown below` : 'Nothing to assign');
        const short = Object.entries(res.shortages || {});
        if (short.length) {
          toast(`Short ${short.map(([s, n]) => `${n} ${s}`).join(', ')} — restock or assign manually`, true);
        }
        loadQueue();
        loadStats();
      })
    );
    const manual = el('<a href="#" class="manual-link">assign manually</a>');
    manual.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab('assign', { bookingId: b.id });
    });
    wrap.appendChild(manual);
    return wrap;
  }
  if (na.kind === 'job' && na.jobId) {
    return mkActionBtn('btn green', na.label, async () => {
      await api.post(`/jobs/${na.jobId}/done`, {});
      toast(`Done — ${na.label}`);
      loadQueue();
      loadStats();
    });
  }
  if (na.kind === 'warehouse') {
    return mkActionBtn('btn', na.label, () =>
      switchTab('warehouse', { binBarcode: na.binBarcode, mode: na.mode })
    );
  }
  // wait / idle / done — no action, just a muted hint.
  const span = document.createElement('span');
  span.className = 'muted';
  span.textContent = na.label;
  return span;
}

function mkActionBtn(cls, label, onClick) {
  const btn = el(`<button class="${cls}">${label}</button>`);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await onClick(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  });
  return btn;
}

// ---- assign -----------------------------------------------------------------
let assignSelected = new Set();
let availableSku = {};      // barcode → sku_type, for SKU reconciliation
let assignBookingDetail = null;

async function loadAssign() {
  assignSelected = new Set();
  const select = $('#assignBooking');
  const bookings = await api.get('/bookings');
  select.innerHTML = bookings
    .map((b) => `<option value="${esc(b.id)}">${esc(b.customer?.name)} — ${esc(b.bin_count)} bins — ${esc(b.delivery_date)}</option>`)
    .join('');

  // Honour a booking preselected from a queue card's "Assign bins" button.
  if (pendingAssign?.bookingId) {
    select.value = pendingAssign.bookingId;
    pendingAssign = null;
  }

  await renderAvailableBins();
  renderAssignSelected();
  await updateAssignSummary();
}

$('#assignBooking').addEventListener('change', updateAssignSummary);

async function updateAssignSummary() {
  const id = $('#assignBooking').value;
  if (!id) return ($('#assignSummary').innerHTML = '');
  assignBookingDetail = await api.get(`/bookings/${id}`);
  renderReconcile();
}

// SKU-aware reconciliation: what the booking still needs vs what's selected.
function renderReconcile() {
  const box = $('#assignSummary');
  if (!assignBookingDetail) return (box.innerHTML = '');

  const breakdown = assignBookingDetail.sku_breakdown || {};
  const assignedBySku = tallyBySku((assignBookingDetail.bins || []).map((b) => b.sku_type));
  const needed = {};
  for (const [sku, n] of Object.entries(breakdown)) {
    needed[sku] = Math.max(0, n - (assignedBySku[sku] || 0));
  }
  const selectedBySku = tallyBySku([...assignSelected].map((bc) => availableSku[bc] || '?'));

  const fmt = (obj) =>
    Object.entries(obj).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
  const totalNeeded = Object.values(needed).reduce((a, b) => a + b, 0);
  const cls = assignSelected.size > totalNeeded ? 'over' : assignSelected.size === totalNeeded && totalNeeded > 0 ? 'ok' : '';

  box.innerHTML = `
    <div>${esc(assignBookingDetail.summary.text)}</div>
    <div class="muted" style="margin-top:4px;">Still needs: <strong>${esc(fmt(needed))}</strong></div>
    <div class="reconcile ${cls}">Selected: <strong>${esc(fmt(selectedBySku))}</strong> (${assignSelected.size}/${totalNeeded})</div>`;
}

function tallyBySku(skus) {
  const out = {};
  for (const s of skus) out[s] = (out[s] || 0) + 1;
  return out;
}

async function renderAvailableBins() {
  const bins = await api.get('/bins/available');
  availableSku = {};
  const box = $('#availableBins');
  if (bins.length === 0) {
    box.innerHTML = '<span class="muted">No unassigned bins left.</span>';
    return;
  }
  box.innerHTML = '';
  bins.forEach((bin) => {
    availableSku[bin.barcode] = bin.sku_type;
    const chip = el(`<span class="chip" data-barcode="${esc(bin.barcode)}">${esc(bin.barcode)} <span class="muted">${esc(bin.sku_type)}</span></span>`);
    if (assignSelected.has(bin.barcode)) chip.classList.add('selected');
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
  renderReconcile();
}

function renderAssignSelected() {
  const box = $('#assignSelected');
  if (assignSelected.size === 0) {
    box.innerHTML = '<span class="muted">none selected</span>';
    return;
  }
  box.innerHTML = '';
  [...assignSelected].forEach((bc) => {
    const chip = el(`<span class="chip selected">${esc(bc)} ✕</span>`);
    chip.addEventListener('click', () => {
      assignSelected.delete(bc);
      renderAssignSelected();
      renderAvailableBins();
      renderReconcile();
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
  renderReconcile();
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

// ---- jobs (rendered nested inside each booking card) ------------------------
const JOB_LABEL = {
  deliver_empty: 'Deliver empty bins',
  collect_full: 'Collect filled bins',
  deliver_back: 'Deliver bins back',
};

// Delivery-window labels — fallbacks refreshed from the API at boot so the
// backend (src/slots.js) stays the single source of truth.
let SLOT_LABELS = { am: 'Morning (8am–12pm)', pm: 'Afternoon (12–5pm)' };
(async () => {
  try {
    const data = await api.get('/serviceability');
    if (Array.isArray(data.slots)) {
      SLOT_LABELS = Object.fromEntries(data.slots.map((s) => [s.key, s.label]));
    }
  } catch { /* fallback labels stand */ }
})();
const slotLabel = (key) => (key ? SLOT_LABELS[key] || key : '');

const TODAY = new Date().toISOString().slice(0, 10);

function jobCard(j, isDone, primaryJobId = null) {
  const todayPill = j.scheduled_date === TODAY ? '<span class="pill-today">Today</span>' : '';
  const bins = j.bins || [];
  const pickLabel = j.type === 'deliver_empty' ? 'Pick list — collect these empties' : 'Bins';
  const picklist = bins.length
    ? `<div class="picklist"><div class="picklist-head">${pickLabel}</div>${bins
        .map((b) => `<span class="pick"><code>${esc(b.barcode)}</code> <span class="muted">${esc(b.sku_type)}</span></span>`)
        .join('')}</div>`
    : '';
  const card = el(`
    <div class="job-item">
      <div class="row">
        <div>
          <div><strong>${esc(JOB_LABEL[j.type] || j.type)}</strong> <span class="status-pill">${esc(j.status)}</span> ${todayPill}</div>
          <div class="muted">date ${esc(j.scheduled_date || '—')}${j.scheduled_slot ? ' · ' + esc(slotLabel(j.scheduled_slot)) : ''} · ${(j.bin_ids || []).length} bins</div>
          ${picklist}
        </div>
        <div></div>
      </div>
    </div>
  `);
  if (!isDone && j.id !== primaryJobId) {
    const btn = el(`<button class="btn ghost btn-sm">Mark done</button>`);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await api.post(`/jobs/${j.id}/done`, {});
        toast(`Done — bins now ${res.advanced[0]?.status}`);
        loadQueue();
        loadStats();
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
      }
    });
    card.querySelector('.row > div:last-child').appendChild(btn);
  } else if (!isDone && j.id === primaryJobId) {
    const hint = el('<span class="muted" style="font-size:12px;">Use next action →</span>');
    card.querySelector('.row > div:last-child').appendChild(hint);
  }
  return card;
}

// ---- warehouse --------------------------------------------------------------
async function loadWarehouse() {
  // Prefill a bin barcode handed over from a queue card's warehouse action.
  if (pendingWarehouse?.binBarcode) {
    const field = pendingWarehouse.mode === 'scanout' ? '#scanOutBin' : '#storeBin';
    $(field).value = pendingWarehouse.binBarcode;
    pendingWarehouse = null;
  }
  renderRackMap();
}

// Visual rack map: a tile per slot, grouped by aisle (parsed from the
// aisle-bay-level-position barcode, e.g. A-01-1-01). Free slots are clickable.
async function renderRackMap() {
  const locations = await api.get('/locations');
  const map = $('#rackMap');
  map.innerHTML = '';

  const byAisle = {};
  for (const loc of locations) {
    const aisle = (loc.barcode.split('-')[0]) || '?';
    (byAisle[aisle] ||= []).push(loc);
  }

  Object.keys(byAisle).sort().forEach((aisle) => {
    map.appendChild(el(`<div class="aisle-head">Aisle ${esc(aisle)}</div>`));
    const grid = el('<div class="rack-grid"></div>');
    byAisle[aisle].forEach((loc) => {
      const occ = !!loc.occupied;
      const slot = el(`
        <div class="slot ${occ ? 'occ' : 'free'}">
          <div class="slot-code">${esc(loc.barcode)}</div>
          ${occ ? `<div class="slot-occupant">${esc(loc.bin_barcode || 'occupied')}</div>` : '<div class="slot-free">free</div>'}
          <div class="slot-bc">${window.Barcode ? Barcode.svg(loc.barcode, { height: 22, moduleWidth: 1 }) : ''}</div>
        </div>`);
      if (!occ) {
        slot.addEventListener('click', () => {
          $('#storeLoc').value = loc.barcode;
          map.querySelectorAll('.slot.sel').forEach((s) => s.classList.remove('sel'));
          slot.classList.add('sel');
        });
      }
      grid.appendChild(slot);
    });
    map.appendChild(grid);
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

$('#intakeSubmit').addEventListener('click', async () => {
  const barcode = $('#intakeBarcode').value.trim().toUpperCase();
  const skuType = $('#intakeSku').value;
  if (!barcode) return toast('Enter a barcode', true);
  try {
    await api.post('/bins', { barcode, skuType });
    toast(`Added ${barcode} (${skuType})`);
    $('#intakeBarcode').value = '';
    loadStats();
    if (activeTab() === 'assign') loadAssign();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---- leads ------------------------------------------------------------------
let leadsCache = [];

async function loadLeads() {
  const box = $('#leadsList');
  try {
    leadsCache = await api.get('/leads');
    if (!leadsCache.length) {
      box.innerHTML = '<div class="empty">No waitlist signups yet.</div>';
      return;
    }
    box.innerHTML = leadsCache
      .map(
        (l) => `<div class="bin-row">
          <div><strong>${esc(l.email)}</strong>${l.area ? ` <span class="muted">${esc(l.area)}</span>` : ' <span class="muted">(area not listed)</span>'}</div>
          <div class="muted">${new Date(l.created_at).toLocaleString()}</div>
        </div>`
      )
      .join('');
  } catch (e) {
    box.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

$('#leadsExport')?.addEventListener('click', () => {
  if (!leadsCache.length) return toast('No leads to export', true);
  const rows = [['email', 'area', 'created_at'], ...leadsCache.map((l) => [l.email, l.area || '', l.created_at])];
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'leads.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---- settings ---------------------------------------------------------------
async function loadSettings() {
  const box = $('#settingsPanel');
  try {
    const cfg = await api.get('/admin/config');
    box.innerHTML = `
      <dl class="settings-dl">
        <dt>Coverage areas</dt><dd>${esc(cfg.coverageAreas.join(', '))}</dd>
        <dt>Villages</dt><dd>${esc(cfg.villages.join(', '))}</dd>
        <dt>Delivery windows</dt><dd>${esc(cfg.slots.map((s) => s.label).join(' · '))}</dd>
        <dt>Slot capacity</dt><dd>${esc(String(cfg.slotCapacity))} deliveries per window per day</dd>
        <dt>Lead days</dt><dd>${esc(String(cfg.leadDays))} day(s) minimum before first delivery</dd>
      </dl>`;
  } catch (e) {
    box.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

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
          <div>${esc(m.from_status || '(unassigned)')} → <strong>${esc(m.to_status || '(released — booking cancelled)')}</strong>
            ${m.location ? `<span class="muted">@ ${esc(m.location.barcode)}</span>` : ''}
            <span class="status-pill">${esc(m.actor)}</span></div>
          <div class="ts">${new Date(m.ts).toLocaleString()}</div>
        </li>`
      )
      .join('');
    const photo =
      bin.photo_ref && bin.photo_ref.startsWith('data:image/')
        ? `<img class="thumb" src="${esc(bin.photo_ref)}" alt="contents photo" />`
        : bin.photo_ref
        ? '<div class="muted">📷 photo on file</div>'
        : '';
    const barcode = window.Barcode ? Barcode.svg(bin.barcode, { height: 40, moduleWidth: 2 }) : '';
    box.innerHTML = `
      <div><strong>${esc(bin.barcode)}</strong> · ${esc(bin.sku_type)} · current: <span class="summary">${esc(bin.status || 'unassigned')}</span></div>
      <div class="bc-block">${barcode}</div>
      ${photo}
      <ul class="timeline" style="margin-top:10px;">${rows || '<li class="muted">No movements yet.</li>'}</ul>`;
  } catch (e) {
    box.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

// ---- camera scan buttons ------------------------------------------------------
// Each .scan-btn fills its data-target input via the shared camera scanner and,
// if data-then names a button, clicks it (e.g. auto-run the explorer search).
document.querySelectorAll('.scan-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const code = await Scanner.scan({ title: 'Scan a barcode' });
    if (!code) return;
    const input = document.getElementById(btn.dataset.target);
    input.value = code;
    if (btn.dataset.then) document.getElementById(btn.dataset.then).click();
  });
});

// ---- staff accounts ----------------------------------------------------------
const ROLE_LABEL = { admin: 'Admin', warehouse: 'Warehouse', driver: 'Driver' };

async function loadStaff() {
  const box = $('#staffList');
  try {
    const users = await api.get('/auth/users');
    if (!users.length) { box.innerHTML = '<div class="empty">No staff yet.</div>'; return; }
    box.innerHTML = users
      .map(
        (u) => `<div class="bin-row">
          <div><strong>${esc(u.email)}</strong> ${u.name ? `<span class="muted">${esc(u.name)}</span>` : ''}</div>
          <div><span class="badge ok">${esc(ROLE_LABEL[u.role] || u.role)}</span></div>
        </div>`
      )
      .join('');
  } catch (e) {
    box.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

$('#staffCreate').addEventListener('click', async () => {
  const payload = {
    email: $('#staffEmail').value.trim(),
    name: $('#staffName').value.trim(),
    role: $('#staffRole').value,
    password: $('#staffPassword').value,
  };
  if (!payload.email || !payload.password) return toast('Email and password are required', true);
  try {
    const res = await api.post('/auth/users', payload);
    toast(`Created ${res.user.email} — share credentials securely`);
    $('#staffEmail').value = '';
    $('#staffName').value = '';
    $('#staffPassword').value = '';
    loadStaff();
  } catch (e) {
    toast(e.message, true);
  }
});

$('#staffPwToggle')?.addEventListener('click', () => {
  const input = $('#staffPassword');
  const btn = $('#staffPwToggle');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Hide' : 'Show';
});

// ---- polling ----------------------------------------------------------------
setInterval(() => {
  if (document.hidden) return;
  loadStats();
  const tab = activeTab();
  if (tab === 'queue') loadQueue();
  else if (tab === 'assign') {
    renderAvailableBins().catch(() => {});
    if ($('#assignBooking').value) updateAssignSummary().catch(() => {});
  } else if (tab === 'warehouse') renderRackMap().catch(() => {});
}, 4000);

// ---- boot -------------------------------------------------------------------
// Gate on a signed-in admin first; Session.guard redirects anyone else.
Session.guard('admin').then(() => {
  loadStats();
  loadQueue();
});
