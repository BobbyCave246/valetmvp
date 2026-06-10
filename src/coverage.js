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

export function isCovered(area) {
  if (!area) return false;
  const norm = String(area).trim().toLowerCase();
  return COVERAGE_AREAS.some((a) => a.toLowerCase() === norm);
}
