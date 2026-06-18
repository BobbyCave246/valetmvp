// Booking form: serviceability gate → per-SKU steppers + price → date + window
// → contact → submit. Submits area + delivery window to /api/bookings.

const SKUS = [
  { key: 'bin', label: 'Standard bin', price: 15, desc: '80 L tote — books, clothes, kitchenware' },
  { key: 'wardrobe', label: 'Wardrobe box', price: 25, desc: 'Hanging garments stay crease-free' },
];

const counts = { bin: 0, wardrobe: 0 };
let chosenArea = null;
let chosenSlot = null;
let earliestDate = null;
let leadDays = 1;

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
    credentials: 'same-origin',
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
  const data = await api('GET', '/serviceability');
  const { areas, villages } = data;
  if (data.earliestDate) {
    earliestDate = data.earliestDate;
    $('#deliveryDate').min = earliestDate;
  }
  if (data.leadDays != null) leadDays = data.leadDays;
  sel.innerHTML =
    '<option value="" disabled selected>Select your area…</option>' +
    areas.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('') +
    `<option value="${OTHER}">My area isn't listed</option>`;
  $('#village').innerHTML =
    '<option value="" disabled selected>Select your village…</option>' +
    (villages || []).map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
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
    $('#waitlist').innerHTML = `
      <div class="waitlist-success">
        <strong>You're on the list!</strong>
        <p class="muted" style="margin:8px 0 0;">We'll email you when Store All Valet expands to your area. In the meantime, save our site — no account needed to book once we're nearby.</p>
      </div>`;
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
        <div><strong>${sku.label}</strong> <span class="price">$${sku.price}/mo</span></div>
        <div class="muted">${sku.desc}</div>
      </div>
      <div class="stepper">
        <button type="button" data-act="dec" data-sku="${sku.key}" aria-label="Remove one ${sku.label}">−</button>
        <span id="count-${sku.key}" aria-live="polite" aria-label="${sku.label} quantity">0</span>
        <button type="button" data-act="inc" data-sku="${sku.key}" aria-label="Add one ${sku.label}">+</button>
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
  $('#total').textContent = `$${total}`;
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
      chip.setAttribute('aria-pressed', 'false');
      chip.textContent = s.available ? s.label : `${s.label} — Full`;
      chip.addEventListener('click', () => {
        chosenSlot = s.key;
        box.querySelectorAll('.slot-chip').forEach((c) => {
          c.classList.remove('selected');
          c.setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('selected');
        chip.setAttribute('aria-pressed', 'true');
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
// Report a validation problem: announce via toast and move focus to the field
// so keyboard/screen-reader users land on what needs fixing.
function fail(msg, selector) {
  toast(msg, true);
  if (selector) $(selector)?.focus();
  return false;
}

$('#submitBtn').addEventListener('click', async () => {
  const skuBreakdown = {};
  for (const k of Object.keys(counts)) if (counts[k] > 0) skuBreakdown[k] = counts[k];

  if (!chosenArea) return fail('Confirm your area first', '#area');
  if (Object.keys(skuBreakdown).length === 0) return fail('Add at least one bin', '#skuList button[data-act="inc"]');
  if (!$('#deliveryDate').value) return fail('Pick a delivery date', '#deliveryDate');
  if (!chosenSlot) return fail('Pick a delivery window', '#slotList button:not(:disabled)');

  // Structured address: village + house/lot number (no free-text street —
  // Coverley has no public address dataset to validate against, so we capture
  // structure instead).
  const village = $('#village').value;
  const houseNo = $('#houseNo').value.trim();
  if (!$('#name').value.trim()) return fail('Enter your name', '#name');
  if (!$('#phone').value.trim()) return fail('Enter your phone number', '#phone');
  const email = $('#email').value.trim();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email', '#email');
  if (!village) return fail('Select your village', '#village');
  if (!houseNo) return fail('Enter your house / lot number', '#houseNo');

  const payload = {
    name: $('#name').value.trim(),
    phone: $('#phone').value.trim(),
    email,
    address: `House ${houseNo}, ${village}`,
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
// Prefill SKU counts from ?sku= query param (landing pricing CTAs).
const skuParam = new URLSearchParams(location.search).get('sku');
if (skuParam === 'bin' || skuParam === 'standard') counts.bin = 1;
if (skuParam === 'wardrobe') counts.wardrobe = 1;

loadAreas().catch((e) => toast(e.message, true));
renderSkus();
if (skuParam) {
  for (const sku of SKUS) {
    const el = $(`#count-${sku.key}`);
    if (el) el.textContent = counts[sku.key];
  }
}
updateTotal();
