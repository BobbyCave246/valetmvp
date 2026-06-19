// Browser mirror of src/driver-jobs.js — sort order and maps deep links.

const SLOT_ORDER = { am: 0, pm: 1 };

function customerAddress(customer) {
  if (!customer) return '';
  return [customer.address, customer.postcode].filter(Boolean).join(', ');
}

function sortTodayJobs(jobs) {
  return [...jobs].sort((a, b) => {
    const sa = SLOT_ORDER[a.scheduled_slot] ?? 9;
    const sb = SLOT_ORDER[b.scheduled_slot] ?? 9;
    if (sa !== sb) return sa - sb;
    return customerAddress(a.booking?.customer).localeCompare(customerAddress(b.booking?.customer));
  });
}

function mapsUrl(customer) {
  const dest = customerAddress(customer);
  if (!dest) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}
