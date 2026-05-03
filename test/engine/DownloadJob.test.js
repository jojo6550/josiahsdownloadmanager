'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Set JDM_DOWNLOAD_DIR before requiring Logger (singleton)
const logTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdm-dj-log-'));
process.env.JDM_DOWNLOAD_DIR = logTmpDir;

const DownloadJob = require('../../src/engine/DownloadJob');

// ─── Shared test data ────────────────────────────────────────────────────────

// 2000 bytes of deterministic content (0x00..0xFF repeating)
const FILE_BODY = Buffer.alloc(2000);
for (let i = 0; i < FILE_BODY.length; i++) FILE_BODY[i] = i % 256;

let server;
let port;
let tmpDir;

// Mutable handler so tests can override per-test
let requestHandler = null;

// ─── Default HTTP handler ────────────────────────────────────────────────────

function defaultHandler(req, res) {
  if (req.url === '/file') {
    const rangeHeader = req.headers['range'];
    if (req.method === 'HEAD' || !rangeHeader) {
      // HEAD or GET without range → full file with Accept-Ranges
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
  } else if (req.url === '/error500') {
    res.writeHead(500);
    res.end('internal server error');
  } else {
    res.writeHead(404);
    res.end();
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdm-dj-test-'));

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

let counter = 0;
function uniqueId() {
  return `job-${Date.now()}-${++counter}`;
}

function destPath(name) {
  return path.join(tmpDir, name);
}

function makeJob(overrides = {}) {
  const id = uniqueId();
  return new DownloadJob({
    url: `http://127.0.0.1:${port}/file`,
    dest: destPath(`dl-${id}.bin`),
    id,
    ...overrides,
  });
}

const TEST_OPTIONS = { _chunkCount: 2, _retryDelays: [10, 20, 40] };

// ─── Tests ────────────────────────────────────────────────────────────────────

test('1. Initial state is idle, all fields have correct defaults', () => {
  const job = makeJob();

  assert.equal(job.status, 'idle');
  assert.ok(typeof job.id === 'string' && job.id.length > 0, 'id should be non-empty string');
  assert.ok(typeof job.url === 'string', 'url should be a string');
  assert.ok(typeof job.dest === 'string', 'dest should be a string');
  assert.equal(job.filename, null);
  assert.equal(job.totalBytes, 0);
  assert.equal(job.receivedBytes, 0);
  assert.equal(job.speedBps, 0);
  assert.equal(job.etaSecs, null);
  assert.deepEqual(job.chunks, []);
  assert.equal(job.error, null);
  assert.ok(job.createdAt instanceof Date, 'createdAt should be a Date');
});

test('1b. invalid state transitions throw', async () => {
  const job = makeJob();
  // idle: only enqueue() is valid
  // start() is async so its guard surfaces as a rejected promise
  await assert.rejects(() => job.start(), /invalid state/i);
  assert.throws(() => job.pause(), /invalid state/i);
  assert.throws(() => job.resume(), /invalid state/i);
  assert.throws(() => job.cancel(), /invalid state/i);
});

test('2. enqueue() transitions to queued, emits status', () => {
  const job = makeJob();
  const statusEvents = [];
  job.on('status', (e) => statusEvents.push(e));

  job.enqueue();

  assert.equal(job.status, 'queued');
  assert.equal(statusEvents.length, 1);
  assert.equal(statusEvents[0].status, 'queued');
  assert.equal(statusEvents[0].id, job.id);
});

test('3. start() transitions to downloading, emits status', async () => {
  const job = makeJob();
  const statusEvents = [];
  job.on('status', (e) => statusEvents.push(e));

  job.enqueue();
  const startPromise = job.start(TEST_OPTIONS);

  // The status should have switched to downloading synchronously inside start()
  assert.equal(job.status, 'downloading');

  await startPromise;

  // Should have at least: queued, downloading, completed
  const statuses = statusEvents.map((e) => e.status);
  assert.ok(statuses.includes('downloading'), 'should have emitted downloading');
});

test('4. On completion, status is completed, file exists on disk', async () => {
  const job = makeJob();
  job.enqueue();
  await job.start(TEST_OPTIONS);

  assert.equal(job.status, 'completed');
  assert.ok(fs.existsSync(job.dest), 'downloaded file should exist on disk');

  const written = fs.readFileSync(job.dest);
  assert.deepEqual(written, FILE_BODY, 'file content should match source');
});

test('5. progress events emitted during download with correct shape', async () => {
  const job = makeJob();
  const progressEvents = [];
  job.on('progress', (e) => progressEvents.push(e));

  job.enqueue();
  await job.start(TEST_OPTIONS);

  assert.ok(progressEvents.length > 0, 'should emit at least one progress event');

  const evt = progressEvents[0];
  assert.equal(evt.id, job.id, 'progress event should contain job id');
  assert.ok(evt.overall, 'progress event should have overall field');
  assert.ok(typeof evt.overall.percent === 'number', 'overall.percent should be a number');
  assert.ok(typeof evt.overall.receivedBytes === 'number', 'overall.receivedBytes should be a number');
  assert.ok(typeof evt.overall.totalBytes === 'number', 'overall.totalBytes should be a number');
  assert.ok(typeof evt.overall.speedBps === 'number', 'overall.speedBps should be a number');
  assert.ok(Array.isArray(evt.chunks), 'chunks should be an array');
});

test('6. pause() transitions to paused, emits status', async () => {
  // Use a slow server so we have time to pause mid-download
  requestHandler = (req, res) => {
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
        // Drip bytes slowly
        let sent = 0;
        const interval = setInterval(() => {
          if (sent >= slice.length) { clearInterval(interval); res.end(); return; }
          res.write(slice.slice(sent, sent + 1));
          sent++;
        }, 5);
        req.on('close', () => clearInterval(interval));
        return;
      }
    }
    defaultHandler(req, res);
  };

  const job = makeJob();
  const statusEvents = [];
  job.on('status', (e) => statusEvents.push(e));

  job.enqueue();
  const startPromise = job.start(TEST_OPTIONS);

  // Let it start, then pause
  await new Promise((r) => setTimeout(r, 30));
  job.pause();

  // start() promise should resolve (not reject) after pause
  await startPromise;

  assert.equal(job.status, 'paused');
  const statuses = statusEvents.map((e) => e.status);
  assert.ok(statuses.includes('paused'), 'should have emitted paused');
});

test('7. resume() after pause completes the download', async () => {
  // Use a slow server so we have time to pause before completion
  requestHandler = (req, res) => {
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
        // Drip bytes slowly
        let sent = 0;
        const interval = setInterval(() => {
          if (sent >= slice.length) { clearInterval(interval); res.end(); return; }
          res.write(slice.slice(sent, sent + 1));
          sent++;
        }, 5);
        req.on('close', () => clearInterval(interval));
        return;
      }
    }
    defaultHandler(req, res);
  };

  const job = makeJob();

  job.enqueue();
  const firstPromise = job.start(TEST_OPTIONS);

  // Pause mid-download
  await new Promise((r) => setTimeout(r, 30));
  job.pause();
  await firstPromise;

  assert.equal(job.status, 'paused');

  // Resume — this should restart and complete
  // For the resume, use the fast default handler
  requestHandler = null;

  await job.resume(TEST_OPTIONS);

  assert.equal(job.status, 'completed');
  assert.ok(fs.existsSync(job.dest), 'file should exist after resume');
});

test('8. cancel() from queued sets status to cancelled', () => {
  const job = makeJob();
  const statusEvents = [];
  job.on('status', (e) => statusEvents.push(e));

  job.enqueue();
  assert.equal(job.status, 'queued');

  job.cancel();

  assert.equal(job.status, 'cancelled');
  const statuses = statusEvents.map((e) => e.status);
  assert.ok(statuses.includes('cancelled'), 'should have emitted cancelled');
});

test('9. cancel() from downloading stops download, sets cancelled', async () => {
  // Slow server so we can cancel during download
  requestHandler = (req, res) => {
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
        }, 5);
        req.on('close', () => clearInterval(interval));
        return;
      }
    }
    defaultHandler(req, res);
  };

  const job = makeJob();
  const statusEvents = [];
  job.on('status', (e) => statusEvents.push(e));

  job.enqueue();
  const startPromise = job.start(TEST_OPTIONS);

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(job.status, 'downloading');

  job.cancel();

  await startPromise;

  assert.equal(job.status, 'cancelled');
  const statuses = statusEvents.map((e) => e.status);
  assert.ok(statuses.includes('cancelled'), 'should have emitted cancelled');
});

test('10. On download error (server returns 500), status is error, job.error is set', async () => {
  const job = new DownloadJob({
    url: `http://127.0.0.1:${port}/error500`,
    dest: destPath(`dl-error-${uniqueId()}.bin`),
    id: uniqueId(),
  });

  const statusEvents = [];
  job.on('status', (e) => statusEvents.push(e));

  job.enqueue();
  await job.start(TEST_OPTIONS);

  assert.equal(job.status, 'error');
  assert.ok(job.error instanceof Error, 'job.error should be an Error');

  const statuses = statusEvents.map((e) => e.status);
  assert.ok(statuses.includes('error'), 'should have emitted error status');
  // The emitted status event should carry the error
  const errorEvent = statusEvents.find((e) => e.status === 'error');
  assert.ok(errorEvent, 'should find error status event');
  assert.ok(errorEvent.error instanceof Error, 'status event should carry the error');
});
