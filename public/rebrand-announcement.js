// Acknowledge the rename once per browser/desktop profile, after the full countdown.
const STORAGE_KEY = 'th-rebrand-server-forge-v1';
const HOLD_MS = 10_000;
let acknowledged = false;
let pending = null;

function eligible(version, development) {
  if (development) return true;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/.exec(version || '');
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 9);
}

function waitForOtherDialogs(dialog) {
  if (![...document.querySelectorAll('dialog[open]')].some(d => d !== dialog)) return Promise.resolve();
  return new Promise(resolve => {
    const observer = new MutationObserver(() => {
      if (![...document.querySelectorAll('dialog[open]')].some(d => d !== dialog)) { observer.disconnect(); resolve(); }
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'], childList: true });
  });
}

export function showRebrandAnnouncement({ version, development = false, loadNotes, renderNotes } = {}) {
  if (!eligible(version, development) || acknowledged) return Promise.resolve(false);
  try { if (localStorage.getItem(STORAGE_KEY) === 'acknowledged') { acknowledged = true; return Promise.resolve(false); } } catch {}
  if (pending) return pending;
  pending = (async () => {
    const dialog = document.getElementById('rebrandDialog');
    const button = document.getElementById('rebrandContinue');
    const timerText = document.getElementById('rebrandCountdown');
    await waitForOtherDialogs(dialog);
    const notesVersion = development ? '0.9.0' : String(version).split('-')[0];
    document.getElementById('rebrandReleaseVersion').textContent = notesVersion;
    const notesBody = document.getElementById('rebrandReleaseBody');
    notesBody.textContent = 'Loading release notes…';
    // The same bundled changelog and renderer as the normal update notice.
    Promise.resolve().then(() => loadNotes?.(notesVersion)).then(result => {
      if (result?.notes && renderNotes) renderNotes(notesBody, result.notes);
      else notesBody.textContent = 'Release notes are unavailable here. Use All releases below to read them.';
    }).catch(() => { notesBody.textContent = 'Release notes could not be loaded. Use All releases below to read them.'; });
    return new Promise(resolve => {
      let unlocked = false;
      // Monotonic time: clock changes and repeated clicks cannot shorten the hold.
      const deadline = performance.now() + HOLD_MS;
      button.disabled = true;
      button.textContent = 'Continue in 10 seconds';
      timerText.textContent = 'Please take a moment to read about the new name.';
      const update = () => {
        const seconds = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
        unlocked = seconds === 0;
        button.disabled = !unlocked;
        button.textContent = unlocked ? 'Got it — same app, new name' : `Continue in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
        if (unlocked) { timerText.textContent = 'You can now continue. This announcement will not appear again on this device.'; clearInterval(interval); }
      };
      const interval = setInterval(update, 100);
      const acknowledge = () => {
        if (!unlocked) return;
        acknowledged = true;
        try {
          localStorage.setItem(STORAGE_KEY, 'acknowledged');
          // This ONE notice also acknowledges the current release notes.
          localStorage.setItem('th-seen-update', version);
        } catch {}
      };
      const cancel = event => { update(); if (!unlocked) event.preventDefault(); else acknowledge(); };
      const click = () => { update(); if (unlocked) { acknowledge(); dialog.close(); } };
      const close = () => {
        clearInterval(interval);
        dialog.removeEventListener('cancel', cancel);
        button.removeEventListener('click', click);
        acknowledge();
        pending = null;
        resolve(unlocked);
      };
      dialog.addEventListener('cancel', cancel);
      dialog.addEventListener('close', close, { once: true });
      button.addEventListener('click', click);
      dialog.showModal();
      document.getElementById('rebrandTitle').focus();
    });
  })();
  return pending;
}
