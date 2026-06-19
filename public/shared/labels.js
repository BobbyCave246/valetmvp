// Job type and delivery-window labels — slot labels refresh from the API at boot.

const JOB_LABEL = {
  deliver_empty: 'Deliver empty bins',
  collect_full: 'Collect filled bins',
  deliver_back: 'Deliver bins back',
};

const JOB_ICON = {
  deliver_empty: '📦',
  collect_full: '🔄',
  deliver_back: '🏠',
};

let SLOT_LABELS = { am: 'Morning (8am–12pm)', pm: 'Afternoon (12–5pm)' };

function slotLabel(key) {
  return key ? SLOT_LABELS[key] || key : '';
}

async function initSlotLabels() {
  try {
    const data = await api.get('/serviceability');
    if (Array.isArray(data.slots)) {
      SLOT_LABELS = Object.fromEntries(data.slots.map((s) => [s.key, s.label]));
    }
  } catch {
    /* fallback labels stand */
  }
}
