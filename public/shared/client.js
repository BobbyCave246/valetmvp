// Shared fetch wrapper, DOM helpers, and toast for staff surfaces.
// Depends on Session (session.js) for 401 handling.

function guard401(r) {
  if (r.status === 401 || r.status === 403) Session.onUnauthorized();
}

const api = {
  async get(path) {
    const r = await fetch(`/api${path}`, { credentials: 'same-origin' });
    if (!r.ok) {
      guard401(r);
      throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    }
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      guard401(r);
      throw new Error(data.error || r.statusText);
    }
    return data;
  },
};

const $ = (sel) => document.querySelector(sel);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
};

function toast(msg, isErr = false) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  setTimeout(() => (t.className = ''), 2600);
}
