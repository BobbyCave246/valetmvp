// Outbound notifications. Currently: the customer booking-confirmation email.
//
// Graceful drop-in: with no RESEND_API_KEY set this no-ops (logs once), so local
// dev, demos and CI run unchanged. Set RESEND_API_KEY (and optionally EMAIL_FROM)
// and it sends a real email via Resend's HTTP API — no SDK/npm dependency, just
// fetch, to match the express/postgres/dotenv-only stack.

import { slotLabel } from './slots.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// SKU labels + monthly prices. Source of truth for what customers see is the
// booking form (public/booking/book.js); kept in sync here for the email total.
const SKU_META = {
  bin: { label: 'Standard bin', price: 15 },
  wardrobe: { label: 'Wardrobe box', price: 25 },
  odd: { label: 'Odd / bulky item', price: 20 },
};

let warnedMissingKey = false;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderHtml({ booking, customer, skuBreakdown }) {
  const lines = Object.entries(skuBreakdown || {})
    .filter(([, n]) => n > 0)
    .map(([sku, n]) => {
      const meta = SKU_META[sku] || { label: sku, price: 0 };
      return `<li>${n} × ${esc(meta.label)} — $${meta.price}/mo each</li>`;
    })
    .join('');
  const monthly = Object.entries(skuBreakdown || {}).reduce(
    (sum, [sku, n]) => sum + n * (SKU_META[sku]?.price || 0),
    0,
  );
  const slot = esc(slotLabel(booking.delivery_slot));

  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:560px;margin:0 auto;">
    <h2 style="margin:0 0 8px;">📦 Booking confirmed</h2>
    <p style="color:#6a6a6a;margin:0 0 16px;">Thanks${customer.name ? `, ${esc(customer.name)}` : ''} — your bins are booked.</p>
    <p>Your booking reference is <strong>${esc(booking.id)}</strong>. Keep it to look up your booking any time.</p>
    <ul>${lines}</ul>
    <p><strong>Estimated monthly storage:</strong> $${monthly}/mo</p>
    <p><strong>Delivery of empty bins:</strong> ${esc(booking.delivery_date)} · ${slot}</p>
    <p style="background:#faf8f5;border:1px solid #ebebeb;border-radius:10px;padding:12px 14px;">
      Drop-off of empty bins and pick-up of your filled bins are <strong>free</strong>.
      A flat <strong>$30 per delivery</strong> applies only when you ask for stored bins back.
    </p>
    <p style="color:#6a6a6a;font-size:13px;">We'll be in touch about your delivery. Reply to this email if anything changes.</p>
  </div>`;
}

// Send a booking confirmation. Never throws — a mail failure must not fail the
// booking. Returns true if an email was actually dispatched.
export async function sendBookingConfirmation({ booking, customer, skuBreakdown }) {
  try {
    if (!customer?.email) return false;

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      if (!warnedMissingKey) {
        console.log('[notify] RESEND_API_KEY not set — booking confirmation email skipped (stub mode).');
        warnedMissingKey = true;
      }
      return false;
    }

    const from = process.env.EMAIL_FROM || 'Store All Valet <onboarding@resend.dev>';
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [customer.email],
        subject: `Booking confirmed — ${booking.id}`,
        html: renderHtml({ booking, customer, skuBreakdown }),
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error(`[notify] Resend send failed (${resp.status}): ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[notify] booking confirmation email error:', err);
    return false;
  }
}
