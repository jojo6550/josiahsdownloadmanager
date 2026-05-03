'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Set JDM_DOWNLOAD_DIR before requiring Logger (singleton)
const logTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdm-dq-log-'));
process.env.JDM_DOWNLOAD_DIR = logTmpDir;

const DownloadQueue = require('../../src/engine/DownloadQueue');

// ─── Shared test data ────────────────────────────────────────────────────────

// 2000 bytes of deterministic content (0x00..0xFF repeating)
const FILE_BODY = Buffer.alloc(2000);
for (let i = 0; i < FILE_BODY.length; i++) FILE_BODY[i] = i % 256;

let server;
let port;
let tmpDir;

// Mutable handler so tests can override per-test
let requestHandler = null;

// ─── Default HTTP handler ─────────────────────────────────────────────────────

function defaultHandler(req, res) {
  if (req.url === '/file') {
    const rangeHeader = req.headers['range'];
    if (req.method === 'HEAD' || !rangeHeader) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': FILE_BODY.length,
        'Accept-Ranges': 'bytes',
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(FILE_BODY);
      }
      return;
    }
    const match = rangeHeader.match(/bytes=(\d+)-(\d+)/);
    if (match) {
      const from = parseInt(match[1], 10);
      const to = parseInt(match[2], 10);
      const slice = FILE_BODY.slice(from, to + 1);
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${from}-${to}/${FILE_BODY.length}`,
        'Content-Length': slice.length,
      });
      res.end(slice);
      return;
    }
  }
  res.writeHead(404);
  res.end();
}

/**
 * Slow handler that drips bytes one-at-a-time every `intervalMs` ms.
 * Used for timing-sensitive tests (pause, cancel mid-download).
 */
function slowHandler(intervalMs = 5) {
  return (req, res) => {
    if (req.url === '/file') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Length': FILE_BODY.length,
          'Accept-Ranges': 'bytes',
        });
        res.end();
        return;
      }
      const rangeHeader = req.headers['range'];
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d+)/);
        if (match) {
          const from = parseInt(match[1], 10);
          const to = parseInt(match[2], 10);
          const slice = FILE_BODY.slice(from, to + 1);
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Range': `bytes ${from}-${to}/${FILE_BODY.length}`,
            'Content-Length': slice.length,
          });
          let sent = 0;
          const interval = setInterval(() => {
            if (sent >= slice.length) { clearInterval(interval); res.end(); return; }
            res.write(slice.slice(sent, sent + 1));
            sent++;
          }, intervalMs);
          req.on('close', () => clearInterval(interval));
          return;
        }
      }
    }
    defaultHandler(req, res);
  };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdm-dq-test-'));

  server = http.createServer((req, res) => {
    if (requestHandler) {
      requestHandler(req, res);
      return;
    }
    defaultHandler(req, res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try { fs.rmSync(logTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  requestHandler = null;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

let counter = 0;
function uniqueName() {
  return `dl-${Date.now()}-${++counter}.bin`;
}

function destPath() {
  return path.join(tmpDir, uniqueName());
}

function fileUrl() {
  return `http://127.0.0.1:${port}/file`;
}

function makeQueue(opts = {}) {
  return new DownloadQueue(opts);
}

const TEST_OPTIONS = { _chunkCount: 2, _retryDelays: [10, 20, 40] };

/**
 * Wait for a job to reach a given status.
 * Resolves when the job emits 'status' with the expected value,
 * or rejects after `timeoutMs`.
 */
function waitForStatus(job, targetStatus, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (job.status === targetStatus) { resolve(); return; }
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for status '${targetStatus}', current: '${job.status}'`));
    }, timeoutMs);
    const onStatus = ({ status }) => {
      if (status === targetStatus) {
        clearTimeout(timer);
        job.off('status', onStatus);
        resolve();
      }
    };
    job.on('status', onStatus);
  });
}

/**
 * Wait for the queue to emit 'job:status' with the given jobId and status.
 */
function waitForQueueStatus(queue, jobId, targetStatus, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Queue timed out waiting for job ${jobId} to reach status '${targetStatus}'`));
    }, timeoutMs);
    const onStatus = (payload) => {
      if (payload.id === jobId && payload.status === targetStatus) {
        clearTimeout(timer);
        queue.off('job:status', onStatus);
        resolve();
      }
    };
    queue.on('job:status', onStatus);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('1. add() returns { id, job } and job status is queued', () => {
  // Use maxConcurrent:0 so no job auto-starts and we can inspect the queued state
  const queue = makeQueue({ maxConcurrent: 0 });
  const { id, job } = queue.add(fileUrl(), destPath());

  assert.ok(typeof id === 'string' && id.length > 0, 'id should be a non-empty string');
  assert.ok(job, 'job should be returned');
  assert.equal(job.status, 'queued', 'job status should be queued immediately after add');
  assert.equal(job.id, id, 'job.id should match returned id');
  assert.equal(job.url, fileUrl(), 'job.url should match added url');
});

test('2. job starts automatically when added if a slot is available', async () => {
  const queue = makeQueue({ maxConcurrent: 1 });
  const { id, job } = queue.add(fileUrl(), destPath());

  // _flush() runs synchronously, so by the time add() returns the job is
  // either in 'downloading' (start() was called) or already completed.
  // Wait for completed to be safe.
  await waitForStatus(job, 'completed', 5000);

  assert.equal(job.status, 'completed', 'job should complete automatically');
  assert.ok(fs.existsSync(job.dest), 'downloaded file should exist');
  // Queue should be clean
  assert.equal(queue._activeIds.size, 0);
  assert.equal(queue._pendingIds.length, 0);

  void id; // suppress unused-var lint
});

test('3. only maxConcurrent jobs run simultaneously (maxConcurrent: 1)', async () => {
  const queue = makeQueue({ maxConcurrent: 1 });

  // Add two jobs
  const { id: id1, job: job1 } = queue.add(fileUrl(), destPath());
  const { id: id2, job: job2 } = queue.add(fileUrl(), destPath());

  // After add, job1 should be active and job2 should still be queued
  assert.ok(
    job1.status === 'downloading' || job1.status === 'completed',
    `job1 should be downloading or completed, got: ${job1.status}`
  );
  assert.equal(job2.status, 'queued', 'job2 should still be queued while job1 is active');
  assert.equal(queue._activeIds.size, 1, 'only 1 active job allowed');
  assert.ok(queue._activeIds.has(id1), 'job1 should be the active one');

  // Wait for both to complete
  await waitForStatus(job1, 'completed', 5000);
  await waitForStatus(job2, 'completed', 5000);

  assert.equal(job1.status, 'completed');
  assert.equal(job2.status, 'completed');
  assert.equal(queue._activeIds.size, 0);
  assert.equal(queue._pendingIds.length, 0);

  void id2;
});

test('4. completing a job starts the next pending job', async () => {
  const queue = makeQueue({ maxConcurrent: 1 });

  const { job: job1 } = queue.add(fileUrl(), destPath());
  const { job: job2 } = queue.add(fileUrl(), destPath());

  // job2 should be queued while job1 runs
  assert.equal(job2.status, 'queued');

  // Wait for job1 to complete — that should trigger job2 to start
  await waitForStatus(job1, 'completed', 5000);

  // job2 should now be active (downloading or completed)
  assert.ok(
    job2.status === 'downloading' || job2.status === 'completed',
    `job2 should have started after job1 completed, got: ${job2.status}`
  );

  // Wait for job2 to finish as well
  await waitForStatus(job2, 'completed', 5000);
  assert.equal(job2.status, 'completed');
});

test('5. pause() frees a slot and starts the next pending job', async () => {
  requestHandler = slowHandler(5);

  const queue = makeQueue({ maxConcurrent: 1 });

  const { id: id1, job: job1 } = queue.add(fileUrl(), destPath());
  const { job: job2 } = queue.add(fileUrl(), destPath());

  // Wait until job1 is definitely downloading
  await waitForStatus(job1, 'downloading', 3000);
  assert.equal(job2.status, 'queued', 'job2 should still be queued');

  // Now pause job1 via the queue — this should free the slot and start job2
  // Use fast server for job2
  requestHandler = null;
  queue.pause(id1);

  // job1 should become paused
  await waitForStatus(job1, 'paused', 3000);

  // job2 should now be started (downloading or completed)
  await waitForStatus(job2, 'completed', 5000).catch(() => waitForStatus(job2, 'downloading', 3000));
  assert.ok(
    job2.status === 'downloading' || job2.status === 'completed',
    `job2 should have started after pause freed a slot, got: ${job2.status}`
  );
});

test('6. resume() restarts a paused job and it completes', async () => {
  requestHandler = slowHandler(5);

  const queue = makeQueue({ maxConcurrent: 1 });

  const { id: id1, job: job1 } = queue.add(fileUrl(), destPath());

  // Wait until downloading, then pause
  await waitForStatus(job1, 'downloading', 3000);
  queue.pause(id1);
  await waitForStatus(job1, 'paused', 3000);

  assert.equal(job1.status, 'paused');
  assert.equal(queue._activeIds.size, 0, 'no active jobs after pause');

  // Switch to fast server for resume
  requestHandler = null;

  queue.resume(id1);

  // job should complete
  await waitForStatus(job1, 'completed', 5000);
  assert.equal(job1.status, 'completed');
  assert.ok(fs.existsSync(job1.dest), 'file should exist after resume');
  assert.equal(queue._activeIds.size, 0, 'no active jobs after completion');
});

test('7. resume() respects maxConcurrent — does not exceed cap', async () => {
  requestHandler = slowHandler(5);

  const queue = makeQueue({ maxConcurrent: 1 });

  // Add and pause job1
  const { id: id1, job: job1 } = queue.add(fileUrl(), destPath());
  await waitForStatus(job1, 'downloading', 3000);
  queue.pause(id1);
  await waitForStatus(job1, 'paused', 3000);

  // Add job2 which will fill the slot
  const { job: job2 } = queue.add(fileUrl(), destPath());
  // job2 should now be the active one
  assert.ok(
    job2.status === 'downloading' || job2.status === 'completed',
    `job2 should be active, got: ${job2.status}`
  );
  assert.equal(queue._activeIds.size, 1, 'only 1 slot used');

  // Attempt to resume job1 — slot is full, so it should be re-queued, not started
  queue.resume(id1);

  // job1 must NOT be active (slot is taken by job2)
  assert.equal(job1.status, 'paused', `job1 should remain paused, got: ${job1.status}`);
  assert.equal(queue._activeIds.size, 1, 'active count should not exceed maxConcurrent');
  // job1 should be at the front of pending
  assert.equal(queue._pendingIds[0], id1, 'job1 should be at the front of pending');

  // Wait for job2 to complete, which should then auto-start job1
  requestHandler = null;
  await waitForStatus(job2, 'completed', 5000);

  // Now job1 should start
  await waitForStatus(job1, 'completed', 5000);
  assert.equal(job1.status, 'completed');
});

test('8. cancel() from queued removes job from pending without starting', () => {
  // Use maxConcurrent:0 so nothing auto-starts
  const queue = makeQueue({ maxConcurrent: 0 });

  const { id, job } = queue.add(fileUrl(), destPath());

  assert.equal(job.status, 'queued');
  assert.ok(queue._pendingIds.includes(id), 'job should be in pending');

  queue.cancel(id);

  assert.equal(job.status, 'cancelled', 'job should be cancelled');
  assert.ok(!queue._pendingIds.includes(id), 'job should be removed from pending');
  assert.ok(!queue._activeIds.has(id), 'job should not be active');
});

test('9. cancel() from downloading frees slot and starts next pending job', async () => {
  requestHandler = slowHandler(5);

  const queue = makeQueue({ maxConcurrent: 1 });

  const { id: id1, job: job1 } = queue.add(fileUrl(), destPath());
  const { job: job2 } = queue.add(fileUrl(), destPath());

  // Wait for job1 to be actively downloading
  await waitForStatus(job1, 'downloading', 3000);
  assert.equal(job2.status, 'queued');

  // Use fast server for job2
  requestHandler = null;

  // Cancel job1 — this should free the slot and trigger job2
  queue.cancel(id1);

  await waitForStatus(job1, 'cancelled', 3000);
  assert.equal(job1.status, 'cancelled');

  // job2 should start and complete
  await waitForStatus(job2, 'completed', 5000);
  assert.equal(job2.status, 'completed');
  assert.equal(queue._activeIds.size, 0);
});

test('10. getJobs() returns all jobs including completed ones', async () => {
  const queue = makeQueue({ maxConcurrent: 2 });

  const { job: job1 } = queue.add(fileUrl(), destPath());
  const { job: job2 } = queue.add(fileUrl(), destPath());
  const { job: job3 } = queue.add(fileUrl(), destPath());

  // Wait for all to complete
  await Promise.all([
    waitForStatus(job1, 'completed', 5000),
    waitForStatus(job2, 'completed', 5000),
    waitForStatus(job3, 'completed', 5000),
  ]);

  const all = queue.getJobs();
  assert.equal(all.length, 3, 'getJobs() should return all 3 jobs');
  assert.ok(all.every((j) => j.status === 'completed'), 'all jobs should be completed');
});
