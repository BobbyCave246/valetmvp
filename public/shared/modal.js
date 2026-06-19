// In-app confirm and pick dialogs — replaces native confirm/prompt on admin.

function bindModalDismiss(overlay, close) {
  const onKey = (e) => {
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', onKey);
      close();
    }
  };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      document.removeEventListener('keydown', onKey);
      close();
    }
  });
  return onKey;
}

function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const overlay = el(`
      <div class="modal-overlay" role="dialog" aria-modal="true">
        <div class="modal-card">
          <h3 class="modal-title">${esc(title)}</h3>
          <p class="modal-message">${esc(message)}</p>
          <div class="modal-actions">
            <button type="button" class="btn ghost modal-cancel">Cancel</button>
            <button type="button" class="btn ${danger ? 'danger' : ''} modal-confirm">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>
    `);
    let onKey;
    const close = (val) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    };
    onKey = bindModalDismiss(overlay, () => close(false));
    overlay.querySelector('.modal-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.modal-confirm').addEventListener('click', () => close(true));
    document.body.appendChild(overlay);
    overlay.querySelector('.modal-confirm').focus();
  });
}

function pickDialog({ title, message, options }) {
  return new Promise((resolve) => {
    const overlay = el(`
      <div class="modal-overlay" role="dialog" aria-modal="true">
        <div class="modal-card">
          <h3 class="modal-title">${esc(title)}</h3>
          ${message ? `<p class="modal-message">${esc(message)}</p>` : ''}
          <div class="modal-pick-list"></div>
          <div class="modal-actions">
            <button type="button" class="btn ghost modal-cancel">Cancel</button>
          </div>
        </div>
      </div>
    `);
    const list = overlay.querySelector('.modal-pick-list');
    if (!options.length) {
      list.innerHTML = '<p class="muted">No options available.</p>';
    } else {
      options.forEach((opt) => {
        const btn = el(`<button type="button" class="btn ghost modal-pick-item">${esc(opt.label)}</button>`);
        btn.addEventListener('click', () => {
          document.removeEventListener('keydown', onKey);
          overlay.remove();
          resolve(opt.value);
        });
        list.appendChild(btn);
      });
    }
    let onKey;
    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(null);
    };
    onKey = bindModalDismiss(overlay, close);
    overlay.querySelector('.modal-cancel').addEventListener('click', close);
    document.body.appendChild(overlay);
  });
}
