// Driver app — a phone-first view of the jobs board. Reads /api/jobs (which
// carries bins + booking + customer) and completes jobs via /api/jobs/:id/done.
// The scan-to-confirm checklist is purely client-side reassurance; the server's
// transition module remains the authority on what may advance.

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

const JOB_LABEL = {
  deliver_empty: 'Deliver empty bins',
  collect_full: 'Collect filled bins',
  deliver_back: 'Deliver bins back',
};
const JOB_ICON = { deliver_empty: '📦', collect_full: '🔄', deliver_back: '🏠' };

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

let jobs = [];          // latest fetch
let openJobId = null;   // job currently shown in detail view
let scanned = new Set(); // barcodes confirmed for the open job

// ---- list view ----------------------------------------------------------------
async function loadJobs() {
  jobs = await api.get('/jobs');
  renderList();
}

function renderList() {
  const box = $('#jobGroups');
  if (jobs.length === 0) {
    box.innerHTML = '<div class="empty">No jobs yet — create a booking on the booking site.</div>';
    return;
  }
  const open = jobs.filter((j) => j.status !== 'Done');
  const today = open.filter((j) => j.scheduled_date === TODAY);
  const upcoming = open.filter((j) => j.scheduled_date !== TODAY);
  const done = jobs.filter((j) => j.status === 'Done');

  box.innerHTML = '';
  const group = (title, items) => {
    if (!items.length) return;
    box.appendChild(el(`<div class="group-head">${esc(title)}</div>`));
    items.forEach((j) => box.appendChild(jobCard(j)));
  };
  group('Today', today);
  group('Upcoming', upcoming);
  if (!open.length) box.appendChild(el('<div class="empty">No open jobs — all done 🎉</div>'));
  if (done.length) {
    const details = el(`<details><summary class="group-head" style="cursor:pointer;">${done.length} done</summary></details>`);
    done.forEach((j) => details.appendChild(jobCard(j)));
    box.appendChild(details);
  }
}

function jobCard(j) {
  const cust = j.booking?.customer;
  const isDone = j.status === 'Done';
  const pill = isDone
    ? '<span class="pill done">Done</span>'
    : j.scheduled_date === TODAY
    ? '<span class="pill today">Today</span>'
    : `<span class="pill">${esc(j.scheduled_date || '—')}</span>`;
  const card = el(`
    <button class="job-card">
      <div class="row">
        <div>
          <div class="job-type">${JOB_ICON[j.type] || ''} ${esc(JOB_LABEL[j.type] || j.type)}</div>
          <div class="job-meta">${esc(cust?.name || 'Unknown customer')}${cust?.address ? ' · ' + esc(cust.address) : ''}</div>
          <div class="job-meta">${(j.bin_ids || []).length} bins${j.scheduled_slot ? ' · ' + esc(slotLabel(j.scheduled_slot)) : ''}</div>
        </div>
        <div>${pill}</div>
      </div>
    </button>
  `);
  card.addEventListener('click', () => openDetail(j.id));
  return card;
}

// ---- detail view ----------------------------------------------------------------
function openDetail(jobId) {
  openJobId = jobId;
  scanned = new Set();
  renderDetail();
  $('#listView').hidden = true;
  $('#detailView').hidden = false;
  window.scrollTo(0, 0);
}

function closeDetail() {
  openJobId = null;
  $('#detailView').hidden = true;
  $('#listView').hidden = false;
  // Remove the sticky action bar, if present.
  document.querySelector('.action-bar')?.remove();
  loadJobs();
}

$('#backBtn').addEventListener('click', closeDetail);

function renderDetail() {
  const j = jobs.find((x) => x.id === openJobId);
  const box = $('#jobDetail');
  document.querySelector('.action-bar')?.remove();
  if (!j) return (box.innerHTML = '<div class="empty">Job not found.</div>');

  const cust = j.booking?.customer;
  const bins = j.bins || [];
  const isDone = j.status === 'Done';

  const custLines = cust
    ? `
      <div class="cust-line"><strong>${esc(cust.name || 'Unknown')}</strong></div>
      ${cust.address ? `<div class="cust-line">📍 ${esc(cust.address)}${cust.postcode ? ', ' + esc(cust.postcode) : ''}</div>` : ''}
      ${cust.phone ? `<div class="cust-line">📞 <a href="tel:${esc(cust.phone)}">${esc(cust.phone)}</a></div>` : ''}`
    : '<div class="muted">No customer on file</div>';

  const checklist = bins.length
    ? bins
        .map(
          (b) => `
          <div class="bin-check" data-barcode="${esc(b.barcode)}">
            <div class="tick">✓</div>
            <div class="bin-info">
              <div><code>${esc(b.barcode)}</code> <span class="muted">${esc(b.sku_type)}</span></div>
              <div class="bin-bc">${window.Barcode ? Barcode.svg(b.barcode, { height: 30, moduleWidth: 1.5 }) : ''}</div>
            </div>
          </div>`
        )
        .join('')
    : '<div class="muted">No bins assigned to this job yet — assign them in the admin console first.</div>';

  box.innerHTML = `
    <div class="card">
      <h2>${JOB_ICON[j.type] || ''} ${esc(JOB_LABEL[j.type] || j.type)}</h2>
      <div class="muted">${esc(j.scheduled_date || '—')}${j.scheduled_slot ? ' · ' + esc(slotLabel(j.scheduled_slot)) : ''} · status: ${esc(j.status)}</div>
      <div style="margin-top:10px;">${custLines}</div>
    </div>
    <div class="card">
      <h2 id="binCount">Bins (${scanned.size}/${bins.length} confirmed)</h2>
      <p class="muted">Scan each bin's barcode at handover to confirm you have the right ones.</p>
      ${checklist}
      ${isDone || !bins.length ? '' : '<a href="#" class="skip-link" id="skipScan">Can’t scan? Skip confirmation</a>'}
    </div>
  `;

  if (isDone || !bins.length) return;

  // Sticky action bar: Scan bin + Mark done.
  const bar = el(`
    <div class="action-bar">
      <button class="btn ghost" id="scanBtn">📷 Scan bin</button>
      <button class="btn green" id="doneBtn" disabled>Mark done</button>
    </div>
  `);
  document.body.appendChild(bar);

  const updateTicks = () => {
    box.querySelectorAll('.bin-check').forEach((row) => {
      row.classList.toggle('ticked', scanned.has(row.dataset.barcode));
    });
    box.querySelector('#binCount').textContent = `Bins (${scanned.size}/${bins.length} confirmed)`;
    bar.querySelector('#doneBtn').disabled = scanned.size < bins.length;
  };

  bar.querySelector('#scanBtn').addEventListener('click', async () => {
    const code = await Scanner.scan({ title: 'Scan a bin barcode' });
    if (!code) return;
    const expected = bins.find((b) => b.barcode === code);
    if (!expected) return toast(`${code} is not on this job`, true);
    if (scanned.has(code)) return toast(`${code} already confirmed`);
    scanned.add(code);
    toast(`${code} confirmed ✓`);
    updateTicks();
  });

  box.querySelector('#skipScan')?.addEventListener('click', (e) => {
    e.preventDefault();
    bins.forEach((b) => scanned.add(b.barcode));
    updateTicks();
    toast('Scan confirmation skipped');
  });

  bar.querySelector('#doneBtn').addEventListener('click', async () => {
    const btn = bar.querySelector('#doneBtn');
    btn.disabled = true;
    try {
      const res = await api.post(`/jobs/${j.id}/done`, {});
      toast(`Done — bins now ${res.advanced[0]?.status}`);
      closeDetail();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
  });

  updateTicks();
}

// ---- polling (list view only, so it never clobbers an in-progress checklist) ---
setInterval(() => {
  if (document.hidden || openJobId !== null) return;
  loadJobs();
}, 5000);

// ---- boot ----------------------------------------------------------------------
// Gate on a signed-in driver first; Session.guard redirects if not.
Session.guard('driver').then(() => {
  loadJobs().catch((e) => {
    $('#jobGroups').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  });
});
