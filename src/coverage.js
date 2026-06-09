// Service-area coverage. Set COVERAGE_AREAS (comma-separated) to your REAL
// service areas. The placeholder list below is only so the demo runs; replace
// it (or set the env var) before going live.

const PLACEHOLDER = [
  'Bridgetown',
  'Holetown',
  'Oistins',
  'Speightstown',
  'Worthing',
];

export const COVERAGE_AREAS = (process.env.COVERAGE_AREAS || PLACEHOLDER.join(','))
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);

export function listAreas() {
  return COVERAGE_AREAS;
}

export function isCovered(area) {
  if (!area) return false;
  const norm = String(area).trim().toLowerCase();
  return COVERAGE_AREAS.some((a) => a.toLowerCase() === norm);
}
