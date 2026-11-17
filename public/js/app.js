// Progressive enhancements. Every page works without this file; it only makes
// things smoother (dialogs instead of confirmation pages, live filtering …).
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // --- Colour scheme: auto → dark → light → auto ---------------------------
  function initTheme() {
    const root = document.documentElement;
    const order = ['auto', 'dark', 'light'];
    for (const button of $$('[data-theme-toggle]')) {
      button.addEventListener('click', () => {
        const next = order[(order.indexOf(root.dataset.theme) + 1) % order.length];
        root.dataset.theme = next;
        document.cookie = `theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
      });
    }
  }

  // --- Toast ------------------------------------------------------------------
  function initToast() {
    const toast = $('[data-toast]');
    if (!toast) return;
    const dismiss = () => {
      toast.classList.add('toast--leaving');
      setTimeout(() => toast.remove(), 220);
    };
    $('[data-toast-close]', toast)?.addEventListener('click', dismiss);
    if (!toast.classList.contains('toast--error')) setTimeout(dismiss, 6000);
  }

  // --- Confirmation dialog for destructive forms --------------------------------
  function confirmDialog(text) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'dialog';
      const message = document.createElement('p');
      message.className = 'dialog__text';
      message.textContent = text;
      const actions = document.createElement('div');
      actions.className = 'form-actions';
      const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Abbrechen' });
      const ok = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn--danger-solid', textContent: 'Ja, fortfahren' });
      actions.append(cancel, ok);
      dialog.append(message, actions);
      document.body.append(dialog);
      const close = (result) => {
        dialog.close();
        dialog.remove();
        resolve(result);
      };
      cancel.addEventListener('click', () => close(false));
      ok.addEventListener('click', () => close(true));
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        close(false);
      });
      dialog.showModal();
      cancel.focus();
    });
  }

  function initConfirm() {
    document.addEventListener('submit', async (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.dataset.confirm || form.dataset.confirmed) return;
      event.preventDefault();
      if (!(await confirmDialog(form.dataset.confirm))) return;
      form.dataset.confirmed = '1';
      const flag = Object.assign(document.createElement('input'), { type: 'hidden', name: '_confirmed', value: '1' });
      form.append(flag);
      form.submit();
    });
  }

  // --- Live filtering: reload only the result list --------------------------------
  function initFilters() {
    const form = $('form[data-autosubmit]');
    const results = $('#results');
    if (!form || !results) return;
    let controller = null;
    let timer = null;

    const load = async () => {
      const params = new URLSearchParams(new FormData(form));
      for (const [key, value] of [...params]) if (!value) params.delete(key);
      const url = `${form.action}${params.size ? `?${params}` : ''}`;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html' } });
        if (!response.ok || response.redirected) throw new Error('reload');
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const fresh = page.querySelector('#results');
        if (!fresh) throw new Error('reload');
        results.replaceChildren(...fresh.childNodes);
        const subtitle = page.querySelector('.page-header__subtitle');
        if (subtitle && $('.page-header__subtitle')) $('.page-header__subtitle').textContent = subtitle.textContent;
        history.replaceState(null, '', url);
        initBulk();
      } catch (error) {
        if (error.name !== 'AbortError') form.submit();
      }
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      load();
    });
    form.addEventListener('change', (event) => {
      if (event.target.matches('select')) load();
    });
    form.addEventListener('input', (event) => {
      if (!event.target.matches('input[type="search"]')) return;
      clearTimeout(timer);
      timer = setTimeout(load, 250);
    });
  }

  // --- Bulk selection in the inventory table -----------------------------------------
  function initBulk() {
    const form = $('form[data-bulk]');
    const bar = $('[data-bulk-bar]');
    if (!form || !bar) return;
    const boxes = () => $$('input[name="ids"]', form);
    const all = $('[data-check-all]', form);
    const update = () => {
      const selected = boxes().filter((box) => box.checked).length;
      bar.hidden = selected === 0;
      $('[data-bulk-count]', bar).textContent = `${selected} ausgewählt`;
      if (all) {
        all.checked = selected > 0 && selected === boxes().length;
        all.indeterminate = selected > 0 && selected < boxes().length;
      }
    };
    all?.addEventListener('change', () => {
      for (const box of boxes()) box.checked = all.checked;
      update();
    });
    form.addEventListener('change', (event) => {
      if (event.target.name === 'ids') update();
    });
    update();
  }

  // --- "＋ Neu anlegen …" in selects reveals the text field next to it ---------------------
  function initCreateToggles() {
    for (const select of $$('select[data-create-toggle]')) {
      const input = document.getElementById(select.dataset.createToggle);
      if (!input) continue;
      const sync = (focus) => {
        const creating = select.value === '__new';
        input.hidden = !creating;
        input.required = creating;
        if (creating && focus) input.focus();
      };
      select.addEventListener('change', () => sync(true));
      sync(false);
    }
  }

  // --- Inspection form: suggest the next due date -------------------------------------------
  function addMonths(isoDate, months) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const index = month - 1 + months;
    const y = year + Math.floor(index / 12);
    const m = ((index % 12) + 12) % 12;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
  }

  function initInspectionForm() {
    const form = $('form[data-inspection-form]');
    if (!form) return;
    const intervals = JSON.parse(form.dataset.intervals || '{}');
    const { type_id: type, performed_on: performed, next_due: due } = form.elements;
    let touched = Boolean(due.value);
    due.addEventListener('input', () => {
      touched = Boolean(due.value);
    });
    const suggest = () => {
      if (touched) return;
      const months = intervals[type.value];
      due.value = months && /^\d{4}-\d{2}-\d{2}$/.test(performed.value) ? addMonths(performed.value, months) : '';
    };
    type.addEventListener('change', suggest);
    performed.addEventListener('change', suggest);
    suggest();
  }

  // --- Shrink large photos in the browser before uploading -----------------------------------
  const MAX_EDGE = 2000;
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 600 * 1024) return file;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
    } catch {
      return file; // Upload the original if the browser cannot process it.
    }
  }

  function initImageShrink() {
    if (typeof DataTransfer === 'undefined' || typeof createImageBitmap === 'undefined') return;
    for (const input of $$('input[type="file"][data-resize]')) {
      input.addEventListener('change', async () => {
        if (!input.files?.length) return;
        const submit = input.form?.querySelector('button[type="submit"]');
        if (submit) submit.disabled = true;
        const transfer = new DataTransfer();
        for (const file of input.files) transfer.items.add(await shrink(file));
        input.files = transfer.files;
        if (submit) submit.disabled = false;
      });
    }
  }

  // --- Copy to clipboard ------------------------------------------------------------------------
  function initCopy() {
    for (const button of $$('[data-copy]')) {
      button.addEventListener('click', async () => {
        const source = $(button.dataset.copy);
        if (!source) return;
        const text = source.matches('ul') ? $$('li', source).map((item) => item.textContent.trim()).join('\n') : source.textContent.trim();
        try {
          await navigator.clipboard.writeText(text);
          const label = button.lastChild;
          const original = label.textContent;
          label.textContent = 'Kopiert';
          setTimeout(() => (label.textContent = original), 1800);
        } catch {
          window.prompt('Zum Kopieren markieren:', text);
        }
      });
    }
  }

  // --- Close open dropdown menus when clicking elsewhere ---------------------------------------------
  function initDropdowns() {
    document.addEventListener('click', (event) => {
      for (const dropdown of $$('details.dropdown[open]')) {
        if (!dropdown.contains(event.target)) dropdown.open = false;
      }
    });
  }

  // --- Label page: show only the fields of the chosen format, refresh the preview ----------------------
  function initLabels() {
    const form = $('form[data-label-form]');
    if (!form) return;
    const format = $('[data-label-format]', form);
    const preview = $('[data-label-preview]');
    let timer = null;
    const sync = () => {
      const value = format.value;
      for (const block of $$('[data-label-custom]', form)) block.hidden = !block.dataset.labelCustom.split(' ').includes(value);
      const sheet = value.startsWith('a4-') || value === 'custom-sheet';
      for (const block of $$('[data-label-sheet-only]', form)) block.hidden = !sheet;
      if (!preview || !preview.offsetParent) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const params = new URLSearchParams(new FormData(form));
        params.set('vorschau', '1');
        preview.src = `${form.action}?${params}#toolbar=0&navpanes=0&view=FitH`;
      }, 350);
    };
    form.addEventListener('input', sync);
    form.addEventListener('change', sync);
    sync();
  }

  // --- Setup: upload a complete backup with progress display --------------------------------------------
  function initRestore() {
    const form = $('form[data-restore-form]');
    if (!form) return;
    const status = $('[data-restore-status]', form);
    const progress = $('[data-restore-progress]', form);
    const button = $('button[type="submit"]', form);
    const say = (text, error = false) => {
      status.textContent = text;
      status.classList.toggle('text-danger', error);
    };

    const upload = (file, token) =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', form.action);
        xhr.setRequestHeader('Content-Type', 'application/gzip');
        xhr.setRequestHeader('X-Setup-Token', token);
        xhr.upload.addEventListener('progress', (event) => {
          if (!event.lengthComputable) return;
          if (event.loaded < event.total) {
            progress.value = Math.round((event.loaded / event.total) * 100);
            say(`Wird hochgeladen … ${progress.value} %`);
          } else {
            progress.removeAttribute('value'); // indeterminate while the server works
            say('Sicherung wird geprüft und eingespielt …');
          }
        });
        xhr.addEventListener('load', () => {
          let body = {};
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            // Non-JSON answer (e.g. from a proxy): handled below.
          }
          if (xhr.status === 200 && body.ok) resolve(body);
          else if (xhr.status === 413 && !body.error) reject(new Error('Die Datei ist für den Webserver zu groß. Bitte dessen Upload-Grenze erhöhen (siehe README).'));
          else reject(new Error(body.error || `Das Einspielen ist fehlgeschlagen (Fehler ${xhr.status}).`));
        });
        xhr.addEventListener('error', () => reject(new Error('Die Verbindung wurde unterbrochen. Bitte erneut versuchen.')));
        xhr.send(file);
      });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const file = form.elements.file.files[0];
      const token = form.elements.token.value.trim();
      const limit = Number(form.dataset.maxBytes);
      if (!file) return say('Bitte die Sicherungsdatei auswählen.', true);
      if (limit && file.size > limit) return say(`Die Datei ist größer als die eingestellte Grenze von ${form.dataset.maxLabel}.`, true);
      button.disabled = true;
      say('Einrichtungscode wird geprüft …');
      try {
        const check = await fetch(`${form.action}/pruefen`, { method: 'POST', headers: { 'X-Setup-Token': token } });
        const answer = await check.json().catch(() => ({}));
        if (!check.ok) throw new Error(answer.error || 'Die Prüfung ist fehlgeschlagen.');
        progress.hidden = false;
        progress.value = 0;
        const result = await upload(file, token);
        const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
        progress.value = 100;
        say(`Fertig: ${count(result.summary.assets, 'Gerät', 'Geräte')} und ${count(result.summary.users, 'Konto', 'Konten')} übernommen. Weiter zur Anmeldung …`);
        setTimeout(() => location.assign(result.redirect), 1200);
      } catch (error) {
        progress.hidden = true;
        button.disabled = false;
        say(error.message, true);
      }
    });
  }

  // --- "/" focuses the search field -------------------------------------------------------------------------
  function initShortcuts() {
    document.addEventListener('keydown', (event) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target.closest('input, textarea, select, [contenteditable]')) return;
      const search = $('.search input');
      if (search) {
        event.preventDefault();
        search.focus();
      }
    });
  }

  function init() {
    initTheme();
    initToast();
    initConfirm();
    initFilters();
    initBulk();
    initCreateToggles();
    initInspectionForm();
    initImageShrink();
    initCopy();
    initDropdowns();
    initLabels();
    initRestore();
    initShortcuts();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
