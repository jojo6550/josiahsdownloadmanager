const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

class Downloader extends EventEmitter {
  constructor() {
    super();
    this.downloads = new Map();
  }

  startDownload(url, id) {
    const parsed = new URL(url);
    const protocol = parsed.protocol === 'https:' ? https : http;
    const filename = path.basename(parsed.pathname) || `download_${id}`;
    const dest = path.join(DOWNLOADS_DIR, filename);

    const fileStream = fs.createWriteStream(dest);
    let received = 0;
    let total = 0;
    let req = null;

    const request = () => {
      req = protocol.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this.startDownload(res.headers.location, id);
        }

        total = parseInt(res.headers['content-length'] || '0', 10);

        this.downloads.set(id, { req, fileStream, paused: false, dest, filename });
        this.emit('status', { id, status: 'downloading', filename });

        res.on('data', (chunk) => {
          received += chunk.length;
          const percent = total ? Math.floor((received / total) * 100) : 0;
          this.emit('progress', { id, percent, received, total, filename });
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          this.downloads.delete(id);
          this.emit('status', { id, status: 'completed', filename });
        });
      });

      req.on('error', (err) => {
        this.emit('status', { id, status: 'error', filename, error: err.message });
      });
    };

    request();
    return { id, filename };
  }

  pauseDownload(id) {
    const dl = this.downloads.get(id);
    if (!dl || dl.paused) return;
    dl.req.destroy();
    dl.fileStream.close();
    dl.paused = true;
    this.emit('status', { id, status: 'paused', filename: dl.filename });
  }

  resumeDownload(id) {
    const dl = this.downloads.get(id);
    if (!dl) return;
    // Simple resume: restart from scratch (V2 will use Range requests)
    const url = dl.url;
    this.downloads.delete(id);
    if (url) this.startDownload(url, id);
  }
}

module.exports = new Downloader();
