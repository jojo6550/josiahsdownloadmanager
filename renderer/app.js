'use strict';

// ─── State ─────────────────────────────────────────────────────────────────

const jobs = new Map(); // id → { status, speedBps, dest }

// ─── Util ──────────────────────────────────────────────────────────────────

function fmt(n) {
  if (!n || isNaN(n)) return '0 B';
  if (n < 1024)       return `${n.toFixed(0)} B`;
  if (n < 1048576)    return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function showEmpty(show) {
  const list = document.getElementById('dl-list');
  let msg = document.getElementById('empty-msg');
  if (show) {
    if (!msg) {
      msg = document.createElement('div');
      msg.id = 'empty-msg';
      msg.textContent = 'No downloads yet.\nPaste a URL above or use jdm <url> in terminal.';
      list.appendChild(msg);
    }
  } else if (msg) {
    msg.remove();
  }
}

function updateEmpty() {
  showEmpty(jobs.size === 0);
}

// ─── Stats bar ─────────────────────────────────────────────────────────────

function updateStats() {
  let speed = 0, active = 0;
  for (const [, j] of jobs) {
    if (j.status === 'downloading') { active++; speed += j.speedBps || 0; }
  }
  document.getElementById('stat-speed').textContent  = `${fmt(speed)}/s`;
  document.getElementById('stat-active').textContent = active > 0 ? `${active} active` : jobs.size > 0 ? `${jobs.size} jobs` : '';
}

// ─── Card creation ─────────────────────────────────────────────────────────

function makeCard(id, name) {
  const el = document.createElement('div');
  el.className = 'dl-card';
  el.id = `card-${id}`;
  el.innerHTML = `
    <div class="dl-top">
      <span class="dl-name" id="name-${id}">${name || 'Connecting…'}</span>
      <span class="dl-pct"  id="pct-${id}">0%</span>
    </div>
    <div class="dl-bar-wrap"><div class="dl-bar-fill" id="bar-${id}" style="width:0%"></div></div>
    <div class="dl-meta">
      <span class="dl-speed" id="spd-${id}">–</span>
      <span class="dl-eta"   id="eta-${id}">ETA –</span>
      <span class="dl-size"  id="sz-${id}"></span>
      <div class="dl-actions" id="act-${id}">
        <button class="btn-xs" id="pause-${id}">Pause</button>
        <button class="btn-xs danger" id="cancel-${id}">✕</button>
      </div>
    </div>`;

  el.querySelector(`#pause-${id}`).onclick  = () => window.api.pauseDownload(id);
  el.querySelector(`#cancel-${id}`).onclick = () => window.api.cancelDownload(id);

  return el;
}

// ─── Progress ──────────────────────────────────────────────────────────────

function handleProgress({ id, overall }) {
  const job = jobs.get(id);
  if (!job) return;
  job.speedBps = overall.speedBps || 0;

  const pct  = Math.min(100, Math.max(0, overall.percent || 0));
  const recv = overall.receivedBytes || 0;
  const tot  = overall.totalBytes    || 0;
  const eta  = overall.speedBps > 0 && tot > 0 ? Math.round((tot - recv) / overall.speedBps) : null;

  const set = (sel, val) => { const el = document.getElementById(sel); if (el) el.textContent = val; };
  const bar = document.getElementById(`bar-${id}`);

  if (bar) bar.style.width = `${pct}%`;
  set(`pct-${id}`,  `${pct.toFixed(0)}%`);
  set(`spd-${id}`,  `${fmt(overall.speedBps)}/s`);
  set(`eta-${id}`,  eta !== null ? `ETA ${eta}s` : 'ETA –');
  if (tot > 0) set(`sz-${id}`, `${fmt(recv)}/${fmt(tot)}`);

  updateStats();
}

// ─── Status ────────────────────────────────────────────────────────────────

function handleStatus({ id, status, filename, dest, error }) {
  let job = jobs.get(id);

  if (!job) {
    // Job started externally (CLI) — create card on first status event
    const name = filename || (dest ? dest.split(/[/\\]/).pop() : id.slice(0, 8));
    const card = makeCard(id, name);
    document.getElementById('downloads-active').prepend(card);
    job = { status, speedBps: 0, dest };
    jobs.set(id, job);
    updateEmpty();
  }

  job.status = status;
  if (dest) job.dest = dest;

  if (filename) {
    const el = document.getElementById(`name-${id}`);
    if (el) el.textContent = filename;
  }

  const card = document.getElementById(`card-${id}`);
  if (!card) return;

  if (status === 'completed') {
    card.classList.add('done');
    const bar = document.getElementById(`bar-${id}`);
    if (bar) { bar.style.width = '100%'; bar.classList.add('complete'); }
    const pct = document.getElementById(`pct-${id}`);
    if (pct) pct.textContent = '100%';
    const spd = document.getElementById(`spd-${id}`);
    if (spd) spd.textContent = '✓ done';
    const eta = document.getElementById(`eta-${id}`);
    if (eta) eta.textContent = '';

    const acts = document.getElementById(`act-${id}`);
    if (acts) {
      acts.innerHTML = '';
      if (job.dest) {
        const btn = document.createElement('button');
        btn.className = 'btn-xs open';
        btn.textContent = 'Open';
        btn.onclick = () => window.api.openFile(job.dest);
        acts.appendChild(btn);
      }
    }

    document.getElementById('downloads-done').prepend(card);

  } else if (status === 'error') {
    card.classList.add('error');
    const acts = document.getElementById(`act-${id}`);
    if (acts) {
      const errEl = document.createElement('span');
      errEl.className = 'dl-error-txt';
      errEl.textContent = error || 'Error';
      acts.innerHTML = '';
      acts.appendChild(errEl);
    }
    document.getElementById('downloads-done').prepend(card);

  } else if (status === 'paused') {
    const btn = document.getElementById(`pause-${id}`);
    if (btn) { btn.textContent = 'Resume'; btn.onclick = () => window.api.resumeDownload(id); }

  } else if (status === 'downloading') {
    const btn = document.getElementById(`pause-${id}`);
    if (btn) { btn.textContent = 'Pause'; btn.onclick = () => window.api.pauseDownload(id); }
    const active = document.getElementById('downloads-active');
    if (card.parentElement !== active) active.prepend(card);

  } else if (status === 'cancelled') {
    card.remove();
    jobs.delete(id);
    updateEmpty();
  }

  updateStats();
}

// ─── Quality picker modal ──────────────────────────────────────────────────

let _pickerState = null; // { url, formats }

function fmt2(bytes) {
  if (!bytes) return '';
  if (bytes < 1e6)  return `${(bytes / 1e3).toFixed(0)} KB`;
  if (bytes < 1e9)  return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function buildFormatLabel(f) {
  const size = f.filesize ? ` · ${fmt2(f.filesize)}` : '';
  const note = f.note     ? ` · ${f.note}`            : '';
  return `${f.resolution} · ${f.ext.toUpperCase()}${note}${size}`;
}

function showPicker(url, formats) {
  // Keep only video formats; deduplicate by resolution+ext
  const seen = new Set();
  const videoFmts = formats.filter((f) => {
    if (f.vcodec === 'none') return false;
    const key = `${f.resolution}|${f.ext}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (videoFmts.length === 0) return null;

  _pickerState = { url, formats: videoFmts };

  const container = document.getElementById('modal-formats');
  container.innerHTML = '';

  // "Best" auto option first
  const autoId = 'bestvideo+bestaudio/best';
  const autoRow = document.createElement('label');
  autoRow.className = 'fmt-row';
  autoRow.innerHTML = `<input type="radio" name="fmt" value="${autoId}" checked /> Best (auto)`;
  container.appendChild(autoRow);

  videoFmts.forEach((f) => {
    const formatStr = `${f.id}+bestaudio/best`;
    const row = document.createElement('label');
    row.className = 'fmt-row';
    row.innerHTML = `<input type="radio" name="fmt" value="${formatStr}" /> ${buildFormatLabel(f)}`;
    container.appendChild(row);
  });

  document.getElementById('quality-modal').hidden = false;
  return true;
}

function hidePicker() {
  document.getElementById('quality-modal').hidden = true;
  _pickerState = null;
}

function initPicker() {
  document.getElementById('modal-close').onclick = hidePicker;

  document.getElementById('modal-download').onclick = async () => {
    if (!_pickerState) return;
    const selected = document.querySelector('input[name="fmt"]:checked');
    if (!selected) return;

    const { url } = _pickerState;
    const formatId = selected.value;
    hidePicker();

    try {
      const { id } = await window.api.startYtDlp(url, formatId);
      const name   = (() => { try { return new URL(url).hostname; } catch { return url; } })();
      const card   = makeCard(id, name);
      document.getElementById('downloads-active').prepend(card);
      jobs.set(id, { status: 'downloading', speedBps: 0, dest: null });
      updateEmpty();
      updateStats();
    } catch (err) {
      console.error('yt-dlp start failed:', err);
    }
  };
}

// ─── Download button ───────────────────────────────────────────────────────

function initInput() {
  const btn   = document.getElementById('downloadBtn');
  const input = document.getElementById('urlInput');

  async function start() {
    const url = input.value.trim();
    if (!url) {
      input.classList.add('shake');
      input.addEventListener('animationend', () => input.classList.remove('shake'), { once: true });
      return;
    }
    btn.disabled = true;
    try {
      // Try yt-dlp probe first; fall back to direct download
      let formats = null;
      try { formats = await window.api.probeUrl(url); } catch { /* not a yt-dlp URL */ }

      if (formats && formats.length > 0 && showPicker(url, formats)) {
        input.value = '';
        return; // picker handles the rest
      }

      const { id } = await window.api.startDownload(url);
      input.value  = '';
      const name   = (() => { try { return new URL(url).pathname.split('/').pop() || new URL(url).hostname; } catch { return url; } })();
      const card   = makeCard(id, name);
      document.getElementById('downloads-active').prepend(card);
      jobs.set(id, { status: 'downloading', speedBps: 0, dest: null });
      updateEmpty();
      updateStats();
    } catch (err) {
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', start);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
}

// ─── Window controls ───────────────────────────────────────────────────────

function initWindowControls() {
  document.getElementById('btn-minimize').onclick = () => window.api.minimizeWindow();
  document.getElementById('btn-close').onclick    = () => window.api.closeWindow();
}

// ─── Init ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initInput();
  initPicker();
  initWindowControls();
  updateEmpty();

  window.api.onProgress(handleProgress);
  window.api.onStatusChange(handleStatus);
});
