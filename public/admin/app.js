// Admin supervisor console. Orchestrates bookings and field work — warehouse
// scanning and job completion happen in the dedicated staff apps.

const VALID_TABS = ['queue', 'assign', 'dispatch', 'customers', 'explorer', 'inventory', 'leads', 'config', 'staff'];

let pendingAssign = null;
let pendingExplorerBarcode = null;
let pendingCustomerSearch = null;
let pendingQueueFocus = null;

// ---- hash routing -----------------------------------------------------------
function parseHash() {
  const raw = location.hash.slice(1) || 'queue';
  const qIdx = raw.indexOf('?');
  const tab = (qIdx === -1 ? raw : raw.slice(0, qIdx)).trim();
  const params = new URLSearchParams(qIdx === -1 ? '' : raw.slice(qIdx + 1));
  return { tab: VALID_TABS.includes(tab) ? tab : 'queue', params };
}

function setHash(tab, params = {}) {
  const qs = new URLSearchParams(params);
  const q = qs.toString();
  const next = q ? `${tab}?${q}` : tab;
  if (location.hash.slice(1) !== next) location.hash = next;
}

function applyHashContext(tab, params) {
  if (tab === 'assign' && params.get('booking')) pendingAssign = { bookingId: params.get('booking') };
  if (tab === 'explorer' && params.get('barcode')) pendingExplorerBarcode = params.get('barcode').toUpperCase();
  if (tab === 'customers' && params.get('q')) pendingCustomerSearch = params.get('q');
}

function activeTab() {
  return document.querySelector('nav button.active')?.dataset.tab || 'queue';
}

function showTab(tab) {
  document.querySelectorAll('nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.id === `tab-${tab}`);
  });
}

function applyRoute() {
  const { tab, params } = parseHash();
  applyHashContext(tab, params);
  showTab(tab);
  refreshTab(tab);
}

function switchTab(name, ctx = {}, params = {}) {
  if (name === 'assign' && ctx.bookingId) {
    pendingAssign = ctx;
    params.booking = ctx.bookingId;
  }
  if (name === 'explorer' && ctx.barcode) {
    pendingExplorerBarcode = ctx.barcode;
    params.barcode = ctx.barcode;
  }
  if (name === 'queue' && ctx.jobId) pendingQueueFocus = { bookingId: ctx.bookingId, jobId: ctx.jobId };
  if (name === 'customers' && ctx.q) {
    pendingCustomerSearch = ctx.q;
    params.q = ctx.q;
  }
  const before = location.hash.slice(1);
  setHash(name, params);
  if (location.hash.slice(1) === before) applyRoute();
}

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => setHash(btn.dataset.tab));
});

window.addEventListener('hashchange', applyRoute);

function refreshTab(tab) {
  if (tab === 'queue') loadQueue();
  if (tab === 'assign') loadAssign();
  if (tab === 'dispatch') loadDispatch();
  if (tab === 'customers') loadCustomers();
  if (tab === 'explorer') loadExplorer();
  if (tab === 'inventory') loadInventory();
  if (tab === 'leads') loadLeads();
  if (tab === 'config') loadConfig();
  if (tab === 'staff') loadStaff();
}

// ---- reset ------------------------------------------------------------------
$('#resetBtn').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Reset demo data',
    message: 'Wipe all operational data and re-seed the demo? Staff accounts are preserved.',
    confirmLabel: 'Reset demo',
    danger: true,
  });
  if (!ok) return;
  await api.post('/admin/reset');
  toast('Demo reset to seed data');
  loadStats();
  refreshTab(activeTab());
});

// ---- dashboard stats --------------------------------------------------------
async function loadStats() {
  try {
    const s = await api.get('/stats');
    const bs = s.bins.byStatus;
    const inTransit = (bs['In transit (inbound)'] || 0) + (bs['In transit (outbound)'] || 0);
    const withCustomer = (bs['Out for filling'] || 0) + (bs['Returned to customer'] || 0);
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
    /* non-critical */
  }
}

// ---- queue ------------------------------------------------------------------
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
  if (na === 'done') return 'done';
  if (na === 'job' || na === 'warehouse') return 'jobs';
  if (b.summary?.counts?.Stored) return 'stored';
  if (na === 'wait' || na === 'idle') return 'wait';
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
  const assigned = b.assignedCount || 0;
  const total = b.bin_count || 0;
  const pct = total ? Math.round((assigned / total) * 100) : 0;
  return `<div class="sku-progress" title="${assigned} of ${total} bins assigned"><div class="sku-progress-bar" style="width:${pct}%"></div></div>`;
}

async function loadQueue() {
  await refreshServiceToday();
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
    const msg =
      queueBookingsCache.length === 0
        ? 'No bookings yet. Create one on the booking site.'
        : 'No bookings match your filters.';
    list.innerHTML = `<div class="empty">${msg}</div>`;
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
      <div class="card" data-booking-id="${esc(b.id)}">
        <div class="row">
          <div>
            <div><strong>${esc(b.customer?.name || 'Unknown')}</strong> · ${esc(b.bin_count)} bins <span class="muted">(${esc(sku)})</span> ${assignBadge}</div>
            <div class="muted">${phoneLink}${b.customer?.address ? ` · ${esc(b.customer.address)}` : ''}</div>
            <div class="muted">Delivery: ${esc(b.delivery_date)}${b.delivery_slot ? ' · ' + esc(slotLabel(b.delivery_slot)) : ''} · ref <code>${esc(b.id)}</code> · <a href="#" class="cancel-link">${b.assignedCount === 0 ? 'cancel unassigned booking' : 'cancel booking'}</a></div>
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
      const unassigned = n === 0;
      const msg = unassigned
        ? `Cancel unassigned booking ${b.id}? This deletes the booking and its delivery job (no bins to release).`
        : `Cancel booking ${b.id}? This deletes its jobs and releases ${n} assigned bin${n === 1 ? '' : 's'} back to inventory.`;
      const ok = await confirmDialog({
        title: unassigned ? 'Cancel unassigned booking' : 'Cancel booking',
        message: msg,
        confirmLabel: 'Cancel booking',
        danger: true,
      });
      if (!ok) return;
      try {
        const path = unassigned ? `/bookings/${b.id}/cancel-unassigned` : `/bookings/${b.id}/cancel`;
        const res = await api.post(path, {});
        toast(unassigned ? 'Unassigned booking cancelled' : `Booking cancelled — ${res.releasedBins} bin${res.releasedBins === 1 ? '' : 's'} released`);
        loadQueue();
        loadStats();
      } catch (err) {
        toast(err.message, true);
      }
    });

    const jobsBox = card.querySelector('.booking-jobs');
    const jobs = jobsByBooking[b.id] || [];
    const open = jobs.filter((j) => j.status !== 'Done');
    const done = jobs.filter((j) => j.status === 'Done');
    open.forEach((j) => jobsBox.appendChild(jobCard(j, false)));
    if (done.length) {
      const details = el(`<details class="done-group"><summary>${done.length} done</summary></details>`);
      done.forEach((j) => details.appendChild(jobCard(j, true)));
      jobsBox.appendChild(details);
    }
    list.appendChild(card);
  }
  applyQueueFocus();
}

function applyQueueFocus() {
  if (!pendingQueueFocus) return;
  const { bookingId, jobId } = pendingQueueFocus;
  pendingQueueFocus = null;
  requestAnimationFrame(() => {
    const card = document.querySelector(`[data-booking-id="${bookingId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      card.classList.add('queue-focus');
      setTimeout(() => card.classList.remove('queue-focus'), 2400);
    }
    const jobEl = document.querySelector(`[data-job-id="${jobId}"]`);
    if (jobEl) {
      jobEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      jobEl.classList.add('job-focus');
      setTimeout(() => jobEl.classList.remove('job-focus'), 2400);
    }
  });
}

function nextActionControl(b) {
  const na = b.nextAction || { kind: 'idle', label: '' };
  if (na.kind === 'assign') {
    const wrap = document.createElement('div');
    wrap.className = 'action-stack';
    wrap.appendChild(mkActionBtn('btn', na.label, () => switchTab('assign', { bookingId: b.id })));
    const auto = el('<a href="#" class="manual-link">auto-assign</a>');
    auto.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const res = await api.post(`/bookings/${b.id}/auto-assign`, {});
        const n = res.assigned.length;
        toast(n ? `Reserved ${n} bin${n === 1 ? '' : 's'} — pick list shown below` : 'Nothing to assign');
        const short = Object.entries(res.shortages || {});
        if (short.length) {
          toast(`Short ${short.map(([s, c]) => `${c} ${s}`).join(', ')} — restock or assign manually`, true);
        }
        loadQueue();
        loadStats();
      } catch (err) {
        toast(err.message, true);
      }
    });
    wrap.appendChild(auto);
    return wrap;
  }
  if (na.kind === 'job' && na.jobId) {
    const wrap = document.createElement('div');
    wrap.className = 'action-stack';
    const link = el(`<a class="btn green" href="${esc(driverFieldUrl({ jobId: na.jobId }))}" ${FIELD_LINK_ATTRS}>${esc(na.label)} ↗</a>`);
    wrap.appendChild(link);
    const focus = el('<a href="#" class="manual-link">show in queue</a>');
    focus.addEventListener('click', (e) => {
      e.preventDefault();
      pendingQueueFocus = { bookingId: b.id, jobId: na.jobId };
      applyQueueFocus();
    });
    wrap.appendChild(focus);
    return wrap;
  }
  if (na.kind === 'job') {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = `${na.label} — no scheduled job found`;
    return span;
  }
  if (na.kind === 'warehouse') {
    const wrap = document.createElement('div');
    wrap.className = 'action-stack';
    const url = warehouseFieldUrl({ mode: na.mode, binBarcode: na.binBarcode });
    wrap.appendChild(el(`<a class="btn" href="${esc(url)}" ${FIELD_LINK_ATTRS}>${esc(na.label)} ↗</a>`));
    if (na.mode === 'scanout') {
      const cancel = el('<a href="#" class="manual-link">cancel retrieval</a>');
      cancel.addEventListener('click', async (e) => {
        e.preventDefault();
        const ok = await confirmDialog({
          title: 'Cancel retrieval',
          message: `Cancel retrieval for bin ${na.binBarcode}? It will return to Stored.`,
          confirmLabel: 'Cancel retrieval',
          danger: true,
        });
        if (!ok) return;
        try {
          const detail = await api.get(`/bookings/${b.id}`);
          const bin = (detail.bins || []).find((x) => x.barcode === na.binBarcode);
          if (!bin) return toast('Bin not found on this booking', true);
          await api.post(`/bookings/${b.id}/cancel-retrieval`, { binIds: [bin.id] });
          toast('Retrieval cancelled — bin back in storage');
          loadQueue();
          loadStats();
        } catch (err) {
          toast(err.message, true);
        }
      });
      wrap.appendChild(cancel);
    }
    return wrap;
  }
  if (na.kind === 'wait' && b.summary?.counts?.['Out for filling']) {
    const wrap = document.createElement('div');
    wrap.className = 'action-stack';
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = na.label;
    wrap.appendChild(span);
    const noShow = el('<a href="#" class="manual-link">mark no-show</a>');
    noShow.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const detail = await api.get(`/bookings/${b.id}`);
        const candidates = (detail.bins || []).filter((bin) => bin.status === 'Out for filling');
        if (!candidates.length) return toast('No bins out for filling on this booking', true);
        const barcode = await pickDialog({
          title: 'Mark no-show',
          message: 'Select the bin the customer never filled:',
          options: candidates.map((bin) => ({ label: `${bin.barcode} (${bin.sku_type})`, value: bin.barcode })),
        });
        if (!barcode) return;
        await api.post(`/bins/${encodeURIComponent(barcode)}/no-show`, {});
        toast('Bin marked no-show — released to inventory');
        loadQueue();
        loadStats();
      } catch (err) {
        toast(err.message, true);
      }
    });
    wrap.appendChild(noShow);
    return wrap;
  }
  const span = document.createElement('span');
  span.className = 'muted';
  span.textContent = na.label;
  return span;
}

function mkActionBtn(cls, label, onClick) {
  const btn = el(`<button class="${cls}">${label}</button>`);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await onClick();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

function jobCard(j, isDone) {
  const todayPill = j.scheduled_date === serviceToday() ? '<span class="pill-today">Today</span>' : '';
  const bins = j.bins || [];
  const pickLabel = j.type === 'deliver_empty' ? 'Pick list — collect these empties' : 'Bins';
  const picklist = bins.length
    ? `<div class="picklist"><div class="picklist-head">${pickLabel}</div>${bins
        .map((b) => `<span class="pick"><code>${esc(b.barcode)}</code> <span class="muted">${esc(b.sku_type)}</span></span>`)
        .join('')}</div>`
    : '';
  const card = el(`
    <div class="job-item" data-job-id="${esc(j.id)}">
      <div class="row">
        <div>
          <div><strong>${esc(JOB_LABEL[j.type] || j.type)}</strong> <span class="status-pill">${esc(j.status)}</span> ${todayPill}</div>
          <div class="muted">date ${esc(j.scheduled_date || '—')}${j.scheduled_slot ? ' · ' + esc(slotLabel(j.scheduled_slot)) : ''} · ${(j.bin_ids || []).length} bins</div>
          ${picklist}
        </div>
        <div class="job-actions"></div>
      </div>
    </div>
  `);
  const actions = card.querySelector('.job-actions');
  if (!isDone) {
    actions.appendChild(el(`<a class="btn ghost btn-sm" href="${esc(driverFieldUrl({ jobId: j.id }))}" ${FIELD_LINK_ATTRS}>Open in driver app ↗</a>`));
    const override = el('<a href="#" class="manual-link">admin override: mark done</a>');
    override.addEventListener('click', async (e) => {
      e.preventDefault();
      const ok = await confirmDialog({
        title: 'Admin override',
        message: `Mark "${JOB_LABEL[j.type] || j.type}" done without driver scan confirmation? Use only when the driver app is unavailable.`,
        confirmLabel: 'Mark done',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await api.post(`/jobs/${j.id}/done`, {});
        toast(`Done — bins now ${res.advanced[0]?.status}`);
        loadQueue();
        loadStats();
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.appendChild(override);
  }
  return card;
}

// ---- assign -----------------------------------------------------------------
let assignSelected = new Set();
let availableSku = {};
let assignBookingDetail = null;

async function loadAssign() {
  assignSelected = new Set();
  const select = $('#assignBooking');
  const bookings = await api.get('/bookings');
  select.innerHTML = bookings
    .map((b) => `<option value="${esc(b.id)}">${esc(b.customer?.name)} — ${esc(b.bin_count)} bins — ${esc(b.delivery_date)}</option>`)
    .join('');

  if (pendingAssign?.bookingId) {
    select.value = pendingAssign.bookingId;
    pendingAssign = null;
  }

  await renderAvailableBins();
  renderAssignSelected();
  await updateAssignSummary();
  await renderInventoryAlert();
}

$('#assignBooking').addEventListener('change', async () => {
  await updateAssignSummary();
  await renderInventoryAlert();
});

async function updateAssignSummary() {
  const id = $('#assignBooking').value;
  if (!id) return ($('#assignSummary').innerHTML = '');
  assignBookingDetail = await api.get(`/bookings/${id}`);
  renderReconcile();
}

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
    Object.entries(obj)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ') || 'none';
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

async function renderInventoryAlert() {
  const box = $('#inventoryAlert');
  if (!box) return;
  try {
    const [bins, stats] = await Promise.all([api.get('/bins/available'), api.get('/stats')]);
    const bySku = {};
    for (const b of bins) bySku[b.sku_type] = (bySku[b.sku_type] || 0) + 1;
    if (!assignBookingDetail) {
      box.hidden = true;
      return;
    }
    const breakdown = assignBookingDetail.sku_breakdown || {};
    const assignedBySku = tallyBySku((assignBookingDetail.bins || []).map((b) => b.sku_type));
    const shortages = [];
    for (const [sku, n] of Object.entries(breakdown)) {
      const need = Math.max(0, n - (assignedBySku[sku] || 0));
      const avail = bySku[sku] || 0;
      if (need > avail) shortages.push(`${sku}: need ${need}, only ${avail} available`);
    }
    if (shortages.length) {
      box.hidden = false;
      box.className = 'inventory-alert warn';
      box.innerHTML = `<strong>Inventory shortage:</strong> ${esc(shortages.join(' · '))}. <a href="/warehouse/?mode=intake" ${FIELD_LINK_ATTRS}>Add bins in warehouse app ↗</a>`;
    } else if (bins.length <= 3) {
      box.hidden = false;
      box.className = 'inventory-alert';
      box.innerHTML = `<strong>Low pool:</strong> only ${bins.length} unassigned bin${bins.length === 1 ? '' : 's'} left (${stats.bins.total} total).`;
    } else {
      box.hidden = true;
    }
  } catch {
    box.hidden = true;
  }
}

async function renderAvailableBins() {
  const bins = await api.get('/bins/available');
  availableSku = {};
  const box = $('#availableBins');
  if (bins.length === 0) {
    box.innerHTML = `<span class="muted">No unassigned bins left — <a href="/warehouse/?mode=intake" ${FIELD_LINK_ATTRS}>add bins in warehouse app ↗</a>.</span>`;
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
    loadStats();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---- dispatch ---------------------------------------------------------------
async function loadDispatch() {
  const box = $('#dispatchList');
  try {
    await refreshServiceToday();
    const jobs = await api.get('/jobs');
    const open = jobs.filter((j) => j.status !== 'Done');
    const todayKey = serviceToday();
    const today = open.filter((j) => j.scheduled_date === todayKey);
    const upcoming = open.filter((j) => j.scheduled_date !== todayKey);

    if (!open.length) {
      box.innerHTML = '<div class="empty">No open jobs scheduled.</div>';
      return;
    }

    box.innerHTML = '';
    const renderGroup = (title, list) => {
      if (!list.length) return;
      box.appendChild(el(`<div class="group-head">${esc(title)}</div>`));
      const bySlot = {};
      for (const j of list) {
        const key = j.scheduled_slot || 'none';
        (bySlot[key] ||= []).push(j);
      }
      for (const [slot, slotJobs] of Object.entries(bySlot)) {
        if (slot !== 'none') {
          box.appendChild(el(`<div class="dispatch-slot-head">${esc(slotLabel(slot))}</div>`));
        }
        slotJobs.forEach((j) => box.appendChild(dispatchCard(j)));
      }
    };

    renderGroup(`Today (${todayKey})`, sortTodayJobs(today));
    renderGroup('Upcoming', upcoming);
  } catch (e) {
    box.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

function dispatchCard(j) {
  const cust = j.booking?.customer;
  const card = el(`
    <div class="card dispatch-card">
      <div class="row">
        <div>
          <div><strong>${esc(JOB_LABEL[j.type] || j.type)}</strong> <span class="status-pill">${esc(j.status)}</span></div>
          <div class="muted">${esc(cust?.name || 'Unknown')}${cust?.address ? ' · ' + esc(cust.address) : ''}${cust?.phone ? ' · ' + esc(cust.phone) : ''}</div>
          <div class="muted">${esc(j.scheduled_date || '—')}${j.scheduled_slot ? ' · ' + esc(slotLabel(j.scheduled_slot)) : ''} · ${(j.bin_ids || []).length} bins · ref ${esc(j.booking_id)}</div>
        </div>
        <div><a class="btn ghost btn-sm" href="${esc(driverFieldUrl({ jobId: j.id }))}" ${FIELD_LINK_ATTRS}>Driver app ↗</a></div>
      </div>
    </div>
  `);
  return card;
}

// ---- customers --------------------------------------------------------------
let customersCache = [];
let customerBinsByBooking = {};

$('#customerSearch')?.addEventListener('input', (e) => {
  renderCustomers(e.target.value.trim().toLowerCase());
});

async function loadCustomers() {
  if (pendingCustomerSearch) {
    $('#customerSearch').value = pendingCustomerSearch;
    pendingCustomerSearch = null;
  }
  try {
    const bookings = await api.get('/bookings');
    const details = await Promise.all(
      bookings.map((b) => api.get(`/bookings/${b.id}`).catch(() => null))
    );
    customerBinsByBooking = {};
    for (const d of details) {
      if (d?.id) customerBinsByBooking[d.id] = d.bins || [];
    }

    const byCustomer = new Map();
    for (const b of bookings) {
      const c = b.customer;
      if (!c?.id) continue;
      if (!byCustomer.has(c.id)) {
        byCustomer.set(c.id, { customer: c, bookings: [] });
      }
      byCustomer.get(c.id).bookings.push(b);
    }
    customersCache = [...byCustomer.values()];
    renderCustomers($('#customerSearch').value.trim().toLowerCase());
  } catch (e) {
    $('#customerList').innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

function renderCustomers(query) {
  const box = $('#customerList');
  let rows = customersCache;
  if (query) {
    rows = rows.filter(({ customer, bookings }) => {
      const hay = [
        customer.name,
        customer.phone,
        customer.email,
        customer.address,
        customer.postcode,
        ...bookings.map((b) => b.id),
        ...bookings.flatMap((b) => (customerBinsByBooking[b.id] || []).map((bin) => bin.barcode)),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(query);
    });
  }
  if (!rows.length) {
    box.innerHTML = '<div class="empty">No customers match.</div>';
    return;
  }
  box.innerHTML = rows
    .map(({ customer, bookings }) => {
      const bookingBlocks = bookings
        .map((b) => {
          const bins = customerBinsByBooking[b.id] || [];
          const binLine = bins.length
            ? bins
                .map((bin) => `<code>${esc(bin.barcode)}</code> <span class="muted">${esc(bin.status || 'unassigned')}</span>`)
                .join(' · ')
            : '<span class="muted">no bins assigned</span>';
          return `<div class="customer-booking">
            <div><code>${esc(b.id)}</code> · ${esc(b.delivery_date)} · ${esc(b.summary?.text || '')}</div>
            <div class="muted" style="margin-top:2px;">${binLine}</div>
          </div>`;
        })
        .join('');
      return `<div class="bin-row customer-row">
        <div>
          <strong>${esc(customer.name || 'Unknown')}</strong>
          ${customer.phone ? `<span class="muted"> · <a href="tel:${esc(customer.phone)}">${esc(customer.phone)}</a></span>` : ''}
          ${customer.email ? `<span class="muted"> · ${esc(customer.email)}</span>` : ''}
          <div class="muted">${esc(customer.address || '')}${customer.postcode ? ', ' + esc(customer.postcode) : ''}</div>
          <div style="margin-top:8px;">${bookingBlocks}</div>
        </div>
      </div>`;
    })
    .join('');
}

// ---- explorer ---------------------------------------------------------------
function loadExplorer() {
  if (pendingExplorerBarcode) {
    $('#explorerBarcode').value = pendingExplorerBarcode;
    pendingExplorerBarcode = null;
    searchBin();
  }
}

$('#explorerSearch').addEventListener('click', searchBin);
$('#explorerBarcode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchBin();
});

async function searchBin() {
  const bc = $('#explorerBarcode').value.trim().toUpperCase();
  const box = $('#explorerResult');
  if (!bc) return;
  setHash('explorer', { barcode: bc });
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
    const thumbSrc =
      bin.photoUrl || (bin.photo_ref && bin.photo_ref.startsWith('data:image/') ? bin.photo_ref : null);
    const photo = thumbSrc
      ? `<img class="thumb" src="${esc(thumbSrc)}" alt="contents photo" />`
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

// ---- inventory (summary + read-only rack map) -------------------------------
async function loadInventory() {
  await Promise.all([renderInventorySummary(), renderRackMap()]);
}

async function renderInventorySummary() {
  const box = $('#inventorySummary');
  try {
    const [stats, available] = await Promise.all([api.get('/stats'), api.get('/bins/available')]);
    const bs = stats.bins.byStatus;
    const bySku = {};
    for (const b of available) bySku[b.sku_type] = (bySku[b.sku_type] || 0) + 1;

    const statusRows = Object.entries(bs)
      .filter(([, n]) => n > 0)
      .map(([status, n]) => `<tr><td>${esc(status)}</td><td>${n}</td></tr>`)
      .join('');
    const skuRows = Object.entries(bySku)
      .map(([sku, n]) => `<tr><td>${esc(sku)} (available)</td><td>${n}</td></tr>`)
      .join('');

    box.innerHTML = `
      <h3 style="margin-top:0;font-size:15px;">Bin pool</h3>
      <table class="inv-table">
        <thead><tr><th>Status / SKU</th><th>Count</th></tr></thead>
        <tbody>${statusRows}${skuRows}</tbody>
      </table>
      <p class="muted" style="margin:12px 0 0;">${stats.bins.unassigned} unassigned · ${available.length} ready to assign · ${stats.locations.occupancyPct}% rack occupancy</p>`;
  } catch (e) {
    box.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

async function renderRackMap() {
  const locations = await api.get('/locations');
  const map = $('#rackMap');
  map.innerHTML = '';

  const byAisle = {};
  for (const loc of locations) {
    const aisle = loc.barcode.split('-')[0] || '?';
    (byAisle[aisle] ||= []).push(loc);
  }

  Object.keys(byAisle)
    .sort()
    .forEach((aisle) => {
      map.appendChild(el(`<div class="aisle-head">Aisle ${esc(aisle)}</div>`));
      const grid = el('<div class="rack-grid"></div>');
      byAisle[aisle].forEach((loc) => {
        const occ = !!loc.occupied;
        grid.appendChild(el(`
          <div class="slot ${occ ? 'occ' : 'free'}">
            <div class="slot-code">${esc(loc.barcode)}</div>
            ${occ ? `<div class="slot-occupant">${esc(loc.bin_barcode || 'occupied')}</div>` : '<div class="slot-free">free</div>'}
            <div class="slot-bc">${window.Barcode ? Barcode.svg(loc.barcode, { height: 22, moduleWidth: 1 }) : ''}</div>
          </div>`));
      });
      map.appendChild(grid);
    });
}

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
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'leads.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---- configuration ----------------------------------------------------------
async function loadConfig() {
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

// ---- staff ------------------------------------------------------------------
const ROLE_LABEL = { admin: 'Admin', warehouse: 'Warehouse', driver: 'Driver' };

async function loadStaff() {
  const box = $('#staffList');
  try {
    const users = await api.get('/auth/users');
    if (!users.length) {
      box.innerHTML = '<div class="empty">No staff yet.</div>';
      return;
    }
    box.innerHTML = users
      .map(
        (u) => `<div class="bin-row">
          <div><strong>${esc(u.email)}</strong> ${u.name ? `<span class="muted">${esc(u.name)}</span>` : ''}</div>
          <div><span class="badge ok">${esc(ROLE_LABEL[u.role] || u.role)}</span> <span class="muted">added ${new Date(u.created_at).toLocaleDateString()}</span></div>
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

// ---- camera scan buttons ----------------------------------------------------
document.querySelectorAll('.scan-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const code = await Scanner.scan({ title: 'Scan a barcode' });
    if (!code) return;
    const input = document.getElementById(btn.dataset.target);
    input.value = code;
    if (btn.dataset.then) document.getElementById(btn.dataset.then).click();
  });
});

// ---- polling ----------------------------------------------------------------
function isAssignIdle() {
  if (activeTab() !== 'assign') return false;
  if (assignSelected.size > 0) return false;
  const active = document.activeElement;
  const zones = ['#assignSummary', '#assignSelected', '#assignBarcode', '#availableBins', '#assignBooking'];
  if (active && zones.some((sel) => $(sel)?.contains(active))) return false;
  return true;
}

setInterval(async () => {
  if (document.hidden) return;
  loadStats();
  const tab = activeTab();
  if (tab === 'queue') loadQueue();
  else if (tab === 'dispatch') loadDispatch();
  else if (tab === 'inventory') loadInventory();
  else if (isAssignIdle()) {
    try {
      await updateAssignSummary();
      await renderAvailableBins();
      await renderInventoryAlert();
    } catch {
      /* next tick */
    }
  }
}, 4000);

// ---- boot -------------------------------------------------------------------
Session.guard('admin').then(async () => {
  await initSlotLabels();
  loadStats();
  applyRoute();
});
