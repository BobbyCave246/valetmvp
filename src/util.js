// Small shared helpers for the route modules.

export function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
