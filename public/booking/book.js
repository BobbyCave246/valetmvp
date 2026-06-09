// Booking form: per-SKU steppers, running monthly price, submit → /api/bookings.

const SKUS = [
  { key: 'bin', label: 'Standard bin', price: 15, desc: '80 L tote — books, clothes, kitchenware' },
  { key: 'wardrobe', label: 'Wardrobe box', price: 25, desc: 'Hanging garments stay crease-free' },
  { key: 'odd', label: 'Odd / bulky item', price: 20, desc: 'Bikes, skis, anything awkward' },
];

const counts = { bin: 0, wardrobe: 0, odd: 0 };

const $ = (s) => document.querySelector(s);

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  setTimeout(() => (t.className = ''), 2600);
}

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

$('#submitBtn').addEventListener('click', async () => {
  const skuBreakdown = {};
  for (const k of Object.keys(counts)) if (counts[k] > 0) skuBreakdown[k] = counts[k];

  const payload = {
    name: $('#name').value.trim(),
    phone: $('#phone').value.trim(),
    email: $('#email').value.trim(),
    address: $('#address').value.trim(),
    deliveryDate: $('#deliveryDate').value,
    skuBreakdown,
  };

  if (Object.keys(skuBreakdown).length === 0) return toast('Add at least one bin', true);
  if (!payload.name || !payload.phone || !payload.deliveryDate) {
    return toast('Name, phone and delivery date are required', true);
  }

  try {
    const r = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
    location.href = `booking.html?ref=${encodeURIComponent(data.booking.id)}&new=1`;
  } catch (e) {
    toast(e.message, true);
  }
});

renderSkus();
updateTotal();
