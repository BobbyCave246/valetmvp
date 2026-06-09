// "My booking" page — lookup by reference or phone, view bins + statuses,
// and the per-bin customer actions (photo stub, request back, re-store, close).

const $ = (s) => document.querySelector(s);

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

  if (bin.status === 'Out for filling') {
    const btn = mkBtn('green', '📷 Add contents photo', async () => {
      await api('POST', `/bins/${bin.barcode}/photo`, {});
      toast('Photo added — collection scheduled');
      reloadCurrent();
    });
    wrap.appendChild(btn);
  }

  if (bin.status === 'Stored') {
    const btn = mkBtn('', '↩ Request this bin back', async () => {
      const date = prompt('Delivery-back date (YYYY-MM-DD)?');
      if (!date) return;
      await api('POST', `/bins/${bin.id}/request-return`, { deliveryBackDate: date });
      toast('Retrieval requested');
      reloadCurrent();
    });
    wrap.appendChild(btn);
  }

  if (bin.status === 'Returned to customer') {
    wrap.appendChild(
      mkBtn('', '📦 Store this again', async () => {
        const date = prompt('Collection date (YYYY-MM-DD)?');
        if (!date) return;
        await api('POST', `/bins/${bin.id}/request-restore`, { collectionDate: date });
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
      const row = document.createElement('div');
      row.className = 'bin-row';
      const left = document.createElement('div');
      left.innerHTML = `<strong>${bin.barcode}</strong> <span class="muted">${bin.sku_type}</span>
        <div class="muted">${STATUS_COPY[bin.status] || bin.status || 'pending'}${bin.photo_ref ? ' · 📷 photo on file' : ''}</div>`;
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
