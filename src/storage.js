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

// How long a signed photo link stays valid. Pages refresh far more often.
const SIGNED_URL_TTL_SECONDS = Number(process.env.PHOTO_URL_TTL_SECONDS || 60 * 60);

/** Split storage:bucket/path into its parts, or null. */
export function parseStorageRef(photoRef) {
  if (typeof photoRef !== 'string' || !photoRef.startsWith(REF_PREFIX)) return null;
  const rest = photoRef.slice(REF_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

/**
 * Turn stored photo_refs into short-lived signed URLs, so photos of what's in
 * a customer's bins work in a private bucket and a leaked link soon expires.
 * Legacy inline data URLs pass through. Returns a Map of photo_ref to URL; a
 * ref that can't be signed is left out (the bin just shows no photo).
 */
export async function signPhotoUrls(photoRefs) {
  const out = new Map();
  const byBucket = new Map();
  for (const ref of new Set(photoRefs.filter(Boolean))) {
    if (ref.startsWith('data:image/')) {
      out.set(ref, ref);
      continue;
    }
    const parsed = parseStorageRef(ref);
    if (!parsed) continue;
    if (!byBucket.has(parsed.bucket)) byBucket.set(parsed.bucket, new Map());
    byBucket.get(parsed.bucket).set(parsed.path, ref);
  }
  if (byBucket.size === 0 || !isStorageConfigured()) return out;

  const base = getSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await Promise.all(
    [...byBucket].map(async ([bucket, paths]) => {
      try {
        const resp = await fetch(`${base}/storage/v1/object/sign/${bucket}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS, paths: [...paths.keys()] }),
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          console.error(`[storage] sign failed (${resp.status}): ${detail}`);
          return;
        }
        for (const item of await resp.json()) {
          const ref = paths.get(item.path);
          if (ref && item.signedURL && !item.error) out.set(ref, `${base}/storage/v1${item.signedURL}`);
        }
      } catch (err) {
        console.error('[storage] sign error:', err);
      }
    })
  );
  return out;
}

export async function enrichBins(bins) {
  const list = bins || [];
  const urls = await signPhotoUrls(list.map((b) => b?.photo_ref));
  return list.map((bin) => {
    const photoUrl = bin && urls.get(bin.photo_ref);
    return photoUrl ? { ...bin, photoUrl } : bin;
  });
}

export async function enrichBin(bin) {
  if (!bin) return bin;
  return (await enrichBins([bin]))[0];
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
