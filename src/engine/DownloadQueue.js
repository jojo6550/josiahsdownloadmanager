'use strict';

const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const DownloadJob = require('./DownloadJob');
const logger = require('../logger/Logger');

const MAX_CONCURRENT = 3;

class DownloadQueue extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxConcurrent] - max simultaneous downloads (default: MAX_CONCURRENT)
   */
  constructor({ maxConcurrent = MAX_CONCURRENT } = {}) {
    super();
    this.maxConcurrent = maxConcurrent;

    /** @type {Map<string, DownloadJob>} */
    this._jobs = new Map();

    /** @type {Set<string>} */
    this._activeIds = new Set();

    /** @type {string[]} */
    this._pendingIds = [];
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Add a new download to the queue.
   * @param {string} url
   * @param {string} dest
   * @returns {{ id: string, job: DownloadJob }}
   */
  add(url, dest) {
    const id = randomUUID();
    const job = new DownloadJob({ url, dest, id });

    job.enqueue();

    this._jobs.set(id, job);
    this._pendingIds.push(id);

    logger.info('DownloadQueue: job added', { id, url, dest });
    logger.debug('DownloadQueue: queue state', {
      pending: this._pendingIds.length,
      active: this._activeIds.size,
    });

    this._flush();

    return { id, job };
  }

  /**
   * Pause an active download.
   * @param {string} id
   */
  pause(id) {
    const job = this._jobs.get(id);
    if (!job) return;

    if (job.status === 'downloading') {
      job.pause();
      this._activeIds.delete(id);

      logger.debug('DownloadQueue: job paused', { id });
      this._flush();
    }
  }

  /**
   * Resume a paused download.
   * Respects maxConcurrent — if no slot is free, re-queues at front of pending.
   * @param {string} id
   */
  resume(id) {
    const job = this._jobs.get(id);
    if (!job || job.status !== 'paused') return;

    if (this._activeIds.size >= this.maxConcurrent) {
      // No slot available — re-queue at front so it starts next when one opens
      this._pendingIds.unshift(id);
      logger.debug('DownloadQueue: job re-queued (maxConcurrent reached)', { id });
      return;
    }

    // Slot available — attach listeners and resume immediately
    this._activeIds.add(id);
    this._attachJobListeners(id, job);
    job.resume().catch(() => {});

    logger.debug('DownloadQueue: job resumed', { id });
  }

  /**
   * Cancel a queued or active download.
   * @param {string} id
   */
  cancel(id) {
    const job = this._jobs.get(id);
    if (!job) return;

    if (job.status === 'queued' || job.status === 'downloading' || job.status === 'paused') {
      job.cancel();
      this._activeIds.delete(id);
      const pendingIdx = this._pendingIds.indexOf(id);
      if (pendingIdx !== -1) {
        this._pendingIds.splice(pendingIdx, 1);
      }

      logger.debug('DownloadQueue: job cancelled', { id });
      this._flush();
    }
  }

  /**
   * Get a single job by ID.
   * @param {string} id
   * @returns {DownloadJob|undefined}
   */
  getJob(id) {
    return this._jobs.get(id);
  }

  /**
   * Get all jobs.
   * @returns {DownloadJob[]}
   */
  getJobs() {
    return Array.from(this._jobs.values());
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  /**
   * Attach named progress/status listeners to a job.
   * Listeners are removed when the job reaches a terminal or paused state
   * to prevent listener leaks.
   * @param {string} id
   * @param {DownloadJob} job
   * @private
   */
  _attachJobListeners(id, job) {
    const onProgress = (payload) => {
      this.emit('job:progress', { id, ...payload });
    };

    const onStatus = (payload) => {
      this.emit('job:status', { id, ...payload });

      const { status } = payload;
      if (status === 'completed') {
        logger.info('DownloadQueue: job completed', { id, url: job.url });
        job.off('progress', onProgress);
        job.off('status', onStatus);
        this._activeIds.delete(id);
        this._flush();
      } else if (status === 'error') {
        logger.error('DownloadQueue: job error', { id, url: job.url, error: job.error && job.error.message });
        job.off('progress', onProgress);
        job.off('status', onStatus);
        this._activeIds.delete(id);
        this._flush();
      } else if (status === 'cancelled') {
        job.off('progress', onProgress);
        job.off('status', onStatus);
        this._activeIds.delete(id);
        this._flush();
      } else if (status === 'paused') {
        // Clean up listeners and free the slot — do NOT re-queue
        job.off('progress', onProgress);
        job.off('status', onStatus);
        this._activeIds.delete(id);
        this._flush();
      }
    };

    job.on('progress', onProgress);
    job.on('status', onStatus);
  }

  /**
   * Start pending jobs up to maxConcurrent.
   * Handles both queued and paused jobs in the pending list.
   * @private
   */
  _flush() {
    while (this._activeIds.size < this.maxConcurrent && this._pendingIds.length > 0) {
      const id = this._pendingIds.shift();
      const job = this._jobs.get(id);

      if (!job) continue;

      this._activeIds.add(id);
      this._attachJobListeners(id, job);

      logger.info('DownloadQueue: job starting', { id, url: job.url });
      logger.debug('DownloadQueue: queue state after start', {
        pending: this._pendingIds.length,
        active: this._activeIds.size,
      });

      if (job.status === 'paused') {
        job.resume().catch(() => {});
      } else {
        job.start().catch(() => {});
      }
    }
  }
}

module.exports = DownloadQueue;
module.exports.MAX_CONCURRENT = MAX_CONCURRENT;
