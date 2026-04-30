const downloads = {};

document.getElementById('downloadBtn').addEventListener('click', async () => {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) return;

  const result = await window.api.startDownload(url);
  if (!result) return;

  const { id, filename } = result;
  downloads[id] = { filename, url };
  addDownloadRow(id, filename);

  document.getElementById('urlInput').value = '';
});

window.api.onProgress(({ id, percent, filename }) => {
  const bar = document.getElementById(`bar-${id}`);
  const label = document.getElementById(`label-${id}`);
  if (bar) bar.style.width = `${percent}%`;
  if (label) label.textContent = `${percent}%`;
});

window.api.onStatusChange(({ id, status, filename }) => {
  const statusEl = document.getElementById(`status-${id}`);
  if (statusEl) statusEl.textContent = status;

  if (status === 'completed') {
    const bar = document.getElementById(`bar-${id}`);
    if (bar) {
      bar.style.width = '100%';
      bar.classList.replace('bg-primary', 'bg-success');
    }
    const label = document.getElementById(`label-${id}`);
    if (label) label.textContent = '100%';

    const pauseBtn = document.getElementById(`pause-${id}`);
    if (pauseBtn) pauseBtn.remove();
  }
});

function addDownloadRow(id, filename) {
  const list = document.getElementById('downloadList');

  const card = document.createElement('div');
  card.className = 'card mb-3';
  card.id = `card-${id}`;
  card.innerHTML = `
    <div class="card-body">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="fw-semibold text-truncate me-3">${filename}</span>
        <span id="status-${id}" class="badge bg-secondary">starting</span>
      </div>
      <div class="progress mb-2" style="height: 18px;">
        <div
          id="bar-${id}"
          class="progress-bar bg-primary progress-bar-striped progress-bar-animated"
          style="width: 0%;"
        ></div>
      </div>
      <div class="d-flex justify-content-between align-items-center">
        <small id="label-${id}" class="text-muted">0%</small>
        <button id="pause-${id}" class="btn btn-sm btn-outline-warning">Pause</button>
      </div>
    </div>
  `;

  list.prepend(card);

  document.getElementById(`pause-${id}`).addEventListener('click', () => {
    window.api.pauseDownload(id);
  });
}
