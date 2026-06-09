// HTML-entity escaping for dynamic values interpolated into innerHTML.
// Always wrap user-supplied or API-supplied strings: esc(value).
(function () {
  const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  window.esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
})();
