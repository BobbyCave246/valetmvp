// Pure helpers for the driver jobs board — sort order and maps deep links.
// Tested in Node; mirrored usage in public/driver/app.js.

const SLOT_ORDER = { am: 0, pm: 1 };

/** Full address string for sort + maps (address + postcode). */
export function customerAddress(customer) {
  if (!customer) return '';
  return [customer.address, customer.postcode].filter(Boolean).join(', ');
}

/** Sort Today jobs: delivery window (am before pm), then address. */
export function sortTodayJobs(jobs) {
  return [...jobs].sort((a, b) => {
    const slotA = SLOT_ORDER[a.scheduled_slot] ?? 9;
    const slotB = SLOT_ORDER[b.scheduled_slot] ?? 9;
    if (slotA !== slotB) return slotA - slotB;
    return customerAddress(a.booking?.customer).localeCompare(
      customerAddress(b.booking?.customer)
    );
  });
}

/** Google Maps universal navigation URL for a customer address. */
export function mapsUrl(customer) {
  const dest = customerAddress(customer);
  if (!dest) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}
