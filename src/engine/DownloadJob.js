'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const ChunkManager = require('./ChunkManager');
const logger = require('../logger/Logger');

const VALID_STATUSES = new Set([
  'idle', 'queued', 'downloading', 'paused', 'completed', 'error', 'cancelled',
]);

class DownloadJob extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url   - download URL
   * @param {string} opts.dest  - output file path
   * @param {string} opts.id    - unique job ID
   */
  constructor({ url, dest, id }) {
    super();

    this.id = id;
    this.url = url;
    this.dest = dest;

    this.status = 'idle';
    this.filename = null;

    this.totalBytes = 0;
    this.receivedBytes = 0;
    this.speedBps = 0;
    this.etaSecs = null;
    this.chunks = [];
    this.error = null;
    this.createdAt = new Date();

    this._chunkManager = null;
  }

  // ─── Public state-machine methods ──────────────────────────────────────────

  /**
   * Transition idle → queued.
   */
  enqueue() {
    if (this.status !== 'idle') {
      throw new Error(`enqueue() called from invalid state: ${this.status}`);
    }
    this._setStatus('queued');
  }

  /**
   * Transition queued → downloading.
   * Creates a ChunkManager and starts the download.
   * @param {object} [options]
   * @param {number} [options._chunkCount]
   * @param {number[]} [options._retryDelays]
   * @returns {Promise<void>}
   */
  async start(options = {}) {
    if (this.status !== 'queued') {
      throw new Error(`start() called from invalid state: ${this.status}`);
    }

    this.filename = path.basename(this.dest);
    this._setStatus('downloading');

    const cm = new ChunkManager({
      url: this.url,
      dest: this.dest,
      id: this.id,
      _chunkCount: options._chunkCount,
      _retryDelays: options._retryDelays,
    });
    this._chunkManager = cm;

    cm.on('progress', (evt) => {
      if (this.status !== 'downloading') return;

      const { totalBytes, receivedBytes, chunks } = evt;

      this.totalBytes = totalBytes || this.totalBytes;
      this.receivedBytes = receivedBytes;

      // Aggregate speed across chunks
      if (Array.isArray(chunks) && chunks.length > 0) {
        this.speedBps = chunks.reduce((sum, c) => sum + (c.speedBps || 0), 0);
      }

      // Compute ETA
      const remaining = this.totalBytes - this.receivedBytes;
      this.etaSecs = (this.speedBps > 0 && this.totalBytes > 0)
        ? remaining / this.speedBps
        : null;

      this.chunks = Array.isArray(chunks) ? chunks : [];

      const overall = {
        percent: this.totalBytes > 0
          ? (this.receivedBytes / this.totalBytes) * 100
          : 0,
        receivedBytes: this.receivedBytes,
        totalBytes: this.totalBytes,
        speedBps: this.speedBps,
        etaSecs: this.etaSecs,
      };

      const progressPayload = { id: this.id, overall, chunks: this.chunks };
      this.emit('progress', progressPayload);
      this.emit('chunk-progress', progressPayload);
    });

    cm.on('done', () => {
      if (this._chunkManager !== cm) return;
      this._chunkManager = null;
      this._setStatus('completed');
    });

    cm.on('error', (err) => {
      if (this._chunkManager !== cm) return;
      this._chunkManager = null;
      this.error = err;
      this._setStatus('error');
    });

    try {
      await cm.start();
    } catch (err) {
      // Only handle the error if it wasn't already handled by the 'error' event
      // and not due to a cancel/pause.
      if (this._chunkManager === cm) {
        this._chunkManager = null;
        if (this.status === 'downloading') {
          this.error = err;
          this._setStatus('error');
        }
      }
      // If status is already cancelled/paused, swallow silently.
    }
  }

  /**
   * Transition downloading → paused.
   */
  pause() {
    if (this.status !== 'downloading') {
      throw new Error(`pause() called from invalid state: ${this.status}`);
    }

    const cm = this._chunkManager;
    this._chunkManager = null;
    if (cm) {
      cm.removeAllListeners();
      cm.cancel();
    }

    this._setStatus('paused');
  }

  /**
   * Transition paused → downloading. Re-creates ChunkManager from scratch.
   * @param {object} [options]
   * @param {number} [options._chunkCount]
   * @param {number[]} [options._retryDelays]
   * @returns {Promise<void>}
   */
  resume(options = {}) {
    if (this.status !== 'paused') {
      throw new Error(`resume() called from invalid state: ${this.status}`);
    }

    // Reset progress so the re-created manager starts fresh
    this.receivedBytes = 0;
    this.speedBps = 0;
    this.etaSecs = null;
    this.chunks = [];

    this._setStatus('queued');
    return this.start(options);
  }

  /**
   * Cancel from queued or downloading state.
   */
  cancel() {
    if (this.status !== 'queued' && this.status !== 'downloading') {
      throw new Error(`cancel() called from invalid state: ${this.status}`);
    }

    const cm = this._chunkManager;
    this._chunkManager = null;
    if (cm) {
      cm.removeAllListeners();
      cm.cancel();
    }

    this._setStatus('cancelled');
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  _setStatus(newStatus) {
    if (!VALID_STATUSES.has(newStatus)) {
      throw new Error(`Unknown status: ${newStatus}`);
    }
    this.status = newStatus;
    logger.info('DownloadJob: status change', { id: this.id, status: newStatus });
    this.emit('status', {
      id: this.id,
      status: this.status,
      filename: this.filename,
      dest: this.dest,
      error: this.error,
    });
  }
}

module.exports = DownloadJob;
