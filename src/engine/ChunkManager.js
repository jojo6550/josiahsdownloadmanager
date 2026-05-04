'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const RangeRequest = require('./RangeRequest');
const logger = require('../logger/Logger');

const CHUNK_COUNT = 8;
const TMP_DIR_SUFFIX = '.tmp';
const MAX_REDIRECTS = 5;
const PROGRESS_DEBOUNCE_MS = 250;

class ChunkManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url         - download URL
   * @param {string} opts.dest        - final output file path
   * @param {string} opts.id          - job ID (used for temp file naming)
   * @param {number} [opts._chunkCount]   - number of chunks (default 8, override for testing)
   * @param {number[]} [opts._retryDelays] - retry delays passed to RangeRequest instances
   */
  constructor({ url, dest, id, _chunkCount, _retryDelays }) {
    super();
    this._url = url;
    this._dest = dest;
    this._id = id;
    this._chunkCount = _chunkCount || CHUNK_COUNT;
    this._retryDelays = _retryDelays || null;

    this._tmpDir = path.join(path.dirname(dest), id + TMP_DIR_SUFFIX);
    this._cancelled = false;
    this._activeRequests = [];

    // For single-stream fallback tracking
    this._singleStreamReq = null;
    this._singleStreamRes = null;

    // For HEAD probe cancellation
    this._headReq = null;

    // Stored reject for cancel() to call
    this._startReject = null;
  }

  /**
   * Start the download.
   * @returns {Promise<{ dest: string, totalBytes: number }>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this._startReject = reject;
      this._run(resolve, reject);
    });
  }

  /**
   * Cancel all active requests, reject the start() promise.
   */
  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;

    // Cancel all RangeRequest instances
    for (const rr of this._activeRequests) {
      rr.cancel();
    }
    this._activeRequests = [];

    // Cancel single-stream if active
    if (this._singleStreamRes) {
      this._singleStreamRes.destroy();
      this._singleStreamRes = null;
    }
    if (this._singleStreamReq) {
      this._singleStreamReq.destroy();
      this._singleStreamReq = null;
    }

    // Cancel HEAD probe if active
    if (this._headReq) {
      this._headReq.destroy();
      this._headReq = null;
    }

    const err = new Error('Cancelled');
    if (this._startReject) {
      this._startReject(err);
      this._startReject = null;
    }
  }

  // ─── private ────────────────────────────────────────────────────────────────

  async _run(resolve, reject) {
    try {
      // Step 1: HEAD probe
      const headInfo = await this._headProbe();

      if (this._cancelled) return;

      logger.info('ChunkManager: download start', { url: this._url, dest: this._dest, chunked: headInfo.chunked });

      if (headInfo.chunked) {
        await this._runChunked(headInfo.totalBytes, resolve, reject);
      } else {
        await this._runSingleStream(headInfo.totalBytes, resolve, reject);
      }
    } catch (err) {
      if (this._cancelled) return;
      reject(err);
    }
  }

  /**
   * Perform a HEAD request and return { chunked, totalBytes }.
   */
  _headProbe() {
    return new Promise((resolve, reject) => {
      this._doHeadRequest(this._url, 0, resolve, reject);
    });
  }

  _doHeadRequest(url, redirectCount, resolve, reject) {
    if (this._cancelled) return;

    const parsed = new URL(url);
    const protocol = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
    };

    const req = protocol.request(reqOptions, (res) => {
      if (this._cancelled) {
        res.destroy();
        return;
      }

      // Consume body (HEAD responses shouldn't have bodies, but be safe)
      res.resume();

      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        this._headReq = null;
        if (redirectCount >= MAX_REDIRECTS) {
          return reject(new Error(`Too many redirects (>${MAX_REDIRECTS})`));
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        return this._doHeadRequest(nextUrl, redirectCount + 1, resolve, reject);
      }

      if (res.statusCode !== 200 && res.statusCode !== 204) {
        this._headReq = null;
        // Server blocked HEAD (403/405 common) — fall back to single-stream GET
        if (res.statusCode === 403 || res.statusCode === 405) {
          logger.warn('ChunkManager: HEAD blocked, falling back to single-stream', { url, statusCode: res.statusCode });
          return resolve({ chunked: false, totalBytes: 0 });
        }
        return reject(new Error(`HEAD request failed with HTTP ${res.statusCode}`));
      }

      const contentLength = parseInt(res.headers['content-length'] || '0', 10);
      const acceptRanges = res.headers['accept-ranges'];

      const chunked = (
        acceptRanges === 'bytes' &&
        contentLength > 0
      );

      if (!chunked) {
        logger.warn('ChunkManager: falling back to single-stream mode', {
          url,
          contentLength,
          acceptRanges,
        });
      }

      this._headReq = null;
      resolve({ chunked, totalBytes: contentLength });
    });

    this._headReq = req;

    req.on('error', (err) => {
      this._headReq = null;
      if (this._cancelled) return;
      reject(err);
    });

    req.end();
  }

  /**
   * Run in chunked mode: split into N chunks, parallel RangeRequests, merge.
   */
  async _runChunked(totalBytes, resolve, reject) {
    const chunkCount = Math.min(this._chunkCount, totalBytes);
    const chunkSize = Math.floor(totalBytes / chunkCount);

    // Build chunk ranges
    const chunks = [];
    for (let i = 0; i < chunkCount; i++) {
      const from = i * chunkSize;
      const to = i === chunkCount - 1 ? totalBytes - 1 : (i + 1) * chunkSize - 1;
      chunks.push({ i, from, to, size: to - from + 1 });
    }

    // Ensure tmp dir exists
    if (!fs.existsSync(this._tmpDir)) {
      fs.mkdirSync(this._tmpDir, { recursive: true });
    }

    // Per-chunk state for progress tracking
    const chunkState = chunks.map(c => ({
      bytesReceived: 0,
      totalBytes: c.size,
      lastReportedBytes: 0,
      lastReportedTime: Date.now(),
      speedBps: 0,
    }));

    // Debounce progress emission per chunk
    const lastProgressEmit = new Array(chunkCount).fill(0);

    logger.debug('ChunkManager: starting chunked download', {
      url: this._url,
      chunkCount,
      totalBytes,
    });

    // Create RangeRequest instances
    const requests = chunks.map((c) => {
      const tmpFile = path.join(this._tmpDir, `chunk-${c.i}.tmp`);
      const rrOpts = {
        url: this._url,
        from: c.from,
        to: c.to,
        dest: tmpFile,
        id: this._id,
        chunkIndex: c.i,
      };
      if (this._retryDelays) {
        rrOpts._retryDelays = this._retryDelays;
      }
      const rr = new RangeRequest(rrOpts);

      rr.on('progress', (evt) => {
        if (this._cancelled) return;
        const idx = evt.chunkIndex;
        const state = chunkState[idx];
        state.bytesReceived = evt.bytesReceived;

        const now = Date.now();
        const elapsed = now - state.lastReportedTime;

        if (elapsed > 0) {
          const bytesDelta = state.bytesReceived - state.lastReportedBytes;
          state.speedBps = (bytesDelta / elapsed) * 1000;
        }

        // Update baseline on every event so speed calc is always accurate
        state.lastReportedBytes = state.bytesReceived;
        state.lastReportedTime = now;

        // Debounce per-chunk progress to at most once per 250ms
        if (now - lastProgressEmit[idx] >= PROGRESS_DEBOUNCE_MS) {
          lastProgressEmit[idx] = now;
          this._emitChunkedProgress(totalBytes, chunkState);
        }
      });

      return rr;
    });

    this._activeRequests = requests;

    // Start all in parallel
    const startPromises = requests.map((rr, i) => {
      logger.debug('ChunkManager: starting chunk', { chunkIndex: i });
      return rr.start();
    });

    try {
      await Promise.all(startPromises);
    } catch (err) {
      if (this._cancelled) return;
      for (const rr of this._activeRequests) rr.cancel();
      this._activeRequests = [];
      return reject(err);
    }

    if (this._cancelled) return;
    this._activeRequests = [];

    // Final progress emit (100%)
    this._emitChunkedProgress(totalBytes, chunkState);

    // Merge chunks into final file
    try {
      await this._mergeChunks(chunks, totalBytes);
    } catch (err) {
      if (this._cancelled) return;
      return reject(err);
    }

    if (this._cancelled) return;

    logger.info('ChunkManager: download complete', { dest: this._dest, totalBytes });
    this.emit('done', { dest: this._dest, totalBytes });
    resolve({ dest: this._dest, totalBytes });
  }

  _emitChunkedProgress(totalBytes, chunkState) {
    const receivedBytes = chunkState.reduce((sum, s) => sum + s.bytesReceived, 0);
    const chunks = chunkState.map((s, n) => ({
      n,
      percent: s.totalBytes > 0 ? (s.bytesReceived / s.totalBytes) * 100 : 0,
      speedBps: s.speedBps,
    }));
    this.emit('progress', { totalBytes, receivedBytes, chunks });
  }

  /**
   * Merge temp chunk files in order into the final dest file, then clean up.
   */
  _mergeChunks(chunks, totalBytes) {
    return new Promise((resolve, reject) => {
      // Ensure destination directory exists
      const destDir = path.dirname(this._dest);
      if (!fs.existsSync(destDir)) {
        try {
          fs.mkdirSync(destDir, { recursive: true });
        } catch (err) {
          return reject(err);
        }
      }

      const destStream = fs.createWriteStream(this._dest);
      let chunkIndex = 0;
      let rejected = false;

      const pipeNext = () => {
        if (chunkIndex >= chunks.length) {
          destStream.end();
          return;
        }

        const tmpFile = path.join(this._tmpDir, `chunk-${chunks[chunkIndex].i}.tmp`);
        chunkIndex++;

        const srcStream = fs.createReadStream(tmpFile);

        srcStream.on('error', (err) => {
          if (rejected) return;
          rejected = true;
          srcStream.destroy();
          destStream.destroy();
          reject(err);
        });

        srcStream.on('end', () => {
          pipeNext();
        });

        srcStream.pipe(destStream, { end: false });
      };

      destStream.on('error', (err) => {
        if (rejected) return;
        rejected = true;
        reject(err);
      });

      destStream.on('finish', () => {
        // Clean up temp directory
        try {
          fs.rmSync(this._tmpDir, { recursive: true, force: true });
        } catch (cleanupErr) {
          // Log but don't fail the download
          logger.warn('ChunkManager: failed to clean up temp dir', { tmpDir: this._tmpDir, error: cleanupErr.message });
        }
        resolve();
      });

      pipeNext();
    });
  }

  /**
   * Single-stream fallback: GET → pipe directly to dest.
   */
  _runSingleStream(totalBytes, resolve, reject) {
    this._doSingleStream(this._url, 0, totalBytes, resolve, reject);
  }

  _doSingleStream(url, redirectCount, totalBytes, resolve, reject) {
    if (this._cancelled) return;

    const parsed = new URL(url);
    const protocol = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
    };

    const req = protocol.request(reqOptions, (res) => {
      if (this._cancelled) {
        res.destroy();
        return;
      }

      this._singleStreamRes = res;

      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        this._singleStreamRes = null;
        if (redirectCount >= MAX_REDIRECTS) {
          return reject(new Error(`Too many redirects (>${MAX_REDIRECTS})`));
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        return this._doSingleStream(nextUrl, redirectCount + 1, totalBytes, resolve, reject);
      }

      if (res.statusCode !== 200) {
        res.destroy();
        this._singleStreamRes = null;
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      // Use Content-Length from GET response if we didn't get it from HEAD
      const clHeader = res.headers['content-length'];
      if (clHeader) {
        totalBytes = parseInt(clHeader, 10) || totalBytes;
      }

      // Ensure dest directory exists
      const destDir = path.dirname(this._dest);
      if (!fs.existsSync(destDir)) {
        try {
          fs.mkdirSync(destDir, { recursive: true });
        } catch (err) {
          res.destroy();
          this._singleStreamRes = null;
          return reject(err);
        }
      }

      const destStream = fs.createWriteStream(this._dest);
      let receivedBytes = 0;
      let settled = false;

      res.on('data', (chunk) => {
        if (this._cancelled) return;
        receivedBytes += chunk.length;
        this.emit('progress', { totalBytes, receivedBytes, chunks: [] });
      });

      res.on('error', (err) => {
        if (this._cancelled || settled) return;
        settled = true;
        destStream.destroy();
        this._singleStreamRes = null;
        reject(err);
      });

      destStream.on('error', (err) => {
        if (this._cancelled || settled) return;
        settled = true;
        destStream.destroy();
        this._singleStreamRes = null;
        reject(err);
      });

      destStream.on('finish', () => {
        if (this._cancelled || settled) return;
        settled = true;
        this._singleStreamRes = null;
        this._singleStreamReq = null;
        logger.info('ChunkManager: single-stream download complete', { dest: this._dest, totalBytes: receivedBytes });
        this.emit('done', { dest: this._dest, totalBytes: receivedBytes });
        resolve({ dest: this._dest, totalBytes: receivedBytes });
      });

      res.pipe(destStream);
    });

    this._singleStreamReq = req;

    req.on('error', (err) => {
      if (this._cancelled) return;
      reject(err);
    });

    req.end();
  }
}

module.exports = ChunkManager;
