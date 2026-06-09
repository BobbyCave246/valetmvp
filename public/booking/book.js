// Booking form: serviceability gate → per-SKU steppers + price → date + window
// → contact → submit. Submits area + delivery window to /api/bookings.

const SKUS = [
  { key: 'bin', label: 'Standard bin', price: 15, desc: '80 L tote — books, clothes, kitchenware' },
  { key: 'wardrobe', label: 'Wardrobe box', price: 25, desc: 'Hanging garments stay crease-free' },
  { key: 'odd', label: 'Odd / bulky item', price: 20, desc: 'Bikes, skis, anything awkward' },
];

const counts = { bin: 0, wardrobe: 0, odd: 0 };
let chosenArea = null;
let chosenSlot = null;

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

// ---- serviceability gate ----------------------------------------------------
const OTHER = '__other__';

async function loadAreas() {
  const sel = $('#area');
  sel.innerHTML = '<option value="" disabled selected>Loading areas…</option>';
  const { areas } = await api('GET', '/serviceability');
  sel.innerHTML =
    '<option value="" disabled selected>Select your area…</option>' +
    areas.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('') +
    `<option value="${OTHER}">My area isn't listed</option>`;
}

$('#area').addEventListener('change', () => {
  $('#waitlist').style.display = $('#area').value === OTHER ? 'block' : 'none';
});

$('#areaContinue').addEventListener('click', () => {
  const v = $('#area').value;
  if (!v) return toast('Pick your area', true);
  if (v === OTHER) {
    $('#waitlist').style.display = 'block';
    return;
  }
  chosenArea = v;
  $('#areaCard').querySelector('h2').textContent = `Delivering to ${v} ✓`;
  $('#waitlist').style.display = 'none';
  $('#bookingForm').style.display = 'block';
  $('#bookingForm').scrollIntoView({ behavior: 'smooth' });
});

$('#leadSubmit').addEventListener('click', async () => {
  const email = $('#leadEmail').value.trim();
  if (!email) return toast('Enter your email', true);
  try {
    await api('POST', '/leads', { email, area: $('#area').value === OTHER ? null : $('#area').value });
    toast("Thanks — we'll be in touch when we reach you");
    $('#leadEmail').value = '';
  } catch (e) {
    toast(e.message, true);
  }
});

// ---- items ------------------------------------------------------------------
function renderSkus() {
  const box = $('#skuList');
  box.innerHTML = '';
  SKUS.forEach((sku) => {
    const row = document.createElement('div');
    row.className = 'sku-row';
    row.innerHTML = `
      <div>
        <div><strong>${sku.label}</strong> <span class="price">£${sku.price}/mo</span></div>
        <div class="muted">${sku.desc}</div>
      </div>
      <div class="stepper">
        <button data-act="dec" data-sku="${sku.key}">−</button>
        <span id="count-${sku.key}">0</span>
        <button data-act="inc" data-sku="${sku.key}">+</button>
      </div>`;
    box.appendChild(row);
  });

  box.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sku = btn.dataset.sku;
      counts[sku] = Math.max(0, counts[sku] + (btn.dataset.act === 'inc' ? 1 : -1));
      $(`#count-${sku}`).textContent = counts[sku];
      updateTotal();
    });
  });
}

function updateTotal() {
  const total = SKUS.reduce((sum, s) => sum + counts[s.key] * s.price, 0);
  $('#total').textContent = `£${total}`;
}

// ---- delivery date + window -------------------------------------------------
async function loadSlots() {
  const date = $('#deliveryDate').value;
  const box = $('#slotList');
  chosenSlot = null;
  if (!date) {
    box.className = 'muted';
    box.textContent = 'Pick a date to see available windows.';
    return;
  }
  try {
    const { slots } = await api('GET', `/availability?date=${encodeURIComponent(date)}`);
    box.className = 'slot-list';
    box.innerHTML = '';
    slots.forEach((s) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'slot-chip' + (s.available ? '' : ' full');
      chip.disabled = !s.available;
      chip.textContent = s.available ? s.label : `${s.label} — Full`;
      chip.addEventListener('click', () => {
        chosenSlot = s.key;
        box.querySelectorAll('.slot-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
      });
      box.appendChild(chip);
    });
  } catch (e) {
    box.className = 'muted';
    box.textContent = e.message;
  }
}

$('#deliveryDate').addEventListener('change', loadSlots);

// ---- submit -----------------------------------------------------------------
$('#submitBtn').addEventListener('click', async () => {
  const skuBreakdown = {};
  for (const k of Object.keys(counts)) if (counts[k] > 0) skuBreakdown[k] = counts[k];

  if (!chosenArea) return toast('Confirm your area first', true);
  if (Object.keys(skuBreakdown).length === 0) return toast('Add at least one bin', true);
  if (!$('#deliveryDate').value) return toast('Pick a delivery date', true);
  if (!chosenSlot) return toast('Pick a delivery window', true);

  const payload = {
    name: $('#name').value.trim(),
    phone: $('#phone').value.trim(),
    email: $('#email').value.trim(),
    address: $('#address').value.trim(),
    area: chosenArea,
    deliveryDate: $('#deliveryDate').value,
    deliverySlot: chosenSlot,
    skuBreakdown,
  };
  if (!payload.name || !payload.phone) {
    return toast('Name and phone are required', true);
  }

  // Guard against double-submission (duplicate bookings).
  const btn = $('#submitBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Creating…';
  try {
    const data = await api('POST', '/bookings', payload);
    location.href = `booking.html?ref=${encodeURIComponent(data.booking.id)}&new=1`;
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = original;
    // If the chosen window filled up while they typed, refresh availability.
    if (/window is full/i.test(e.message)) loadSlots();
  }
});

// ---- boot -------------------------------------------------------------------
// Earliest selectable date = tomorrow (server enforces the real lead time).
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
$('#deliveryDate').min = tomorrow.toISOString().slice(0, 10);

loadAreas().catch((e) => toast(e.message, true));
renderSkus();
updateTotal();
