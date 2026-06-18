// "My booking" page — lookup by reference or phone, view bins + statuses,
// and the per-bin customer actions (photo stub, request back, re-store, close).

const $ = (s) => document.querySelector(s);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
};

const SKU_PRICES = { bin: 15, wardrobe: 25 };

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  setTimeout(() => (t.className = ''), 2600);
}

async function api(method, path, body) {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function confirmModal(title, message) {
  return new Promise((resolve) => {
    const overlay = el(`
      <div class="modal-overlay" role="dialog" aria-modal="true">
        <div class="modal-card">
          <h3>${esc(title)}</h3>
          <p class="muted">${esc(message)}</p>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
            <button type="button" class="btn btn-primary" data-act="ok">Confirm</button>
          </div>
        </div>
      </div>`);
    overlay.querySelector('[data-act=cancel]').addEventListener('click', () => { overlay.remove(); resolve(false); });
    overlay.querySelector('[data-act=ok]').addEventListener('click', () => { overlay.remove(); resolve(true); });
    document.body.appendChild(overlay);
    overlay.querySelector('[data-act=ok]').focus();
  });
}

// Earliest pickable service date (collection/retrieval allow today; delivery uses lead days).
const SERVICE_TODAY_ISO = new Date().toISOString().slice(0, 10);
let SLOT_LABELS = { am: 'Morning (8am–12pm)', pm: 'Afternoon (12–5pm)' };
(async () => {
  try {
    const data = await api('GET', '/serviceability');
    if (Array.isArray(data.slots)) {
      SLOT_LABELS = Object.fromEntries(data.slots.map((s) => [s.key, s.label]));
    }
  } catch { /* fallback */ }
})();

const STATUS_COPY = {
  'Assigned': 'Booked — bins reserved for you',
  'Out for filling': 'Empty bin delivered — fill it up',
  'In transit (inbound)': 'On its way to our warehouse',
  'Stored': 'Safely stored',
  'Retrieval requested': 'Retrieval requested',
  'In transit (outbound)': 'On its way back to you',
  'Returned to customer': 'Delivered back to you',
  'Returned / closed': 'Closed',
};

const JOURNEY = [
  'Booked',
  'Out for filling',
  'To warehouse',
  'Stored',
  'On its way back',
  'Back with you',
];

function journeyPosition(status) {
  switch (status) {
    case 'Assigned': return { idx: 0, closed: false };
    case 'Out for filling': return { idx: 1, closed: false };
    case 'In transit (inbound)': return { idx: 2, closed: false };
    case 'Stored': return { idx: 3, closed: false };
    case 'Retrieval requested': return { idx: 4, closed: false };
    case 'In transit (outbound)': return { idx: 4, closed: false };
    case 'Returned to customer': return { idx: 5, closed: false };
    case 'Returned / closed': return { idx: 5, closed: true };
    default: return { idx: -1, closed: false };
  }
}

function journeyTracker(bin) {
  const { idx, closed } = journeyPosition(bin.status);
  const track = document.createElement('div');
  track.className = 'journey';
  track.innerHTML = JOURNEY.map((label, i) => {
    let state = i < idx ? 'done' : i === idx ? 'current' : 'upcoming';
    if (closed) state = 'done';
    return `<div class="jstep ${state}"><span class="jdot"></span><span class="jlabel">${label}</span></div>`;
  }).join('');
  if (closed) track.innerHTML += '<div class="jclosed">✓ Closed</div>';
  return track;
}

function monthlyEstimate(skuBreakdown) {
  if (!skuBreakdown) return 0;
  return Object.entries(skuBreakdown).reduce(
    (sum, [k, n]) => sum + (SKU_PRICES[k] || 0) * n,
    0
  );
}

function nextStepBanner(step) {
  if (!step) return null;
  const div = document.createElement('div');
  div.className = 'next-step-banner';
  let timeline = '';
  if (step.timeline) {
    timeline = `<div class="timeline-steps">${step.timeline
      .map((t) => `<div class="timeline-step ${t.state}"><span class="dot"></span><span>${esc(t.label)}</span></div>`)
      .join('')}</div>`;
  }
  div.innerHTML = `<strong>${esc(step.title)}</strong><div class="muted" style="margin-top:4px;">${esc(step.message)}</div>${timeline}`;
  return div;
}

function custodyDetails(bin) {
  const details = el('<details class="custody"><summary>Track this bin</summary><div class="custody-body muted">Loading…</div></details>');
  let loaded = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || loaded) return;
    loaded = true;
    const body = details.querySelector('.custody-body');
    try {
      const { movements } = await api('GET', `/bins/${bin.barcode}/movements`);
      if (!movements.length) {
        body.innerHTML = '<span class="muted">No movements yet.</span>';
        return;
      }
      body.classList.remove('muted');
      body.innerHTML = `<ul class="timeline">${movements
        .map((m) => `<li>
            <div>${esc(STATUS_COPY[m.to_status] || m.to_status || 'Booking cancelled — bin released')}${m.location ? ` <span class="muted">@ ${esc(m.location.barcode)}</span>` : ''}</div>
            <div class="ts">${new Date(m.ts).toLocaleString()}</div>
          </li>`)
        .join('')}</ul>`;
    } catch (e) {
      body.textContent = e.message;
    }
  });
  return details;
}

// Collection/retrieval windows are preferences (no delivery capacity cap) — show
// static AM/PM chips rather than reusing empty-bin delivery availability.
function renderServiceSlotChips(container, selectedKey, onSelect) {
  container.className = 'slot-list';
  container.innerHTML = '';
  Object.entries(SLOT_LABELS).forEach(([key, label]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'slot-chip' + (selectedKey === key ? ' selected' : '');
    chip.textContent = label;
    chip.setAttribute('aria-pressed', selectedKey === key ? 'true' : 'false');
    chip.addEventListener('click', () => {
      container.querySelectorAll('.slot-chip').forEach((c) => {
        c.classList.remove('selected');
        c.setAttribute('aria-pressed', 'false');
      });
      chip.classList.add('selected');
      chip.setAttribute('aria-pressed', 'true');
      onSelect(key);
    });
    container.appendChild(chip);
  });
}

function binActions(bin) {
  const wrap = document.createElement('div');
  wrap.className = 'flex';

  if (bin.status === 'Out for filling') {
    wrap.appendChild(
      mkBtn('green', bin.photo_ref ? '📷 Replace photo' : '📷 Add contents photo', () => pickPhoto(bin))
    );
  }

  if (bin.status === 'Returned to customer') {
    const date = document.createElement('input');
    date.type = 'date';
    date.className = 'inline-date';
    date.min = SERVICE_TODAY_ISO;
    const slotBox = el('<div class="slot-list"></div>');
    let chosenSlot = null;
    wrap.appendChild(el('<label>Collection date</label>'));
    wrap.appendChild(date);
    wrap.appendChild(el('<label>Collection window</label>'));
    wrap.appendChild(slotBox);
    renderServiceSlotChips(slotBox, null, (k) => { chosenSlot = k; });
    wrap.appendChild(
      mkBtn('', '📦 Store this again', async () => {
        if (!date.value) return toast('Pick a collection date', true);
        await api('POST', `/bins/${bin.id}/request-restore`, {
          collectionDate: date.value,
          collectionSlot: chosenSlot,
        });
        toast('Re-store collection scheduled');
        reloadCurrent();
      })
    );
    wrap.appendChild(
      mkBtn('ghost', '✓ Done with this bin', async () => {
        if (!(await confirmModal('Close this bin?', 'This permanently closes the bin. You can always book new bins later.'))) return;
        await api('POST', `/bins/${bin.id}/close`, {});
        toast('Bin closed');
        reloadCurrent();
      })
    );
  }

  return wrap;
}

function pickPhoto(bin) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const photoRef = await downscaleToDataURL(file, 320, 0.6);
      await api('POST', `/bins/${bin.barcode}/photo`, { photoRef });
      toast('Photo added');
      reloadCurrent();
    } catch (e) {
      toast(e.message, true);
    }
  });
  input.click();
}

function downscaleToDataURL(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Could not read that image'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}

function mkBtn(variant, label, onClick) {
  const b = document.createElement('button');
  b.className = `btn ${variant}`.trim();
  b.textContent = label;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await onClick(); } catch (e) { toast(e.message, true); } finally { b.disabled = false; }
  });
  return b;
}

function renderBooking(booking) {
  const box = $('#result');
  box.innerHTML = '';

  const sku = Object.entries(booking.sku_breakdown || {}).map(([k, v]) => `${v} ${k}`).join(', ');
  const monthly = monthlyEstimate(booking.sku_breakdown);
  const windowLabel = booking.delivery_slot
    ? ` · ${SLOT_LABELS[booking.delivery_slot] || esc(booking.delivery_slot)}`
    : '';
  const cust = booking.customer || {};

  const head = document.createElement('div');
  head.className = 'card';
  head.innerHTML = `
    <h2>Booking <code>${esc(booking.id)}</code></h2>
    <div class="muted">${esc(booking.bin_count)} bins (${esc(sku)}) · delivery ${esc(booking.delivery_date)}${windowLabel}</div>
    <div class="muted" style="margin-top:8px;">
      ${cust.address ? `<div>📍 ${esc(cust.address)}</div>` : ''}
      ${cust.phone ? `<div>📞 ${esc(cust.phone)}${cust.email ? ` · ✉ ${esc(cust.email)}` : ''}</div>` : ''}
      ${monthly ? `<div>💰 Est. $${monthly}/month while stored</div>` : ''}
    </div>`;
  if (booking.customerNextStep) {
    head.appendChild(nextStepBanner(booking.customerNextStep));
  }
  box.appendChild(head);

  const binsCard = document.createElement('div');
  binsCard.className = 'card';
  binsCard.innerHTML = `<h3 style="margin-top:0;">Your bins</h3>`;

  if (!booking.bins || booking.bins.length === 0) {
    binsCard.innerHTML += `<p class="muted">No bins assigned yet — we'll bind physical bins to your booking before delivery. Save your reference <code>${esc(booking.id)}</code> to check back anytime.</p>`;
  } else {
    booking.bins.forEach((bin) => {
      const hasThumb = bin.photo_ref && bin.photo_ref.startsWith('data:image/');
      const block = document.createElement('div');
      block.className = 'bin-block';

      const row = document.createElement('div');
      row.className = 'bin-row';
      const barcode = window.Barcode ? Barcode.svg(bin.barcode, { height: 28, moduleWidth: 1 }) : '';
      row.innerHTML = `
        <div>
          <strong>${esc(bin.barcode)}</strong> <span class="muted">${esc(bin.sku_type)}</span>
          <div class="status-badge">${esc(STATUS_COPY[bin.status] || bin.status || 'pending')}${bin.photo_ref && !hasThumb ? ' · 📷 photo on file' : ''}</div>
          <div class="bc-block">${barcode}</div>
          ${hasThumb ? `<img class="thumb" src="${esc(bin.photo_ref)}" alt="contents photo" />` : ''}
        </div>`;
      block.appendChild(row);
      block.appendChild(journeyTracker(bin));

      const actions = binActions(bin);
      if (actions.children.length) {
        actions.style.marginTop = '8px';
        block.appendChild(actions);
      }
      block.appendChild(custodyDetails(bin));
      binsCard.appendChild(block);
    });
  }
  box.appendChild(binsCard);

  const outForFilling = (booking.bins || []).filter((b) => b.status === 'Out for filling');
  if (outForFilling.length) box.appendChild(collectionPanel(booking));

  const stored = (booking.bins || []).filter((b) => b.status === 'Stored');
  if (stored.length) box.appendChild(retrievalPanel(stored));
}

function collectionPanel(booking) {
  const card = document.createElement('div');
  card.className = 'card';
  const scheduled = (booking.jobs || []).find(
    (j) => j.type === 'collect_full' && j.status === 'Scheduled'
  );
  const slotLabel = scheduled?.scheduled_slot
    ? ` · ${SLOT_LABELS[scheduled.scheduled_slot] || scheduled.scheduled_slot}`
    : '';

  card.innerHTML = scheduled
    ? `<h3 style="margin-top:0;">Collection</h3>
       <p class="muted">Collection booked for <strong>${esc(scheduled.scheduled_date)}${esc(slotLabel)}</strong>. Pick a new date to reschedule.</p>`
    : `<h3 style="margin-top:0;">Book a collection</h3>
       <p class="muted">Filled your bins? Choose a date and window — collection is free.</p>`;

  const date = el('<input type="date" class="inline-date" />');
  date.min = SERVICE_TODAY_ISO;
  if (scheduled?.scheduled_date) date.value = scheduled.scheduled_date;
  card.appendChild(el('<label>Collection date</label>'));
  card.appendChild(date);

  const slotBox = el('<div class="slot-list"></div>');
  let chosenSlot = scheduled?.scheduled_slot || null;
  card.appendChild(el('<label>Collection window</label>'));
  card.appendChild(slotBox);
  renderServiceSlotChips(slotBox, chosenSlot, (k) => { chosenSlot = k; });

  const btn = mkBtn('green', scheduled ? '📅 Change date' : '📅 Book collection', async () => {
    if (!date.value) return toast('Pick a collection date', true);
    await api('POST', `/bookings/${booking.id}/book-collection`, {
      collectionDate: date.value,
      collectionSlot: chosenSlot,
    });
    toast(scheduled ? 'Collection rescheduled' : 'Collection booked');
    reloadCurrent();
  });
  btn.style.marginTop = '12px';
  card.appendChild(btn);
  return card;
}

function retrievalPanel(stored) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<h3 style="margin-top:0;">Get bins back</h3>
    <p class="muted">Tick the bins you want returned and pick a delivery-back date and window.</p>`;

  const checks = stored.map((bin) =>
    el(`<label class="check-row"><input type="checkbox" value="${esc(bin.id)}" /> <strong>${esc(bin.barcode)}</strong> <span class="muted">${esc(bin.sku_type)}</span></label>`)
  );
  checks.forEach((c) => card.appendChild(c));

  const date = el('<input type="date" class="inline-date" />');
  date.min = SERVICE_TODAY_ISO;
  card.appendChild(el('<label>Delivery-back date</label>'));
  card.appendChild(date);

  const slotBox = el('<div class="slot-list"></div>');
  let chosenSlot = null;
  card.appendChild(el('<label>Delivery window</label>'));
  card.appendChild(slotBox);
  renderServiceSlotChips(slotBox, null, (k) => { chosenSlot = k; });

  const feeBox = el(`
    <div class="fee-notice">
      <label class="check-row" style="margin:0;">
        <input type="checkbox" id="feeAck" />
        <span>I understand a <strong>$30 delivery fee</strong> applies to this return request.</span>
      </label>
    </div>`);
  card.appendChild(feeBox);

  const btn = mkBtn('', '↩ Request selected bins back', async () => {
    const ids = checks
      .map((c) => c.querySelector('input'))
      .filter((i) => i.checked)
      .map((i) => i.value);
    if (ids.length === 0) return toast('Tick at least one bin', true);
    if (!date.value) return toast('Pick a delivery-back date', true);
    if (!feeBox.querySelector('#feeAck').checked) {
      return toast('Please acknowledge the $30 delivery fee', true);
    }
    for (const id of ids) {
      await api('POST', `/bins/${id}/request-return`, {
        deliveryBackDate: date.value,
        deliveryBackSlot: chosenSlot,
      });
    }
    toast(`Requested ${ids.length} bin${ids.length === 1 ? '' : 's'} back`);
    reloadCurrent();
  });
  btn.style.marginTop = '12px';
  card.appendChild(btn);
  return card;
}

let currentRef = null;
let isRefreshing = false;

function showSkeleton() {
  $('#result').innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';
}

async function loadByRef(ref, { silent = false } = {}) {
  if (!silent) showSkeleton();
  try {
    const booking = await api('GET', `/bookings/${encodeURIComponent(ref)}`);
    currentRef = ref;
    sessionStorage.setItem('valet_last_ref', ref);
    renderBooking(booking);
  } catch (e) {
    $('#result').innerHTML = `<div class="card muted">${esc(e.message)}</div>`;
  }
}

function renderBookingPicker(list, phone) {
  const box = $('#result');
  box.innerHTML = `<div class="card"><h3 style="margin-top:0;">Select a booking</h3>
    <p class="muted">We found ${list.length} bookings for that phone number.</p>
    <div class="booking-picker"></div></div>`;
  const picker = box.querySelector('.booking-picker');
  list.forEach((b) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'booking-picker-btn';
    const sku = Object.entries(b.sku_breakdown || {}).map(([k, v]) => `${v} ${k}`).join(', ');
    btn.innerHTML = `<strong>${esc(b.id)}</strong>
      <div class="muted">${esc(b.bin_count)} bins (${esc(sku)}) · delivery ${esc(b.delivery_date)}</div>
      <div class="muted">${esc(b.summary?.text || '')}</div>`;
    btn.addEventListener('click', () => {
      $('#lookup').value = b.id;
      loadByRef(b.id);
    });
    picker.appendChild(btn);
  });
}

async function loadByPhone(phone) {
  const list = await api('GET', `/bookings/by-phone/${encodeURIComponent(phone)}`);
  if (list.length === 0) {
    $('#result').innerHTML = `<div class="card muted">No bookings found for that phone.</div>`;
    return;
  }
  if (list.length === 1) {
    await loadByRef(list[0].id);
    return;
  }
  const saved = sessionStorage.getItem('valet_last_ref');
  if (saved && list.some((b) => b.id === saved)) {
    await loadByRef(saved);
    return;
  }
  renderBookingPicker(list, phone);
}

function reloadCurrent(silent = true) {
  if (currentRef && !isRefreshing) loadByRef(currentRef, { silent });
}

$('#lookupBtn').addEventListener('click', async () => {
  const v = $('#lookup').value.trim();
  if (!v) return;
  const btn = $('#lookupBtn');
  btn.disabled = true;
  try {
    if (v.startsWith('book_')) await loadByRef(v);
    else await loadByPhone(v);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
});
$('#lookup').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#lookupBtn').click(); });

$('#scanLookupBtn').addEventListener('click', async () => {
  const code = await Scanner.scan({ title: 'Scan a bin barcode' });
  if (!code) return;
  try {
    const { bin } = await api('GET', `/bins/${encodeURIComponent(code)}/movements`);
    if (!bin.booking_id) return toast(`${code} isn't linked to a booking yet`, true);
    $('#lookup').value = bin.booking_id;
    await loadByRef(bin.booking_id);
  } catch (e) {
    toast(e.message, true);
  }
});

setInterval(async () => {
  if (!currentRef || document.hidden) return;
  const active = document.activeElement;
  if (active && $('#result')?.contains(active)) return;
  if ($('#result')?.querySelector('details.custody[open]')) return;
  if ($('#result')?.querySelector('input[type=checkbox]:checked')) return;
  if ($('#result')?.querySelector('input[type=date][data-dirty]')) return;
  if ($('.modal-overlay')) return;

  isRefreshing = true;
  const hint = el('<div class="updating-hint">Updating…</div>');
  const existing = $('#result')?.querySelector('.updating-hint');
  if (!existing && $('#result')?.firstChild) $('#result').prepend(hint);
  try {
    await loadByRef(currentRef, { silent: true });
  } finally {
    isRefreshing = false;
    $('#result')?.querySelector('.updating-hint')?.remove();
  }
}, 4000);

$('#result').addEventListener('input', (e) => {
  if (e.target.matches?.('input[type=date]')) e.target.dataset.dirty = '1';
});

const params = new URLSearchParams(location.search);
const ref = params.get('ref');
if (ref) {
  $('#lookup').value = ref;
  if (params.get('new') === '1') {
    $('#confirmBanner').innerHTML = `<div class="banner">
      ✅ <strong>Booking confirmed!</strong> Reference <code>${esc(ref)}</code>.
      <div class="timeline-steps" style="margin-top:12px;">
        <div class="timeline-step done"><span class="dot"></span><span>Booking received</span></div>
        <div class="timeline-step current"><span class="dot"></span><span>We'll assign your bins</span></div>
        <div class="timeline-step upcoming"><span class="dot"></span><span>Empty bins delivered on your chosen date</span></div>
      </div>
      <p class="muted" style="margin:12px 0 0;">Save this reference — it's how you track your booking (no login needed). If you provided an email, check your inbox for confirmation. Drop-off and collection are free; a flat $30 per delivery applies when you request stored bins back.</p>
    </div>`;
  }
  loadByRef(ref);
} else {
  const saved = sessionStorage.getItem('valet_last_ref');
  if (saved) {
    $('#lookup').value = saved;
  }
}
