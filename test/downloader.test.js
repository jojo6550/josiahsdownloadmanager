const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const downloader = require('../src/downloader');

let server;
let port;
let tmpDir;

const FILE_BODY = Buffer.from('hello world this is test data'.repeat(100));

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdm-test-'));

  server = http.createServer((req, res) => {
    if (req.url === '/file.bin') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': FILE_BODY.length,
      });
      res.end(FILE_BODY);
    } else if (req.url === '/with-disposition') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': FILE_BODY.length,
        'content-disposition': 'attachment; filename="custom.bin"',
      });
      res.end(FILE_BODY);
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: '/file.bin' });
      res.end();
    } else if (req.url === '/notfound') {
      res.writeHead(404);
      res.end('nope');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function downloadAndWait(url, id, options) {
  return new Promise((resolve, reject) => {
    const onStatus = (s) => {
      if (s.id !== id) return;
      if (s.status === 'completed') {
        downloader.off('status', onStatus);
        resolve(s);
      } else if (s.status === 'error') {
        downloader.off('status', onStatus);
        reject(new Error(s.error));
      }
    };
    downloader.on('status', onStatus);
    downloader.startDownload(url, id, options);
  });
}

test('downloads file to custom directory', async () => {
  const id = 'test_dir_' + Date.now();
  const result = await downloadAndWait(
    `http://127.0.0.1:${port}/file.bin`,
    id,
    { outputPath: tmpDir + path.sep }
  );
  assert.equal(result.filename, 'file.bin');
  const saved = fs.readFileSync(result.dest);
  assert.equal(saved.length, FILE_BODY.length);
  assert.deepEqual(saved, FILE_BODY);
});

test('downloads to specific filename', async () => {
  const id = 'test_file_' + Date.now();
  const dest = path.join(tmpDir, 'renamed.bin');
  const result = await downloadAndWait(
    `http://127.0.0.1:${port}/file.bin`,
    id,
    { outputPath: dest }
  );
  assert.equal(result.dest, dest);
  assert.equal(result.filename, 'renamed.bin');
  assert.ok(fs.existsSync(dest));
});

test('respects Content-Disposition filename', async () => {
  const id = 'test_cd_' + Date.now();
  const result = await downloadAndWait(
    `http://127.0.0.1:${port}/with-disposition`,
    id,
    { outputPath: tmpDir + path.sep }
  );
  assert.equal(result.filename, 'custom.bin');
});

test('follows 302 redirect', async () => {
  const id = 'test_redir_' + Date.now();
  const result = await downloadAndWait(
    `http://127.0.0.1:${port}/redirect`,
    id,
    { outputPath: tmpDir + path.sep }
  );
  assert.equal(result.filename, 'file.bin');
  const saved = fs.readFileSync(result.dest);
  assert.equal(saved.length, FILE_BODY.length);
});

test('emits error on 404', async () => {
  const id = 'test_404_' + Date.now();
  await assert.rejects(
    downloadAndWait(`http://127.0.0.1:${port}/notfound`, id, { outputPath: tmpDir + path.sep }),
    /HTTP 404/
  );
});

test('emits progress events', async () => {
  const id = 'test_progress_' + Date.now();
  const progressEvents = [];

  const onProgress = (p) => {
    if (p.id === id) progressEvents.push(p);
  };
  downloader.on('progress', onProgress);

  await downloadAndWait(
    `http://127.0.0.1:${port}/file.bin`,
    id,
    { outputPath: tmpDir + path.sep }
  );

  downloader.off('progress', onProgress);

  assert.ok(progressEvents.length > 0, 'should emit at least one progress event');
  const last = progressEvents[progressEvents.length - 1];
  assert.equal(last.received, FILE_BODY.length);
  assert.equal(last.total, FILE_BODY.length);
  assert.equal(last.percent, 100);
});

test('emits error on connection refused', async () => {
  const id = 'test_refused_' + Date.now();
  // port 1 should be unbindable/unreachable
  await assert.rejects(
    downloadAndWait('http://127.0.0.1:1/nope', id, { outputPath: tmpDir + path.sep })
  );
});
