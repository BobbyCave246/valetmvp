// Shared customer-site header with desktop links + mobile drawer.
(function () {
  const LINKS = [
    { href: '/booking/#how', label: 'How it works', mobile: true },
    { href: '/booking/#pricing', label: 'Pricing', mobile: true },
    { href: '/booking/booking.html', label: 'My booking', mobile: true },
    { href: '/login/', label: 'Staff sign in ↗', cls: 'staff', mobile: true },
  ];

  function renderHeader(opts = {}) {
    const active = opts.active || ''; // 'book' | 'track' | 'home'
    const desktopLinks = LINKS.map(
      (l) => `<a href="${l.href}" class="${l.cls || ''}">${l.label}</a>`
    ).join('');
    const mobileLinks = LINKS.filter((l) => l.mobile).map(
      (l) => `<a href="${l.href}" class="${l.cls || ''}">${l.label}</a>`
    ).join('');

    const bookCta =
      active === 'book'
        ? ''
        : `<a class="btn btn-primary btn-sm" href="/booking/book.html">Book bins</a>`;

    return `
      <header class="site-header">
        <div class="site-nav">
          <a class="brand" href="/booking/">📦 Store All Valet</a>
          <span class="spacer"></span>
          <nav class="nav-links nav-desktop">${desktopLinks}</nav>
          ${bookCta}
          <button type="button" class="nav-toggle" id="navToggle" aria-label="Open menu" aria-expanded="false">☰</button>
        </div>
      </header>
      <div class="mobile-drawer" id="mobileDrawer" hidden>
        <div class="backdrop" id="drawerBackdrop"></div>
        <div class="panel" role="dialog" aria-label="Menu">
          <button type="button" class="close-btn" id="drawerClose" aria-label="Close menu">×</button>
          ${mobileLinks}
          <a class="btn btn-primary" href="/booking/book.html">Book bins</a>
        </div>
      </div>`;
  }

  function bindNav() {
    const toggle = document.getElementById('navToggle');
    const drawer = document.getElementById('mobileDrawer');
    if (!toggle || !drawer) return;

    const open = () => {
      drawer.hidden = false;
      drawer.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      drawer.classList.remove('open');
      drawer.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    };

    toggle.addEventListener('click', () => (drawer.classList.contains('open') ? close() : open()));
    document.getElementById('drawerClose')?.addEventListener('click', close);
    document.getElementById('drawerBackdrop')?.addEventListener('click', close);
    drawer.querySelectorAll('a').forEach((a) => a.addEventListener('click', close));
  }

  window.CustomerNav = { renderHeader, bindNav };
})();
