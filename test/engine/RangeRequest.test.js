'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const RangeRequest = require('../../src/engine/RangeRequest');

// ─── Shared test data ────────────────────────────────────────────────────────

// 1000 bytes of deterministic content (0x00..0xFF repeating)
const FILE_BODY = Buffer.alloc(1000);
for (let i = 0; i < FILE_BODY.length; i++) FILE_BODY[i] = i % 256;

let server;
let port;
let tmpDir;

// Track per-request behaviour so individual tests can override it
let requestHandler = null; // If set, server calls this instead of default

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdm-range-test-'));

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
});

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
    });
    res.end(FILE_BODY);
  } else if (req.url === '/redirect') {
    res.writeHead(302, { Location: `http://127.0.0.1:${port}/file` });
    res.end();
  } else if (req.url === '/notfound') {
    res.writeHead(404);
    res.end('not found');
  } else {
    res.writeHead(404);
    res.end();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function destPath(name) {
  return path.join(tmpDir, name);
}

function makeReq(overrides = {}) {
  return new RangeRequest({
    url: `http://127.0.0.1:${port}/file`,
    from: 0,
    to: 99,
    dest: destPath(`chunk-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`),
    id: 'job-1',
    chunkIndex: 0,
    _retryDelays: [10, 20, 40],
    ...overrides,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('downloads correct byte range — file content matches expected bytes', async () => {
  const from = 10;
  const to = 49;
  const dest = destPath('range-content.tmp');

  const req = makeReq({ from, to, dest });
  await req.start();

  const written = fs.readFileSync(dest);
  const expected = FILE_BODY.slice(from, to + 1);
  assert.deepEqual(written, expected);
});

test('bytesReceived equals to - from + 1 after completion', async () => {
  const from = 0;
  const to = 99;
  const req = makeReq({ from, to });
  await req.start();
  assert.equal(req.bytesReceived, to - from + 1);
});

test('emits progress events during download', async () => {
  const progressEvents = [];
  const req = makeReq({ from: 0, to: 199 });
  req.on('progress', (e) => progressEvents.push(e));
  await req.start();

  assert.ok(progressEvents.length > 0, 'should emit at least one progress event');
  const last = progressEvents[progressEvents.length - 1];
  assert.equal(last.chunkIndex, 0);
  assert.equal(last.totalBytes, 200);
  assert.ok(last.bytesReceived > 0);
});

test('emits done event on success with correct { chunkIndex, dest }', async () => {
  const dest = destPath('done-event.tmp');
  const doneEvents = [];

  const req = makeReq({ chunkIndex: 3, dest });
  req.on('done', (e) => doneEvents.push(e));
  await req.start();

  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].chunkIndex, 3);
  assert.equal(doneEvents[0].dest, dest);
});

test('creates dest directory if it does not exist', async () => {
  const subDir = path.join(tmpDir, 'auto-create-dir', 'nested');
  const dest = path.join(subDir, 'chunk.tmp');

  assert.ok(!fs.existsSync(subDir), 'dir should not exist before download');

  const req = makeReq({ dest });
  await req.start();

  assert.ok(fs.existsSync(subDir), 'directory should have been created');
  assert.ok(fs.existsSync(dest), 'file should exist');
});

test('retries on network error — succeeds on 2nd attempt', async () => {
  let callCount = 0;

  requestHandler = (req, res) => {
    callCount++;
    if (callCount === 1) {
      // Close connection abruptly before sending a response
      req.socket.destroy();
      return;
    }
    // 2nd call: serve normally
    defaultHandler(req, res);
  };

  try {
    const req = makeReq({ _retryDelays: [10, 20, 40] });
    await req.start(); // should succeed on 2nd attempt
    assert.equal(callCount, 2, 'should have been called exactly twice');
  } finally {
    requestHandler = null;
  }
});

test('fails after 3 retries — emits error event', async () => {
  // Always destroy the socket
  requestHandler = (req, _res) => {
    req.socket.destroy();
  };

  try {
    const errorEvents = [];
    const req = makeReq({ _retryDelays: [10, 20, 40] });
    req.on('error', (e) => errorEvents.push(e));

    await assert.rejects(() => req.start());
    assert.ok(errorEvents.length >= 1, 'should emit at least one error event');
  } finally {
    requestHandler = null;
  }
});

test('does not retry on HTTP 404 — emits error immediately', async () => {
  let callCount = 0;

  requestHandler = (req, res) => {
    callCount++;
    res.writeHead(404);
    res.end('nope');
  };

  try {
    const errorEvents = [];
    const req = makeReq({
      url: `http://127.0.0.1:${port}/notfound`,
      _retryDelays: [10, 20, 40],
    });
    req.on('error', (e) => errorEvents.push(e));

    await assert.rejects(() => req.start(), /HTTP 404/);

    // Should have been called exactly once — no retries on HTTP errors
    assert.equal(callCount, 1, 'server should only be hit once for HTTP 404');
    assert.equal(errorEvents.length, 1);
  } finally {
    requestHandler = null;
  }
});

test('cancel() aborts download — promise rejects', async () => {
  // Use a slow response: send headers then stream body 1 byte at a time
  requestHandler = (req, res) => {
    const from = 0;
    const to = 999;
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${from}-${to}/${FILE_BODY.length}`,
      'Content-Length': to - from + 1,
    });
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= FILE_BODY.length) {
        clearInterval(interval);
        res.end();
        return;
      }
      res.write(FILE_BODY.slice(sent, sent + 1));
      sent++;
    }, 10);
    req.on('close', () => clearInterval(interval));
  };

  try {
    const req = makeReq({ from: 0, to: 999, _retryDelays: [10, 20, 40] });

    // Cancel shortly after starting
    const startPromise = req.start();
    // Give it a moment to connect and start receiving, then cancel
    await new Promise((r) => setTimeout(r, 30));
    req.cancel();

    await assert.rejects(() => startPromise, /Cancelled/);
  } finally {
    requestHandler = null;
  }
});

test('follows 302 redirect', async () => {
  const from = 0;
  const to = 9;
  const dest = destPath('redirect-chunk.tmp');

  const req = new RangeRequest({
    url: `http://127.0.0.1:${port}/redirect`,
    from,
    to,
    dest,
    id: 'job-redir',
    chunkIndex: 0,
    _retryDelays: [10, 20, 40],
  });

  await req.start();

  const written = fs.readFileSync(dest);
  const expected = FILE_BODY.slice(from, to + 1);
  assert.deepEqual(written, expected);
});
