// "My booking" page — lookup by reference or phone, view bins + statuses,
// and the per-bin customer actions (photo stub, request back, re-store, close).

const $ = (s) => document.querySelector(s);
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

// Accessible confirm dialog — Escape/backdrop dismiss, focus trap, restore focus.
function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const overlay = el(`
      <div class="modal-overlay" role="presentation">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <h3 id="modalTitle">${esc(title)}</h3>
          <p>${message}</p>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost modal-cancel">${esc(cancelLabel)}</button>
            <button type="button" class="btn btn-primary modal-confirm">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`);
    const dialog = overlay.querySelector('.modal');
    const prevFocus = document.activeElement;
    const focusables = () => [...dialog.querySelectorAll('button')];

    const close = (result) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (prevFocus?.focus) prevFocus.focus();
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    overlay.querySelector('.modal-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.modal-confirm').addEventListener('click', () => close(true));
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('.modal-confirm').focus();
  });
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

// Today (UTC calendar) — the earliest customer-pickable service date.
const TODAY_ISO = new Date().toISOString().slice(0, 10);
const SAVED_REF_KEY = 'savBookingRef';

// Delivery-window labels. Fallback values; refreshed from the API at boot so
// the backend stays the single source of truth.
let SLOT_LABELS = { am: 'Morning (8am–12pm)', pm: 'Afternoon (12–5pm)' };
(async () => {
  try {
    const r = await fetch('/api/serviceability');
    const data = await r.json();
    if (Array.isArray(data.slots)) {
      SLOT_LABELS = Object.fromEntries(data.slots.map((s) => [s.key, s.label]));
    }
  } catch { /* fallback labels stand */ }
})();

// Customer-facing status copy.
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

// ---- journey tracker (item C) -----------------------------------------------
const JOURNEY = ['Booked', 'Out for filling', 'Stored', 'On its way back', 'Back with you'];

// Maps a bin status to its journey step index (and whether the lifecycle closed).
function journeyPosition(status) {
  switch (status) {
    case 'Assigned': return { idx: 0, closed: false };
    case 'Out for filling': return { idx: 1, closed: false };
    case 'In transit (inbound)': return { idx: 2, closed: false };
    case 'Stored': return { idx: 2, closed: false };
    case 'Retrieval requested': return { idx: 3, closed: false };
    case 'In transit (outbound)': return { idx: 3, closed: false };
    case 'Returned to customer': return { idx: 4, closed: false };
    case 'Returned / closed': return { idx: 4, closed: true };
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

// ---- chain of custody (item E) ----------------------------------------------
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

function binActions(bin) {
  const wrap = document.createElement('div');
  wrap.className = 'flex';

  // Out for filling → upload a real contents photo (downscaled to a thumbnail).
  if (bin.status === 'Out for filling') {
    wrap.appendChild(
      mkBtn('green', bin.photo_ref ? '📷 Replace photo' : '📷 Add contents photo', () => pickPhoto(bin))
    );
  }

  // Returned to customer → re-store (inline date) or close for good.
  if (bin.status === 'Returned to customer') {
    const date = document.createElement('input');
    date.type = 'date';
    date.className = 'inline-date';
    date.min = TODAY_ISO;
    wrap.appendChild(date);
    wrap.appendChild(
      mkBtn('', '📦 Store this again', async () => {
        if (!date.value) return toast('Pick a collection date', true);
        await api('POST', `/bins/${bin.id}/request-restore`, { collectionDate: date.value });
        toast('Re-store collection scheduled');
        reloadCurrent();
      })
    );
    wrap.appendChild(
      mkBtn('ghost', '✓ Done with this bin', async () => {
        const ok = await confirmDialog({
          title: 'Close this bin?',
          message: 'Close this bin for good? You will not be able to re-store it.',
          confirmLabel: 'Close bin',
        });
        if (!ok) return;
        await api('POST', `/bins/${bin.id}/close`, {});
        toast('Bin closed');
        reloadCurrent();
      })
    );
  }

  return wrap;
}

// Opens a file picker, downscales the chosen image to a small thumbnail data
// URL, and posts it as the bin's contents photo.
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
  const cls = variant === 'ghost' ? 'btn btn-ghost' : 'btn btn-primary';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
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
  const head = document.createElement('div');
  head.className = 'card';
  // NB: do not name this 'window' — it would shadow the global and break
  // window.Barcode below.
  const windowLabel = booking.delivery_slot
    ? ` · ${SLOT_LABELS[booking.delivery_slot] || esc(booking.delivery_slot)}`
    : '';
  head.innerHTML = `
    <h2>Booking <code>${esc(booking.id)}</code></h2>
    <div class="muted">${esc(booking.bin_count)} bins (${esc(sku)}) · delivery ${esc(booking.delivery_date)}${windowLabel}</div>
    <div class="muted" style="margin-top:6px;"><strong>${esc(booking.summary.text)}</strong></div>`;
  box.appendChild(head);

  if (booking.customerNextStep?.text) {
    const next = document.createElement('div');
    next.className = 'banner next-step';
    next.innerHTML = `<strong>Next step:</strong> ${esc(booking.customerNextStep.text)}`;
    box.appendChild(next);
  }

  const binsCard = document.createElement('div');
  binsCard.className = 'card';
  binsCard.innerHTML = `<h3 style="margin-top:0;">Your bins</h3>`;

  if (!booking.bins || booking.bins.length === 0) {
    binsCard.innerHTML += `<p class="muted">No bins assigned yet — we'll bind physical bins to your booking before delivery.</p>`;
  } else {
    booking.bins.forEach((bin) => {
      // Only render data-URL images we expect (guards src attribute injection).
      const hasThumb = bin.photo_ref && bin.photo_ref.startsWith('data:image/');
      const block = document.createElement('div');
      block.className = 'bin-block';

      const row = document.createElement('div');
      row.className = 'bin-row';
      const barcode = window.Barcode ? Barcode.svg(bin.barcode, { height: 28, moduleWidth: 1 }) : '';
      row.innerHTML = `
        <div>
          <strong>${esc(bin.barcode)}</strong> <span class="muted">${esc(bin.sku_type)}</span>
          <div class="muted">${esc(STATUS_COPY[bin.status] || bin.status || 'pending')}${bin.photo_ref && !hasThumb ? ' · 📷 photo on file' : ''}</div>
          <div class="bc-block">${barcode}</div>
          ${hasThumb ? `<img class="thumb" src="${esc(bin.photo_ref)}" alt="contents photo" />` : ''}
        </div>
        <div><span class="pill">${esc(bin.status || 'pending')}</span></div>`;
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

  // "Book collection" panel — schedule pickup of filled bins on a chosen date.
  const outForFilling = (booking.bins || []).filter((b) => b.status === 'Out for filling');
  if (outForFilling.length) {
    box.appendChild(collectionPanel(booking));
  }

  // "Get bins back" panel — request one or more Stored bins in a single step.
  const stored = (booking.bins || []).filter((b) => b.status === 'Stored');
  if (stored.length) {
    box.appendChild(retrievalPanel(booking, stored));
  }
}

function collectionPanel(booking) {
  const card = document.createElement('div');
  card.className = 'card';
  // Already-scheduled collection (if any) so we can show + reschedule it.
  const scheduled = (booking.jobs || []).find(
    (j) => j.type === 'collect_full' && j.status === 'Scheduled'
  );

  card.innerHTML = scheduled
    ? `<h3 style="margin-top:0;">Collection</h3>
       <p class="muted">Collection booked for <strong>${esc(scheduled.scheduled_date)}</strong>. Pick a new date to reschedule.</p>`
    : `<h3 style="margin-top:0;">Book a collection</h3>
       <p class="muted">Filled your bins? Choose a date and we'll come collect them.</p>`;

  const date = el('<input type="date" class="inline-date" />');
  date.min = TODAY_ISO;
  if (scheduled?.scheduled_date) date.value = scheduled.scheduled_date;
  card.appendChild(el('<label>Collection date</label>'));
  card.appendChild(date);

  const btn = mkBtn('green', scheduled ? '📅 Change date' : '📅 Book collection', async () => {
    if (!date.value) return toast('Pick a collection date', true);
    await api('POST', `/bookings/${booking.id}/book-collection`, { collectionDate: date.value });
    toast(scheduled ? 'Collection rescheduled' : 'Collection booked');
    reloadCurrent();
  });
  btn.style.marginTop = '12px';
  card.appendChild(btn);
  return card;
}

function retrievalPanel(booking, stored) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<h3 style="margin-top:0;">Get bins back</h3>
    <p class="muted">Tick the bins you want returned and pick a delivery-back date. A flat $30 delivery fee applies per retrieval.</p>`;

  const checks = stored.map((bin) => {
    const wrap = el(`<label class="check-row"><input type="checkbox" value="${esc(bin.id)}" /> <strong>${esc(bin.barcode)}</strong> <span class="muted">${esc(bin.sku_type)}</span></label>`);
    return wrap;
  });
  checks.forEach((c) => card.appendChild(c));

  const date = el(`<input type="date" class="inline-date" />`);
  date.min = TODAY_ISO;
  card.appendChild(el('<label>Delivery-back date</label>'));
  card.appendChild(date);

  const btn = mkBtn('', '↩ Request selected bins back', async () => {
    const ids = checks
      .map((c) => c.querySelector('input'))
      .filter((i) => i.checked)
      .map((i) => i.value);
    if (ids.length === 0) return toast('Tick at least one bin', true);
    if (!date.value) return toast('Pick a delivery-back date', true);
    const ok = await confirmDialog({
      title: 'Request bins back?',
      message: `Request ${ids.length} bin${ids.length === 1 ? '' : 's'} back on ${date.value}? A flat $30 delivery fee applies.`,
      confirmLabel: 'Request delivery',
    });
    if (!ok) return;
    await api('POST', `/bookings/${booking.id}/request-return`, {
      binIds: ids,
      deliveryBackDate: date.value,
    });
    toast(`Requested ${ids.length} bin${ids.length === 1 ? '' : 's'} back`);
    reloadCurrent();
  });
  btn.style.marginTop = '12px';
  card.appendChild(btn);
  return card;
}

let currentRef = null;
let loadSeq = 0;
let isRefreshing = false;

async function loadByRef(ref, { saveRef = true } = {}) {
  const seq = ++loadSeq;
  isRefreshing = true;
  const lookupBtn = $('#lookupBtn');
  if (lookupBtn) lookupBtn.disabled = true;
  try {
    const booking = await api('GET', `/bookings/${encodeURIComponent(ref)}`);
    if (seq !== loadSeq) return;
    currentRef = ref;
    if (saveRef) {
      try { sessionStorage.setItem(SAVED_REF_KEY, ref); } catch { /* private mode */ }
    }
    renderBooking(booking);
  } catch (e) {
    if (seq !== loadSeq) return;
    $('#result').innerHTML = `<div class="card muted">${esc(e.message)}</div>`;
  } finally {
    if (seq === loadSeq) {
      isRefreshing = false;
      if (lookupBtn) lookupBtn.disabled = false;
    }
  }
}

function renderBookingPicker(list) {
  const box = $('#result');
  box.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<h2 style="margin-top:0;">Multiple bookings found</h2>
    <p class="muted">Choose which booking to open:</p>`;
  list.forEach((b) => {
    const row = el(`<button type="button" class="picker-row">
      <strong><code>${esc(b.id)}</code></strong>
      <span class="muted">Delivery ${esc(b.delivery_date)} · ${esc(b.summary?.text || '')}</span>
    </button>`);
    row.addEventListener('click', () => {
      $('#lookup').value = b.id;
      loadByRef(b.id);
    });
    card.appendChild(row);
  });
  box.appendChild(card);
}

async function loadByPhone(phone) {
  const list = await api('GET', `/bookings/by-phone/${encodeURIComponent(phone)}`);
  if (list.length === 0) {
    $('#result').innerHTML = `<div class="card muted">No bookings found for that phone.</div>`;
    return;
  }
  let savedRef = null;
  try { savedRef = sessionStorage.getItem(SAVED_REF_KEY); } catch { /* private mode */ }
  if (savedRef && list.some((b) => b.id === savedRef)) {
    await loadByRef(savedRef);
    return;
  }
  if (list.length === 1) {
    await loadByRef(list[0].id);
    return;
  }
  renderBookingPicker(list);
}

function reloadCurrent() {
  if (currentRef) loadByRef(currentRef);
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

// Scan a bin's barcode (e.g. the bin sitting in front of you) to open the
// booking it belongs to.
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

// Keep the loaded booking fresh so customer-visible status changes appear
// without a manual lookup. Skips a tick if the user is typing/selecting inside
// the result area (a date field or checkbox) so it never interrupts them.
setInterval(() => {
  if (!currentRef || document.hidden || isRefreshing) return;
  const active = document.activeElement;
  if (active && $('#result')?.contains(active)) return;
  // Don't yank a chain-of-custody panel closed mid-read.
  if ($('#result')?.querySelector('details.custody[open]')) return;
  // Don't wipe in-progress selections (ticked retrieval boxes, touched dates).
  if ($('#result')?.querySelector('input[type=checkbox]:checked')) return;
  if ($('#result')?.querySelector('input[type=date][data-dirty]')) return;
  reloadCurrent();
}, 4000);

// Mark date inputs the user has actually touched (prefilled values don't fire
// 'input'), so polling pauses only for in-progress edits.
$('#result').addEventListener('input', (e) => {
  if (e.target.matches?.('input[type=date]')) e.target.dataset.dirty = '1';
});

// Auto-load from ?ref=, and show a confirmation banner if ?new=1.
const params = new URLSearchParams(location.search);
const ref = params.get('ref');
if (ref) {
  $('#lookup').value = ref;
  if (params.get('new') === '1') {
    $('#confirmBanner').innerHTML = `<div class="banner">✅ <strong>Booking confirmed!</strong> Reference <code>${esc(ref)}</code>. We'll deliver your empty bins on the chosen date.<br><span class="muted">Drop-off and collection are free — a flat $30 per delivery applies only when you request stored bins back.</span></div>`;
  }
  loadByRef(ref);
}
