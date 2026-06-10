// Service-area coverage. The MVP serves ONLY The Villages at Coverley
// (Christ Church, Barbados). Set COVERAGE_AREAS (comma-separated) to override
// without a code change when the service area grows.

const DEFAULT_AREAS = [
  'The Villages at Coverley',
];

export const COVERAGE_AREAS = (process.env.COVERAGE_AREAS || DEFAULT_AREAS.join(','))
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);

export function listAreas() {
  return COVERAGE_AREAS;
}

// The named villages within The Villages at Coverley. Drives the structured
// address form (village + house number) on the booking site. No authoritative
// public address dataset exists for the development, so we capture structure
// rather than validate against a canonical list. Override via VILLAGES env var
// (comma-separated) as the development grows.
const DEFAULT_VILLAGES = [
  'Cherry South',
  'Ackee West',
  'Sugar Apple',
  'Residences at Coverley',
];

export const VILLAGES = (process.env.VILLAGES || DEFAULT_VILLAGES.join(','))
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

export function listVillages() {
  return VILLAGES;
}

export function isCovered(area) {
  if (!area) return false;
  const norm = String(area).trim().toLowerCase();
  return COVERAGE_AREAS.some((a) => a.toLowerCase() === norm);
}
