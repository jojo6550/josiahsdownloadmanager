'use strict';

// ============================================================
// State
// ============================================================

/** @type {Map<string, { el: HTMLElement, status: string, filename: string }>} */
const jobs = new Map();

/** @type {Set<string>} */
const activeFilters = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);

/** All rendered log entries (for re-filter). @type {HTMLElement[]} */
const allLogEntries = [];

// ============================================================
// Utility
// ============================================================

/**
 * Format bytes to human-readable string (B / KB / MB / GB).
 * @param {number} n - Bytes
 * @returns {string}
 */
function formatBytes(n) {
  if (n == null || isNaN(n)) return '0 B';
  if (n < 1024) return `${n.toFixed(0)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Format a Date or ISO timestamp as HH:MM:SS.
 * @param {string|Date} ts
 * @returns {string}
 */
function formatTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d)) return '--:--:--';
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ============================================================
// Section count helpers
// ============================================================

function getCount(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return 0;
  return section.querySelectorAll('.dl-card').length;
}

function updateCounts() {
  document.getElementById('count-active').textContent    = getCount('downloads-active');
  document.getElementById('count-queued').textContent    = getCount('downloads-queued');
  document.getElementById('count-completed').textContent = getCount('downloads-completed');
}

// ============================================================
// Download Card
// ============================================================

/**
 * Create a new download card element.
 * @param {string} id
 * @returns {HTMLElement}
 */
function createCardEl(id) {
  const el = document.createElement('div');
  el.className = 'dl-card';
  el.id = `card-${id}`;
  el.innerHTML = `
    <div class="dl-card-top">
      <span class="dl-filename" id="filename-${id}">Connecting…</span>
      <div class="dl-meta">
        <span class="dl-speed" id="speed-${id}">–</span>
        <span class="dl-eta" id="eta-${id}">ETA –</span>
        <span class="dl-size" id="size-${id}"></span>
        <span class="badge downloading" id="badge-${id}">downloading</span>
      </div>
    </div>
    <div class="dl-overall-bar"><div class="dl-overall-fill" id="overall-bar-${id}" style="width:0%"></div></div>
    <div class="dl-threads" id="threads-${id}"></div>
    <div class="dl-controls">
      <span class="dl-pct" id="pct-${id}">0%</span>
      <button class="btn-sm" id="pause-btn-${id}">Pause</button>
      <button class="btn-sm danger" id="cancel-btn-${id}">Cancel</button>
    </div>
  `;

  el.querySelector(`#pause-btn-${id}`).addEventListener('click', () => {
    window.api.pauseDownload(id);
  });

  el.querySelector(`#cancel-btn-${id}`).addEventListener('click', () => {
    window.api.cancelDownload(id);
  });

  return el;
}

/**
 * Update or create a per-thread progress row.
 * @param {string} containerId - threads-{id}
 * @param {number} n - zero-based chunk index
 * @param {number} percent
 * @param {number} speedBps
 */
function updateThreadRow(containerId, n, percent, speedBps) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let row = document.getElementById(`thread-${containerId}-${n}`);
  if (!row) {
    row = document.createElement('div');
    row.className = 'dl-thread';
    row.id = `thread-${containerId}-${n}`;
    row.innerHTML = `
      <span class="dl-thread-id">T${n + 1}</span>
      <div class="dl-thread-bar"><div class="dl-thread-fill" id="tf-${containerId}-${n}"></div></div>
      <span class="dl-thread-speed" id="ts-${containerId}-${n}"></span>
    `;
    container.appendChild(row);
  }

  const fill = document.getElementById(`tf-${containerId}-${n}`);
  if (fill) fill.style.width = `${percent}%`;

  const speedEl = document.getElementById(`ts-${containerId}-${n}`);
  if (speedEl) speedEl.textContent = speedBps > 0 ? `${formatBytes(speedBps)}/s` : '–';
}

// ============================================================
// Topbar stats
// ============================================================

function updateTopbarStats() {
  let totalSpeedBps = 0;
  let activeCount = 0;

  for (const [, job] of jobs) {
    if (job.status === 'downloading') {
      activeCount++;
      totalSpeedBps += job.speedBps || 0;
    }
  }

  const queuedCount = document.getElementById('downloads-queued').querySelectorAll('.dl-card').length;

  document.getElementById('stats-speed').textContent  = `${formatBytes(totalSpeedBps)}/s`;
  document.getElementById('stats-active').textContent = `Active: ${activeCount}`;
  document.getElementById('stats-queued').textContent = `Queued: ${queuedCount}`;
}

// ============================================================
// Event: progress
// ============================================================

/**
 * @param {{ id: string, overall: { percent: number, speedBps: number, etaSec: number, receivedBytes: number, totalBytes: number }, chunks: Array<{ index: number, percent: number, speedBps: number }> }} data
 */
function handleProgress(data) {
  const { id, overall, chunks } = data;
  if (!jobs.has(id)) return;

  const job = jobs.get(id);
  job.speedBps = overall.speedBps || 0;

  const overallFill = document.getElementById(`overall-bar-${id}`);
  if (overallFill) overallFill.style.width = `${overall.percent}%`;

  const pctEl = document.getElementById(`pct-${id}`);
  if (pctEl) pctEl.textContent = `${overall.percent.toFixed(0)}%`;

  const speedEl = document.getElementById(`speed-${id}`);
  if (speedEl) speedEl.textContent = `${formatBytes(overall.speedBps)}/s`;

  const etaEl = document.getElementById(`eta-${id}`);
  if (etaEl) {
    etaEl.textContent = overall.etaSec > 0 ? `ETA ${overall.etaSec}s` : 'ETA –';
  }

  const sizeEl = document.getElementById(`size-${id}`);
  if (sizeEl && overall.totalBytes > 0) {
    sizeEl.textContent = `${formatBytes(overall.receivedBytes)}/${formatBytes(overall.totalBytes)}`;
  }

  const threadsId = `threads-${id}`;
  if (chunks && Array.isArray(chunks)) {
    chunks.forEach((chunk) => {
      updateThreadRow(threadsId, chunk.index, chunk.percent, chunk.speedBps || 0);
    });
  }

  updateTopbarStats();
}

// ============================================================
// Event: statusChange
// ============================================================

/**
 * @param {{ id: string, status: string, filename?: string, dest?: string, error?: string }} data
 */
function handleStatus(data) {
  const { id, status, filename, dest, error } = data;
  if (!jobs.has(id)) return;

  const job = jobs.get(id);
  job.status = status;

  if (filename) {
    job.filename = filename;
    const filenameEl = document.getElementById(`filename-${id}`);
    if (filenameEl) filenameEl.textContent = filename;
  }

  // Update badge
  const badge = document.getElementById(`badge-${id}`);
  if (badge) {
    badge.className = `badge ${status}`;
    badge.textContent = status;
  }

  const card = document.getElementById(`card-${id}`);
  if (!card) return;

  if (status === 'completed') {
    // Move card to completed section
    const completedSection = document.getElementById('downloads-completed');
    completedSection.appendChild(card);

    // Update overall bar to 100%
    const overallFill = document.getElementById(`overall-bar-${id}`);
    if (overallFill) overallFill.style.width = '100%';

    const pctEl = document.getElementById(`pct-${id}`);
    if (pctEl) pctEl.textContent = '100%';

    // Swap controls: remove pause/cancel, add open-file link
    const controls = card.querySelector('.dl-controls');
    if (controls) {
      const pctSpan = document.getElementById(`pct-${id}`);
      controls.innerHTML = '';
      if (pctSpan) controls.appendChild(pctSpan);

      if (dest) {
        const openLink = document.createElement('a');
        openLink.className = 'dl-open-link';
        openLink.href = '#';
        openLink.textContent = 'Open file';
        openLink.addEventListener('click', (e) => {
          e.preventDefault();
          if (window.api.openFile) window.api.openFile(dest);
        });
        controls.appendChild(openLink);
      }
    }

    updateCounts();
    updateTopbarStats();

  } else if (status === 'error') {
    // Move card to completed section with error style
    card.classList.add('error');
    const completedSection = document.getElementById('downloads-completed');
    completedSection.appendChild(card);

    // Swap controls to show error message
    const controls = card.querySelector('.dl-controls');
    if (controls) {
      const pctSpan = document.getElementById(`pct-${id}`);
      controls.innerHTML = '';
      if (pctSpan) {
        pctSpan.textContent = 'Error';
        controls.appendChild(pctSpan);
      }
      if (error) {
        const errMsg = document.createElement('span');
        errMsg.className = 'dl-error-msg';
        errMsg.textContent = error;
        controls.appendChild(errMsg);
      }
    }

    updateCounts();
    updateTopbarStats();

  } else if (status === 'paused') {
    const pauseBtn = document.getElementById(`pause-btn-${id}`);
    if (pauseBtn) {
      pauseBtn.textContent = 'Resume';
      pauseBtn.onclick = () => window.api.resumeDownload(id);
    }
    updateTopbarStats();

  } else if (status === 'downloading') {
    // Resuming from paused — swap button back to Pause
    const pauseBtn = document.getElementById(`pause-btn-${id}`);
    if (pauseBtn) {
      pauseBtn.textContent = 'Pause';
      pauseBtn.onclick = () => window.api.pauseDownload(id);
    }
    updateTopbarStats();

  } else if (status === 'queued') {
    const queuedSection = document.getElementById('downloads-queued');
    queuedSection.appendChild(card);
    updateCounts();
    updateTopbarStats();

  } else if (status === 'cancelled') {
    card.remove();
    jobs.delete(id);
    updateCounts();
    updateTopbarStats();
  }
}

// ============================================================
// Log sidebar
// ============================================================

/**
 * @param {{ level: string, ts: string, msg: string }} entry
 */
function renderLogEntry(entry) {
  const { level, ts, msg } = entry;

  const el = document.createElement('div');
  el.className = 'log-entry';
  el.dataset.level = level;

  if (!activeFilters.has(level)) {
    el.classList.add('hidden');
  }

  const levelSpan = document.createElement('span');
  levelSpan.className = `log-level ${level}`;
  levelSpan.textContent = level;

  const tsSpan = document.createElement('span');
  tsSpan.className = 'log-ts';
  tsSpan.textContent = formatTime(ts);

  const msgSpan = document.createElement('span');
  msgSpan.className = 'log-msg';
  msgSpan.textContent = msg;

  el.appendChild(levelSpan);
  el.appendChild(tsSpan);
  el.appendChild(msgSpan);

  const logEntries = document.getElementById('log-entries');
  logEntries.appendChild(el);
  allLogEntries.push(el);

  // Auto-scroll if user is near the bottom (within 60px)
  const isNearBottom = logEntries.scrollHeight - logEntries.scrollTop - logEntries.clientHeight < 60;
  if (isNearBottom) {
    logEntries.scrollTop = logEntries.scrollHeight;
  }
}

function applyLogFilters() {
  for (const el of allLogEntries) {
    const level = el.dataset.level;
    el.classList.toggle('hidden', !activeFilters.has(level));
  }

  // Re-scroll to bottom after re-filtering
  const logEntries = document.getElementById('log-entries');
  logEntries.scrollTop = logEntries.scrollHeight;
}

function initLogFilters() {
  const pills = document.querySelectorAll('.filter-pill');
  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      const level = pill.dataset.level;
      if (activeFilters.has(level)) {
        activeFilters.delete(level);
        pill.classList.remove('active');
      } else {
        activeFilters.add(level);
        pill.classList.add('active');
      }
      applyLogFilters();
    });
  });
}

// ============================================================
// Download button
// ============================================================

function initDownloadButton() {
  const downloadBtn = document.getElementById('downloadBtn');
  const urlInput = document.getElementById('urlInput');

  downloadBtn.addEventListener('click', startDownload);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startDownload();
  });

  async function startDownload() {
    const url = urlInput.value.trim();

    if (!url) {
      urlInput.classList.add('shake');
      urlInput.addEventListener('animationend', () => {
        urlInput.classList.remove('shake');
      }, { once: true });
      return;
    }

    const result = await window.api.startDownload(url);
    if (!result) return;

    const { id } = result;

    urlInput.value = '';

    const el = createCardEl(id);
    const activeSection = document.getElementById('downloads-active');
    activeSection.appendChild(el);

    jobs.set(id, { el, status: 'downloading', filename: '', speedBps: 0 });

    updateCounts();
    updateTopbarStats();
  }
}

// ============================================================
// Init
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  initLogFilters();
  initDownloadButton();

  // Load recent log entries
  window.api.getLogEntries(200).then((entries) => {
    if (Array.isArray(entries)) {
      entries.forEach(renderLogEntry);
    }
  }).catch(() => {
    // Log fetch failed — silently ignore (not critical)
  });

  // Subscribe to live events
  window.api.onProgress(handleProgress);
  window.api.onStatusChange(handleStatus);
  window.api.onLogEntry(renderLogEntry);
});
