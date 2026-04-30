const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { filenameFromResponse } = require('./util');

const DEFAULT_DIR = path.join(__dirname, '..', 'downloads');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class Downloader extends EventEmitter {
  constructor() {
    super();
    this.downloads = new Map();
  }

  startDownload(url, id, options = {}) {
    const parsed = new URL(url);
    const protocol = parsed.protocol === 'https:' ? https : http;
    const fallback = `download_${id}`;
    let dest;
    let filename;
    let received = 0;
    let total = 0;
    let req = null;

    const onResponse = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        return this.startDownload(next, id, options);
      }

      if (res.statusCode >= 400) {
        this.emit('status', { id, status: 'error', error: `HTTP ${res.statusCode}` });
        return;
      }

      filename = filenameFromResponse(res, parsed, fallback);

      if (options.outputPath) {
        const op = options.outputPath;
        const isDir = op.endsWith(path.sep) || op.endsWith('/') || (fs.existsSync(op) && fs.statSync(op).isDirectory());
        if (isDir) {
          ensureDir(op);
          dest = path.join(op, filename);
        } else {
          ensureDir(path.dirname(op));
          dest = op;
          filename = path.basename(op);
        }
      } else {
        ensureDir(DEFAULT_DIR);
        dest = path.join(DEFAULT_DIR, filename);
      }

      const fileStream = fs.createWriteStream(dest);
      total = parseInt(res.headers['content-length'] || '0', 10);

      this.downloads.set(id, { req, fileStream, paused: false, dest, filename, url });
      this.emit('status', { id, status: 'downloading', filename, total, dest });

      res.on('data', (chunk) => {
        received += chunk.length;
        const percent = total ? Math.floor((received / total) * 100) : 0;
        this.emit('progress', { id, percent, received, total, filename });
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        this.downloads.delete(id);
        this.emit('status', { id, status: 'completed', filename, dest });
      });

      fileStream.on('error', (err) => {
        this.emit('status', { id, status: 'error', filename, error: err.message });
      });
    };

    req = protocol.get(url, onResponse);
    req.on('error', (err) => {
      this.emit('status', { id, status: 'error', error: err.message });
    });

    return { id };
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
    const url = dl.url;
    this.downloads.delete(id);
    if (url) this.startDownload(url, id);
  }
}

module.exports = new Downloader();
