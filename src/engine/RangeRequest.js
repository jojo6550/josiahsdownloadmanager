'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000];
const MAX_REDIRECTS = 5;

class RangeRequest extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {number} opts.from  - start byte (inclusive)
   * @param {number} opts.to    - end byte (inclusive)
   * @param {string} opts.dest  - path to write temp file
   * @param {string} opts.id    - download job id
   * @param {number} opts.chunkIndex - 0-based chunk number
   * @param {number[]} [opts._retryDelays] - override retry delays (for testing)
   */
  constructor({ url, from, to, dest, id, chunkIndex, _retryDelays }) {
    super();
    this._url = url;
    this._from = from;
    this._to = to;
    this._dest = dest;
    this._id = id;
    this._chunkIndex = chunkIndex;
    this._retryDelays = _retryDelays || DEFAULT_RETRY_DELAYS;

    this._totalBytes = to - from + 1;
    this.bytesReceived = 0;

    this._cancelled = false;
    this._currentReq = null;
    this._currentRes = null;
    this._retryAttempt = 0;
    // Stored so cancel() can immediately reject the pending promise
    this._reject = null;
  }

  /**
   * Start the download. Returns a Promise that resolves when done.
   */
  start() {
    return new Promise((resolve, reject) => {
      this._reject = reject;
      this._attempt(this._url, 0, resolve, reject);
    });
  }

  /**
   * Cancel the in-flight request immediately.
   */
  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;

    if (this._currentRes) {
      this._currentRes.destroy();
      this._currentRes = null;
    }
    if (this._currentReq) {
      this._currentReq.destroy();
      this._currentReq = null;
    }

    const err = new Error('Cancelled');
    if (this._reject) {
      this._reject(err);
      this._reject = null;
    }
    // Only emit 'error' if there are listeners — emitting with no listener throws in Node.js
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  // ─── private ────────────────────────────────────────────────────────────────

  _attempt(url, redirectCount, resolve, reject) {
    if (this._cancelled) {
      return; // cancel() already rejected
    }

    // Reset bytesReceived for this attempt
    this.bytesReceived = 0;

    const parsed = new URL(url);
    const protocol = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        Range: `bytes=${this._from}-${this._to}`,
      },
    };

    const req = protocol.request(reqOptions, (res) => {
      if (this._cancelled) {
        res.destroy();
        return;
      }

      this._currentRes = res;

      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        this._currentRes = null;
        if (redirectCount >= MAX_REDIRECTS) {
          const err = new Error(`Too many redirects (>${MAX_REDIRECTS})`);
          this.emit('error', err);
          reject(err);
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        this._attempt(nextUrl, redirectCount + 1, resolve, reject);
        return;
      }

      // Expect 206 for range requests; 200 is also acceptable (server may not support ranges)
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.destroy();
        this._currentRes = null;
        const err = new Error(`HTTP ${res.statusCode}`);
        this.emit('error', err);
        reject(err);
        return; // Do NOT retry HTTP errors
      }

      // Ensure destination directory exists
      const dir = path.dirname(this._dest);
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (err) {
          res.destroy();
          this._currentRes = null;
          reject(err);
          return;
        }
      }

      const fileStream = fs.createWriteStream(this._dest);
      // Guard: once this attempt is settled (via network error/retry or done), stop
      // fileStream events from double-resolving/rejecting the outer promise.
      let attemptSettled = false;

      res.on('data', (chunk) => {
        if (this._cancelled) return;
        this.bytesReceived += chunk.length;
        this.emit('progress', {
          chunkIndex: this._chunkIndex,
          bytesReceived: this.bytesReceived,
          totalBytes: this._totalBytes,
        });
      });

      // Handle response stream errors (e.g. socket destroyed mid-stream)
      res.on('error', (err) => {
        if (this._cancelled) return; // cancel() already handled rejection
        attemptSettled = true;
        fileStream.destroy();
        this._onNetworkError(err, url, redirectCount, resolve, reject);
      });

      fileStream.on('error', (err) => {
        if (this._cancelled || attemptSettled) return;
        attemptSettled = true;
        this.emit('error', err);
        reject(err);
      });

      fileStream.on('finish', () => {
        if (this._cancelled || attemptSettled) return;
        attemptSettled = true;
        this._currentRes = null;
        this._currentReq = null;
        this.emit('done', { chunkIndex: this._chunkIndex, dest: this._dest });
        resolve();
      });

      res.pipe(fileStream);
    });

    this._currentReq = req;

    req.on('error', (err) => {
      if (this._cancelled) return; // cancel() already handled rejection
      this._onNetworkError(err, url, redirectCount, resolve, reject);
    });

    req.end();
  }

  _onNetworkError(err, url, redirectCount, resolve, reject) {
    const attempt = this._retryAttempt;
    this._retryAttempt = attempt + 1;

    if (attempt < this._retryDelays.length) {
      const delay = this._retryDelays[attempt];
      setTimeout(() => {
        if (this._cancelled) return;
        this._attempt(url, redirectCount, resolve, reject);
      }, delay);
    } else {
      this.emit('error', err);
      reject(err);
    }
  }
}

module.exports = RangeRequest;
