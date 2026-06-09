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

async function api(method, path, body) {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

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
        if (!confirm('Close this bin for good?')) return;
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
      toast('Photo added — collection scheduled');
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
  const head = document.createElement('div');
  head.className = 'card';
  head.innerHTML = `
    <h2>Booking <code>${booking.id}</code></h2>
    <div class="muted">${booking.bin_count} bins (${sku}) · delivery ${booking.delivery_date}</div>
    <div class="muted" style="margin-top:6px;"><strong>${booking.summary.text}</strong></div>`;
  box.appendChild(head);

  const binsCard = document.createElement('div');
  binsCard.className = 'card';
  binsCard.innerHTML = `<h3 style="margin-top:0;">Your bins</h3>`;

  if (!booking.bins || booking.bins.length === 0) {
    binsCard.innerHTML += `<p class="muted">No bins assigned yet — we'll bind physical bins to your booking before delivery.</p>`;
  } else {
    booking.bins.forEach((bin) => {
      const hasThumb = bin.photo_ref && bin.photo_ref.startsWith('data:');
      const row = document.createElement('div');
      row.className = 'bin-row';
      const left = document.createElement('div');
      left.innerHTML = `<strong>${bin.barcode}</strong> <span class="muted">${bin.sku_type}</span>
        <div class="muted">${STATUS_COPY[bin.status] || bin.status || 'pending'}${bin.photo_ref && !hasThumb ? ' · 📷 photo on file' : ''}</div>
        ${hasThumb ? `<img class="thumb" src="${bin.photo_ref}" alt="contents photo" />` : ''}`;
      const right = document.createElement('div');
      right.innerHTML = `<span class="pill">${bin.status || 'pending'}</span>`;
      row.appendChild(left);
      row.appendChild(right);
      binsCard.appendChild(row);
      const actions = binActions(bin);
      if (actions.children.length) {
        actions.style.marginTop = '4px';
        binsCard.appendChild(actions);
      }
    });
  }
  box.appendChild(binsCard);

  // "Get bins back" panel — request one or more Stored bins in a single step.
  const stored = (booking.bins || []).filter((b) => b.status === 'Stored');
  if (stored.length) {
    box.appendChild(retrievalPanel(stored));
  }
}

function retrievalPanel(stored) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<h3 style="margin-top:0;">Get bins back</h3>
    <p class="muted">Tick the bins you want returned and pick a delivery-back date.</p>`;

  const checks = stored.map((bin) => {
    const wrap = el(`<label class="check-row"><input type="checkbox" value="${bin.id}" /> <strong>${bin.barcode}</strong> <span class="muted">${bin.sku_type}</span></label>`);
    return wrap;
  });
  checks.forEach((c) => card.appendChild(c));

  const date = el(`<input type="date" class="inline-date" />`);
  card.appendChild(el('<label>Delivery-back date</label>'));
  card.appendChild(date);

  const btn = mkBtn('', '↩ Request selected bins back', async () => {
    const ids = checks
      .map((c) => c.querySelector('input'))
      .filter((i) => i.checked)
      .map((i) => i.value);
    if (ids.length === 0) return toast('Tick at least one bin', true);
    if (!date.value) return toast('Pick a delivery-back date', true);
    for (const id of ids) {
      await api('POST', `/bins/${id}/request-return`, { deliveryBackDate: date.value });
    }
    toast(`Requested ${ids.length} bin${ids.length === 1 ? '' : 's'} back`);
    reloadCurrent();
  });
  btn.style.marginTop = '12px';
  card.appendChild(btn);
  return card;
}

let currentRef = null;
async function loadByRef(ref) {
  try {
    const booking = await api('GET', `/bookings/${encodeURIComponent(ref)}`);
    currentRef = ref;
    renderBooking(booking);
  } catch (e) {
    $('#result').innerHTML = `<div class="card muted">${e.message}</div>`;
  }
}

async function loadByPhone(phone) {
  const list = await api('GET', `/bookings/by-phone/${encodeURIComponent(phone)}`);
  if (list.length === 0) {
    $('#result').innerHTML = `<div class="card muted">No bookings found for that phone.</div>`;
    return;
  }
  // Load full detail of the most recent booking.
  await loadByRef(list[0].id);
}

function reloadCurrent() {
  if (currentRef) loadByRef(currentRef);
}

$('#lookupBtn').addEventListener('click', () => {
  const v = $('#lookup').value.trim();
  if (!v) return;
  if (v.startsWith('book_')) loadByRef(v);
  else loadByPhone(v);
});
$('#lookup').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#lookupBtn').click(); });

// Keep the loaded booking fresh so customer-visible status changes appear
// without a manual lookup. Skips a tick if the user is typing/selecting inside
// the result area (a date field or checkbox) so it never interrupts them.
setInterval(() => {
  if (!currentRef || document.hidden) return;
  const active = document.activeElement;
  if (active && $('#result')?.contains(active)) return;
  reloadCurrent();
}, 4000);

// Auto-load from ?ref=, and show a confirmation banner if ?new=1.
const params = new URLSearchParams(location.search);
const ref = params.get('ref');
if (ref) {
  $('#lookup').value = ref;
  if (params.get('new') === '1') {
    $('#confirmBanner').innerHTML = `<div class="banner">✅ Booking confirmed! Reference <code>${ref}</code>. We'll deliver your empty bins on the chosen date.</div>`;
  }
  loadByRef(ref);
}
