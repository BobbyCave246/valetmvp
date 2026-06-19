// Job type and delivery-window labels — refreshed from the API at boot.

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
let SERVICE_TODAY = new Date().toISOString().slice(0, 10);

function slotLabel(key) {
  return key ? SLOT_LABELS[key] || key : '';
}

function serviceToday() {
  return SERVICE_TODAY;
}

async function refreshServiceToday() {
  try {
    const data = await api.get('/serviceability');
    if (data.todayDate) SERVICE_TODAY = data.todayDate;
    if (Array.isArray(data.slots)) {
      SLOT_LABELS = Object.fromEntries(data.slots.map((s) => [s.key, s.label]));
    }
  } catch {
    /* keep last known today */
  }
}

async function initSlotLabels() {
  await refreshServiceToday();
}
