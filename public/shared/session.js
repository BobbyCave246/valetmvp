// Shared client-side session guard for the STAFF surfaces (admin/driver/
// warehouse). The real security is server-side (every /api route is role-gated);
// this only handles UX: bounce the wrong/absent role to the right place and
// render a "signed in as … · Log out" control.
//
// Usage: Session.guard('driver').then((user) => { /* boot the app */ });
(function () {
  const HOME = { admin: '/admin/', driver: '/driver/', warehouse: '/warehouse/' };

  async function guard(requiredRole) {
    let user = null;
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (r.ok) user = (await r.json()).user;
    } catch {
      /* network error → treat as signed out */
    }
    if (!user) {
      location.replace('/login/');
      return new Promise(() => {}); // never resolves — page is navigating away
    }
    if (requiredRole && user.role !== requiredRole) {
      // Signed in, but this isn't their surface — send them to their own.
      location.replace(HOME[user.role] || '/login/');
      return new Promise(() => {});
    }
    renderHeader(user);
    return user;
  }

  function renderHeader(user) {
    const header = document.querySelector('header');
    if (!header) return;
    // Remove any leftover cross-surface "switch role" links.
    header.querySelectorAll('a[href="/start/"], a[href="/start"]').forEach((a) => a.remove());
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted,#94a3b8);';
    const who = document.createElement('span');
    who.textContent = user.email;
    const out = document.createElement('button');
    out.textContent = 'Log out';
    const onDark = getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)';
    out.style.cssText = onDark
      ? 'border:1px solid #334155;background:#1e293b;color:#e2e8f0;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;'
      : 'border:1px solid #e2e8f0;background:#fff;color:#0f172a;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;';
    out.addEventListener('click', async () => {
      try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
      location.replace('/login/');
    });
    wrap.append(who, out);
    header.appendChild(wrap);
  }

  // Wrap a staff app's fetch so an expired/again-absent session bounces to login.
  function onUnauthorized() {
    location.replace('/login/');
  }

  window.Session = { guard, onUnauthorized };
})();
