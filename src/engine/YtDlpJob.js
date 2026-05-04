'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const ytDlp = require('../scraper/ytDlp');
const logger = require('../logger/Logger');

class YtDlpJob extends EventEmitter {
  constructor({ url, dest, id, formatId }) {
    super();
    this.id        = id;
    this.url       = url;
    this.dest      = dest;
    this.formatId  = formatId;

    this.status        = 'idle';
    this.filename      = null;
    this.totalBytes    = 0;
    this.receivedBytes = 0;
    this.speedBps      = 0;
    this.etaSecs       = null;
    this.error         = null;
    this.createdAt     = new Date();

    this._proc = null;
  }

  enqueue() {
    if (this.status !== 'idle') throw new Error(`enqueue() from invalid state: ${this.status}`);
    this._setStatus('queued');
  }

  async start() {
    if (this.status !== 'queued') throw new Error(`start() from invalid state: ${this.status}`);
    this._setStatus('downloading');

    const { proc, promise } = ytDlp.download(this.url, this.formatId, this.dest, {
      onProgress: ({ percent, totalBytes, receivedBytes, speedBps, etaSecs }) => {
        this.totalBytes    = totalBytes;
        this.receivedBytes = receivedBytes;
        this.speedBps      = speedBps;
        this.etaSecs       = etaSecs;
        this.emit('progress', { overall: { percent, totalBytes, receivedBytes, speedBps, etaSecs } });
      },
      onFilename: (filename) => {
        this.filename = path.basename(filename);
        this.dest     = filename;
        this.emit('status', { status: 'downloading', filename: this.filename, dest: this.dest });
      },
    });

    this._proc = proc;

    try {
      await promise;
      this._setStatus('completed');
    } catch (err) {
      if (this.status === 'cancelled') return;
      this.error = err;
      this._setStatus('error', { error: err });
    }
  }

  // yt-dlp has no pause — cancel instead
  pause() { this.cancel(); }

  cancel() {
    if (!['queued', 'downloading', 'paused'].includes(this.status)) return;
    if (this._proc) this._proc.kill('SIGTERM');
    this._setStatus('cancelled');
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    logger.info('YtDlpJob: status', { id: this.id, status });
    this.emit('status', { status, filename: this.filename, dest: this.dest, ...extra });
  }
}

module.exports = YtDlpJob;
