const { test } = require('node:test');
const assert = require('node:assert/strict');
const { filenameFromResponse, formatBytes, renderBar, parseArgs } = require('../src/util');

test('parseArgs: url only', () => {
  const args = parseArgs(['https://example.com/a.mp3']);
  assert.equal(args.url, 'https://example.com/a.mp3');
  assert.equal(args.output, null);
  assert.equal(args.quiet, false);
});

test('parseArgs: -o with path', () => {
  const args = parseArgs(['https://x.com/f', '-o', './out.mp3']);
  assert.equal(args.output, './out.mp3');
});

test('parseArgs: --output long form', () => {
  const args = parseArgs(['https://x.com/f', '--output', '/tmp/']);
  assert.equal(args.output, '/tmp/');
});

test('parseArgs: -q sets quiet', () => {
  const args = parseArgs(['https://x.com/f', '-q']);
  assert.equal(args.quiet, true);
});

test('parseArgs: -h sets help', () => {
  const args = parseArgs(['-h']);
  assert.equal(args.help, true);
});

test('parseArgs: order independent', () => {
  const args = parseArgs(['-q', '-o', 'x.zip', 'https://x.com/f']);
  assert.equal(args.url, 'https://x.com/f');
  assert.equal(args.output, 'x.zip');
  assert.equal(args.quiet, true);
});

test('parseArgs: empty argv', () => {
  const args = parseArgs([]);
  assert.equal(args.url, null);
  assert.equal(args.help, false);
});

test('formatBytes: bytes', () => {
  assert.equal(formatBytes(0), '0B');
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(1023), '1023B');
});

test('formatBytes: KB', () => {
  assert.equal(formatBytes(1024), '1.0KB');
  assert.equal(formatBytes(1536), '1.5KB');
});

test('formatBytes: MB', () => {
  assert.equal(formatBytes(1024 ** 2), '1.0MB');
  assert.equal(formatBytes(5 * 1024 ** 2), '5.0MB');
});

test('formatBytes: GB', () => {
  assert.equal(formatBytes(1024 ** 3), '1.00GB');
  assert.equal(formatBytes(2.5 * 1024 ** 3), '2.50GB');
});

test('renderBar: 0%', () => {
  const bar = renderBar(0, 10);
  assert.equal(bar, '[          ]');
});

test('renderBar: 50%', () => {
  const bar = renderBar(50, 10);
  assert.equal(bar, '[=====     ]');
});

test('renderBar: 100%', () => {
  const bar = renderBar(100, 10);
  assert.equal(bar, '[==========]');
});

test('renderBar: default width 30', () => {
  const bar = renderBar(100);
  assert.equal(bar.length, 32); // 30 + brackets
});

test('filenameFromResponse: from URL path', () => {
  const res = { headers: {} };
  const url = new URL('https://example.com/files/song.mp3');
  assert.equal(filenameFromResponse(res, url, 'fb'), 'song.mp3');
});

test('filenameFromResponse: Content-Disposition wins', () => {
  const res = { headers: { 'content-disposition': 'attachment; filename="real.mp3"' } };
  const url = new URL('https://example.com/dl?id=1');
  assert.equal(filenameFromResponse(res, url, 'fb'), 'real.mp3');
});

test('filenameFromResponse: Content-Disposition unquoted', () => {
  const res = { headers: { 'content-disposition': 'attachment; filename=plain.zip' } };
  const url = new URL('https://example.com/x');
  assert.equal(filenameFromResponse(res, url, 'fb'), 'plain.zip');
});

test('filenameFromResponse: RFC 5987 UTF-8', () => {
  const res = { headers: { 'content-disposition': "attachment; filename*=UTF-8''hello%20world.mp3" } };
  const url = new URL('https://example.com/x');
  assert.equal(filenameFromResponse(res, url, 'fb'), 'hello world.mp3');
});

test('filenameFromResponse: fallback when no name', () => {
  const res = { headers: {} };
  const url = new URL('https://example.com/');
  assert.equal(filenameFromResponse(res, url, 'fallback_id'), 'fallback_id');
});
