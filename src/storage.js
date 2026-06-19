// Supabase Storage for bin contents photos. Uses fetch (no SDK) — same pattern
// as notify.js. When SUPABASE_SERVICE_ROLE_KEY is unset, uploads are rejected
// with a clear error; local dev without storage can still run everything else.

const REF_PREFIX = 'storage:';

let warnedMissingStorage = false;

/** Supabase project URL from env or parsed from DATABASE_URL. */
export function getSupabaseUrl() {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL.replace(/\/$/, '');
  const url = process.env.DATABASE_URL || '';
  const m = url.match(/postgres\.([a-z0-9]+)/i);
  return m ? `https://${m[1]}.supabase.co` : null;
}

export function getStorageBucket() {
  return process.env.SUPABASE_STORAGE_BUCKET || 'contents-photos';
}

export function isStorageConfigured() {
  return !!(getSupabaseUrl() && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Parse a data:image/...;base64,... URL from the client. */
export function parsePhotoDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) return null;
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0) return null;
  return { contentType: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], buffer };
}

/** Turn a stored photo_ref into a browser-loadable URL (public bucket). */
export function resolvePhotoUrl(photoRef) {
  if (!photoRef) return null;
  if (photoRef.startsWith('data:image/')) return photoRef;
  if (!photoRef.startsWith(REF_PREFIX)) return null;

  const base = getSupabaseUrl();
  if (!base) return null;

  const rest = photoRef.slice(REF_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const bucket = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  return `${base}/storage/v1/object/public/${bucket}/${encodeURI(path)}`;
}

export function enrichBin(bin) {
  if (!bin) return bin;
  const photoUrl = resolvePhotoUrl(bin.photo_ref);
  return photoUrl ? { ...bin, photoUrl } : bin;
}

export function enrichBins(bins) {
  return (bins || []).map(enrichBin);
}

/**
 * Upload JPEG/PNG bytes to Supabase Storage. Returns durable photo_ref
 * (storage:bucket/path). Throws on failure; caller maps to HTTP status.
 */
export async function uploadContentsPhoto({ binId, imageBuffer, contentType = 'image/jpeg' }) {
  if (!isStorageConfigured()) {
    if (!warnedMissingStorage) {
      console.log('[storage] SUPABASE_SERVICE_ROLE_KEY not set — photo upload disabled.');
      warnedMissingStorage = true;
    }
    const err = new Error('Photo storage is not configured on this server');
    err.status = 503;
    throw err;
  }

  const maxBytes = Number(process.env.PHOTO_MAX_BYTES || 2 * 1024 * 1024);
  if (imageBuffer.length > maxBytes) {
    const err = new Error('Image is too large — please use a smaller photo');
    err.status = 413;
    throw err;
  }

  const bucket = getStorageBucket();
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const path = `${binId}/${Date.now()}.${ext}`;
  const base = getSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const resp = await fetch(`${base}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: imageBuffer,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error(`[storage] upload failed (${resp.status}): ${detail}`);
    const err = new Error('Could not save photo — try again later');
    err.status = 502;
    throw err;
  }

  return `${REF_PREFIX}${bucket}/${path}`;
}
