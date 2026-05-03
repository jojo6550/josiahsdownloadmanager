'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Helper: create a unique temp dir for each test
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jdm-logger-test-'));
}

// Helper: get a fresh logger instance by clearing the module cache
function freshLogger(tmpDir) {
  process.env.JDM_DOWNLOAD_DIR = tmpDir;
  // Clear cache so we get a fresh singleton
  const key = require.resolve('../src/logger/Logger');
  delete require.cache[key];
  return require('../src/logger/Logger');
}

// Cleanup temp dirs after each test
const dirsToClean = [];
beforeEach(() => {
  // Clean up from prior test
  for (const d of dirsToClean.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('logger.info() writes a JSON line to the log file', () => {
  const tmpDir = makeTempDir();
  dirsToClean.push(tmpDir);
  const logger = freshLogger(tmpDir);

  logger.info('hello world');

  const logPath = path.join(tmpDir, 'jdm.log');
  assert.ok(fs.existsSync(logPath), 'log file should exist');
  const content = fs.readFileSync(logPath, 'utf8');
  const entry = JSON.parse(content.trim());
  assert.equal(entry.level, 'INFO');
  assert.equal(entry.msg, 'hello world');
  assert.ok(typeof entry.ts === 'string', 'ts should be a string');
  assert.ok(entry.meta !== undefined, 'meta should be present');
});

test('debug/warn/error convenience methods write correct level', () => {
  const tmpDir = makeTempDir();
  dirsToClean.push(tmpDir);
  const logger = freshLogger(tmpDir);

  logger.debug('d');
  logger.warn('w');
  logger.error('e');

  const logPath = path.join(tmpDir, 'jdm.log');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);

  const entries = lines.map(l => JSON.parse(l));
  assert.equal(entries[0].level, 'DEBUG');
  assert.equal(entries[1].level, 'WARN');
  assert.equal(entries[2].level, 'ERROR');
});

test('getEntries() returns entries newest first', () => {
  const tmpDir = makeTempDir();
  dirsToClean.push(tmpDir);
  const logger = freshLogger(tmpDir);

  logger.info('first');
  logger.info('second');
  logger.info('third');

  const entries = logger.getEntries();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].msg, 'third');
  assert.equal(entries[1].msg, 'second');
  assert.equal(entries[2].msg, 'first');
});

test('getEntries(limit) respects limit', () => {
  const tmpDir = makeTempDir();
  dirsToClean.push(tmpDir);
  const logger = freshLogger(tmpDir);

  for (let i = 0; i < 10; i++) {
    logger.info(`msg ${i}`);
  }

  const entries = logger.getEntries(3);
  assert.equal(entries.length, 3);
  // Newest first, so last 3 written
  assert.equal(entries[0].msg, 'msg 9');
  assert.equal(entries[1].msg, 'msg 8');
  assert.equal(entries[2].msg, 'msg 7');
});

test('getEntries(limit, levelFilter) filters by level', () => {
  const tmpDir = makeTempDir();
  dirsToClean.push(tmpDir);
  const logger = freshLogger(tmpDir);

  logger.debug('d1');
  logger.info('i1');
  logger.warn('w1');
  logger.error('e1');
  logger.info('i2');

  const infoEntries = logger.getEntries(100, 'INFO');
  assert.equal(infoEntries.length, 2);
  assert.ok(infoEntries.every(e => e.level === 'INFO'));

  const warnEntries = logger.getEntries(100, 'WARN');
  assert.equal(warnEntries.length, 1);
  assert.equal(warnEntries[0].msg, 'w1');
});

test('setLevel("WARN") drops DEBUG and INFO entries', () => {
  const tmpDir = makeTempDir();
  dirsToClean.push(tmpDir);
  const logger = freshLogger(tmpDir);

  logger.setLevel('WARN');
  logger.debug('should be dropped');
  logger.info('also dropped');
  logger.warn('keep this');
  logger.error('keep this too');

  const logPath = path.join(tmpDir, 'jdm.log');
  assert.ok(fs.existsSync(logPath), 'log file should exist');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const entries = lines.map(l => JSON.parse(l));
  assert.equal(entries[0].level, 'WARN');
  assert.equal(entries[1].level, 'ERROR');
});

test('"entry" event is emitted on each log call with correct shape', () => {
  const tmpDir = makeTempDir();
  dirsToClean.push(tmpDir);
  const logger = freshLogger(tmpDir);

  const events = [];
  logger.on('entry', (e) => events.push(e));

  logger.info('evt test', { foo: 'bar' });
  logger.warn('second');

  assert.equal(events.length, 2);
  assert.equal(events[0].level, 'INFO');
  assert.equal(events[0].msg, 'evt test');
  assert.deepEqual(events[0].meta, { foo: 'bar' });
  assert.ok(typeof events[0].ts === 'string');
  assert.equal(events[1].level, 'WARN');
  assert.equal(events[1].msg, 'second');
});

test('file rotation triggers when file exceeds 5MB', () => {
  const tmpDir = makeTempDir();
  dirsToClean.push(tmpDir);
  const logger = freshLogger(tmpDir);

  // Write enough to exceed 5MB (each entry ~100 bytes, need ~50000+ entries)
  // Instead, pre-create a file near the limit and write one more entry
  const logPath = path.join(tmpDir, 'jdm.log');
  // Write 5MB of fake log content to the file directly
  const fakeEntry = JSON.stringify({ level: 'INFO', ts: new Date().toISOString(), msg: 'x'.repeat(80), meta: {} }) + '\n';
  const needed = Math.ceil((5 * 1024 * 1024) / fakeEntry.length) + 1;
  const bigContent = fakeEntry.repeat(needed);
  fs.writeFileSync(logPath, bigContent, 'utf8');

  // Now write one more entry — this should trigger rotation
  logger.info('trigger rotation');

  const rotatedPath = path.join(tmpDir, 'jdm.log.1');
  assert.ok(fs.existsSync(rotatedPath), 'jdm.log.1 should exist after rotation');
  // New jdm.log should only have the new entry
  const newContent = fs.readFileSync(logPath, 'utf8').trim();
  const newEntry = JSON.parse(newContent);
  assert.equal(newEntry.msg, 'trigger rotation');
});

test('getEntries() works after rotation (reads current jdm.log)', () => {
  const tmpDir = makeTempDir();
  dirsToClean.push(tmpDir);
  const logger = freshLogger(tmpDir);

  const logPath = path.join(tmpDir, 'jdm.log');
  // Force rotation by pre-filling to over 5MB
  const fakeEntry = JSON.stringify({ level: 'INFO', ts: new Date().toISOString(), msg: 'x'.repeat(80), meta: {} }) + '\n';
  const needed = Math.ceil((5 * 1024 * 1024) / fakeEntry.length) + 1;
  fs.writeFileSync(logPath, fakeEntry.repeat(needed), 'utf8');

  // This triggers rotation and writes a new entry to jdm.log
  logger.info('post-rotation entry');

  const entries = logger.getEntries();
  assert.ok(entries.length >= 1, 'should have at least one entry');
  assert.equal(entries[0].msg, 'post-rotation entry');
});

test('missing log directory is created automatically', () => {
  // Use a path that does not yet exist
  const baseDir = os.tmpdir();
  const subDir = path.join(baseDir, `jdm-autocreate-${Date.now()}`);
  dirsToClean.push(subDir);

  assert.ok(!fs.existsSync(subDir), 'dir should not exist yet');

  const logger = freshLogger(subDir);
  logger.info('auto create test');

  assert.ok(fs.existsSync(subDir), 'directory should have been created');
  const logPath = path.join(subDir, 'jdm.log');
  assert.ok(fs.existsSync(logPath), 'log file should exist in auto-created dir');
});
