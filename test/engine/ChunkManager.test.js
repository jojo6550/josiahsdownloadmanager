'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Set JDM_DOWNLOAD_DIR before requiring Logger (it's a singleton)
const logTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdm-cm-log-'));
process.env.JDM_DOWNLOAD_DIR = logTmpDir;

const ChunkManager = require('../../src/engine/ChunkManager');

// ─── Shared test data ────────────────────────────────────────────────────────

// 2000 bytes of deterministic content (0x00..0xFF repeating)
const FILE_BODY = Buffer.alloc(2000);
for (let i = 0; i < FILE_BODY.length; i++) FILE_BODY[i] = i % 256;

let server;
let port;
let tmpDir;

// Mutable handler so tests can override
let requestHandler = null;

// ─── Default HTTP handler ────────────────────────────────────────────────────

function defaultHandler(req, res) {
  if (req.url === '/file') {
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
        res.end(slice);
        return;
      }
    }
    // No range header — return full file
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': FILE_BODY.length,
      'Accept-Ranges': 'bytes',
    });
    res.end(FILE_BODY);
  } else if (req.url === '/no-accept-ranges') {
    // Server does NOT advertise Accept-Ranges — single-stream fallback
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': FILE_BODY.length,
      // No Accept-Ranges header
    });
    res.end(FILE_BODY);
  } else if (req.url === '/no-content-length') {
    // Server does NOT advertise Content-Length — single-stream fallback
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      // No Content-Length header
    });
    res.end(FILE_BODY);
  } else if (req.url === '/error500') {
    res.writeHead(500);
    res.end('internal server error');
  } else {
    res.writeHead(404);
    res.end();
  }
}

// ─── HEAD handler that forwards to correct endpoint ─────────────────────────
// Note: the default handler handles HEAD for all endpoints by checking method

function createHandler(req, res) {
  if (requestHandler) {
    requestHandler(req, res);
    return;
  }
  defaultHandler(req, res);
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdm-cm-test-'));

  server = http.createServer(createHandler);
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

function makeCm(overrides = {}) {
  const id = uniqueId();
  return new ChunkManager({
    url: `http://127.0.0.1:${port}/file`,
    dest: destPath(`dl-${id}.bin`),
    id,
    _chunkCount: 2,
    _retryDelays: [10, 20, 40],
    ...overrides,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('chunked mode: downloads correct content, final file matches source', async () => {
  const id = uniqueId();
  const dest = destPath(`test1-${id}.bin`);

  const cm = new ChunkManager({
    url: `http://127.0.0.1:${port}/file`,
    dest,
    id,
    _chunkCount: 2,
    _retryDelays: [10, 20, 40],
  });

  const result = await cm.start();

  assert.ok(fs.existsSync(dest), 'final file should exist');
  const written = fs.readFileSync(dest);
  assert.deepEqual(written, FILE_BODY, 'file content should match source exactly');
  assert.equal(result.dest, dest);
  assert.equal(result.totalBytes, FILE_BODY.length);
});

test('emits progress events with correct shape { totalBytes, receivedBytes, chunks }', async () => {
  const cm = makeCm();
  const progressEvents = [];
  cm.on('progress', (e) => progressEvents.push(e));

  await cm.start();

  assert.ok(progressEvents.length > 0, 'should emit at least one progress event');

  const evt = progressEvents[0];
  assert.ok(typeof evt.totalBytes === 'number', 'totalBytes should be a number');
  assert.ok(typeof evt.receivedBytes === 'number', 'receivedBytes should be a number');
  assert.ok(Array.isArray(evt.chunks), 'chunks should be an array');

  if (evt.chunks.length > 0) {
    const c = evt.chunks[0];
    assert.ok('n' in c, 'chunk should have n');
    assert.ok('percent' in c, 'chunk should have percent');
    assert.ok('speedBps' in c, 'chunk should have speedBps');
  }
});

test("emits 'done' with { dest, totalBytes }", async () => {
  const cm = makeCm();
  const doneEvents = [];
  cm.on('done', (e) => doneEvents.push(e));

  const result = await cm.start();

  assert.equal(doneEvents.length, 1, 'should emit exactly one done event');
  assert.equal(doneEvents[0].dest, result.dest);
  assert.equal(doneEvents[0].totalBytes, FILE_BODY.length);
});

test('temp files are cleaned up after merge', async () => {
  const id = uniqueId();
  const dest = destPath(`cleanup-${id}.bin`);

  const cm = new ChunkManager({
    url: `http://127.0.0.1:${port}/file`,
    dest,
    id,
    _chunkCount: 2,
    _retryDelays: [10, 20, 40],
  });

  await cm.start();

  // tmpDir is path.join(path.dirname(dest), id + '.tmp')
  const expectedTmpDir = path.join(path.dirname(dest), id + '.tmp');
  assert.ok(!fs.existsSync(expectedTmpDir), 'temp directory should be cleaned up after merge');
});

test('single-stream fallback when server returns no Accept-Ranges header', async () => {
  const id = uniqueId();
  const dest = destPath(`fallback-no-ranges-${id}.bin`);

  const cm = new ChunkManager({
    url: `http://127.0.0.1:${port}/no-accept-ranges`,
    dest,
    id,
    _chunkCount: 2,
    _retryDelays: [10, 20, 40],
  });

  const progressEvents = [];
  cm.on('progress', (e) => progressEvents.push(e));

  const result = await cm.start();

  assert.ok(fs.existsSync(dest), 'final file should exist');
  const written = fs.readFileSync(dest);
  assert.deepEqual(written, FILE_BODY, 'file content should match source');

  // Single-stream mode emits empty chunks array
  if (progressEvents.length > 0) {
    assert.deepEqual(progressEvents[0].chunks, [], 'single-stream progress should have empty chunks array');
  }
});

test('single-stream fallback when server returns no Content-Length header', async () => {
  const id = uniqueId();
  const dest = destPath(`fallback-no-cl-${id}.bin`);

  const cm = new ChunkManager({
    url: `http://127.0.0.1:${port}/no-content-length`,
    dest,
    id,
    _chunkCount: 2,
    _retryDelays: [10, 20, 40],
  });

  const result = await cm.start();

  assert.ok(fs.existsSync(dest), 'final file should exist');
  const written = fs.readFileSync(dest);
  assert.deepEqual(written, FILE_BODY, 'file content should match source');
});

test('cancel() stops all chunks, rejects start() promise', async () => {
  // Use a slow server that drips bytes so we have time to cancel
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
        // Drip 1 byte at a time slowly
        let sent = 0;
        const interval = setInterval(() => {
          if (sent >= slice.length) {
            clearInterval(interval);
            res.end();
            return;
          }
          res.write(slice.slice(sent, sent + 1));
          sent++;
        }, 20);
        req.on('close', () => clearInterval(interval));
        return;
      }
    }
    defaultHandler(req, res);
  };

  const cm = makeCm();

  const startPromise = cm.start();

  // Give a moment to connect
  await new Promise((r) => setTimeout(r, 50));
  cm.cancel();

  await assert.rejects(() => startPromise, /Cancelled/);
});

test('start() rejects if all chunks fail (server returns 500)', async () => {
  // Override: HEAD returns 500 → should reject immediately
  requestHandler = (req, res) => {
    res.writeHead(500);
    res.end('error');
  };

  const cm = makeCm();

  await assert.rejects(() => cm.start());
});

test('chunked download: final file has exactly correct bytes (compare to source)', async () => {
  // Use 4 chunks to stress the merge
  const id = uniqueId();
  const dest = destPath(`exact-bytes-${id}.bin`);

  const cm = new ChunkManager({
    url: `http://127.0.0.1:${port}/file`,
    dest,
    id,
    _chunkCount: 4,
    _retryDelays: [10, 20, 40],
  });

  const result = await cm.start();

  assert.ok(fs.existsSync(dest), 'final file should exist');
  const written = fs.readFileSync(dest);

  // Exact byte-for-byte comparison
  assert.equal(written.length, FILE_BODY.length, 'file length should match');
  assert.deepEqual(written, FILE_BODY, 'every byte should match the source');
  assert.equal(result.totalBytes, FILE_BODY.length);
});
