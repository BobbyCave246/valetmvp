// Outbound notifications. Booking confirmation + Job-done email/SMS.
//
// Graceful drop-in: with no RESEND_API_KEY / TWILIO_* set these no-op (log once),
// so local dev, demos and CI run unchanged.

import { slotLabel } from './slots.js';
import { getBooking, getCustomer } from './db.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const SKU_META = {
  bin: { label: 'Standard bin', price: 15 },
  wardrobe: { label: 'Wardrobe box', price: 25 },
  odd: { label: 'Odd / bulky item', price: 20 },
};

const JOB_DONE_COPY = {
  deliver_empty: {
    subject: 'Empty bins delivered',
    headline: 'Your empty bins have been delivered',
    nextStep: 'Fill your bins and book a collection date when you are ready.',
  },
  collect_full: {
    subject: 'Bins collected',
    headline: 'We collected your filled bins',
    nextStep: 'They are on the way to our warehouse. We will store them shortly.',
  },
  deliver_back: {
    subject: 'Bins returned',
    headline: 'Your bins are back with you',
    nextStep: 'Re-store them or close bins you no longer need from My booking.',
  },
};

let warnedMissingResend = false;
let warnedMissingTwilio = false;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderBookingHtml({ booking, customer, skuBreakdown }) {
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

function renderJobDoneHtml({ booking, customer, job, copy }) {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#222;max-width:560px;margin:0 auto;">
    <h2 style="margin:0 0 8px;">📦 ${esc(copy.headline)}</h2>
    <p style="color:#6a6a6a;margin:0 0 16px;">Hi${customer.name ? ` ${esc(customer.name)}` : ''},</p>
    <p>Booking reference: <strong>${esc(booking.id)}</strong></p>
    <p>${esc(copy.nextStep)}</p>
    <p style="color:#6a6a6a;font-size:13px;">Track your bins any time at My booking using your reference or phone number.</p>
  </div>`;
}

function jobDoneSmsText({ booking, copy }) {
  return `${copy.headline} — ref ${booking.id}. ${copy.nextStep}`;
}

async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (!warnedMissingResend) {
      console.log('[notify] RESEND_API_KEY not set — emails skipped (stub mode).');
      warnedMissingResend = true;
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
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error(`[notify] Resend send failed (${resp.status}): ${detail}`);
    return false;
  }
  return true;
}

async function sendTwilioSms({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    if (!warnedMissingTwilio) {
      console.log('[notify] TWILIO_* not set — SMS skipped (stub mode).');
      warnedMissingTwilio = true;
    }
    return false;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error(`[notify] Twilio send failed (${resp.status}): ${detail}`);
    return false;
  }
  return true;
}

// Send a booking confirmation. Never throws.
export async function sendBookingConfirmation({ booking, customer, skuBreakdown }) {
  try {
    if (!customer?.email) return false;
    return await sendResendEmail({
      to: customer.email,
      subject: `Booking confirmed — ${booking.id}`,
      html: renderBookingHtml({ booking, customer, skuBreakdown }),
    });
  } catch (err) {
    console.error('[notify] booking confirmation email error:', err);
    return false;
  }
}

// Email on Job Done. Never throws.
export async function sendJobDoneEmail({ booking, customer, job }) {
  try {
    if (!customer?.email) return false;
    const copy = JOB_DONE_COPY[job.type];
    if (!copy) return false;
    return await sendResendEmail({
      to: customer.email,
      subject: `${copy.subject} — ${booking.id}`,
      html: renderJobDoneHtml({ booking, customer, job, copy }),
    });
  } catch (err) {
    console.error('[notify] job done email error:', err);
    return false;
  }
}

// SMS on Job Done. Never throws.
export async function sendJobDoneSms({ booking, customer, job }) {
  try {
    if (!customer?.phone) return false;
    const copy = JOB_DONE_COPY[job.type];
    if (!copy) return false;
    return await sendTwilioSms({
      to: customer.phone,
      body: jobDoneSmsText({ booking, copy }),
    });
  } catch (err) {
    console.error('[notify] job done SMS error:', err);
    return false;
  }
}

// Dispatch email + SMS after completeJob. Never throws.
export async function sendJobDoneNotifications({ job, bookingId }) {
  try {
    const booking = await getBooking(bookingId);
    if (!booking) return;
    const customer = await getCustomer(booking.customer_id);
    if (!customer) return;
    const payload = { booking, customer, job };
    await Promise.all([sendJobDoneEmail(payload), sendJobDoneSms(payload)]);
  } catch (err) {
    console.error('[notify] job done dispatch error:', err);
  }
}

export { JOB_DONE_COPY };
