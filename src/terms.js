// Customer terms & conditions. The text lives outside the app (TERMS_URL);
// each booking records the version the customer accepted, so a later change
// to the terms never rewrites what an earlier customer agreed to. Bump
// TERMS_VERSION whenever the document changes.
export const TERMS_VERSION = process.env.TERMS_VERSION || 'draft';
export const TERMS_URL = process.env.TERMS_URL || null;
