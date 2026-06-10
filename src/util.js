// Small shared helpers for the route modules.

// The bin SKU catalogue — shared by booking validation and bin intake.
export const VALID_SKUS = ['bin', 'wardrobe', 'odd'];

export function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
