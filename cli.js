#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');
const os   = require('node:os');
const fs   = require('node:fs');

const { parseArgs, formatBytes, renderBar } = require('./src/util');
const DAEMON_PORT = 7821;

// ─── Help ──────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`Usage: jdm <url> [options]

Options:
  -o, --output <path>      Output file or directory  (default: ~/Downloads/JDM/)
  -c, --chunks <n>         Parallel chunks per file  (default: 8, max: 32)
  -C, --concurrency <n>    Simultaneous downloads    (default: 1, max: 16)
  -q, --quiet              Suppress progress output
  -h, --help               Show this help

Examples:
  jdm https://example.com/song.mp3
  jdm https://example.com/video.mp4  -o ~/Videos/
  jdm https://example.com/file.zip   -o ./myfile.zip -c 16
  jdm https://example.com/page       -o ./page.html
`);
}

// ─── Dest resolution ───────────────────────────────────────────────────────

function resolveDest(url, outputArg) {
  const parsed = new URL(url);
  const urlBasename = path.basename(parsed.pathname) || parsed.hostname || `download-${Date.now()}`;

  if (!outputArg) {
    const dir = process.env.JDM_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'JDM');
    return path.join(dir, urlBasename);
  }

  if (outputArg.endsWith('/') || outputArg.endsWith(path.sep) ||
      (fs.existsSync(outputArg) && fs.statSync(outputArg).isDirectory())) {
    return path.join(outputArg, urlBasename);
  }

  return outputArg;
}

// ─── Daemon helpers ────────────────────────────────────────────────────────

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = http.request({
      hostname: '127.0.0.1', port: DAEMON_PORT,
      path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end',  () => {
        try   { resolve(JSON.parse(buf)); }
        catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function daemonRunning() {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port: DAEMON_PORT, path: '/health', timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// SSE stream — resolves when job reaches terminal state
function watchJob(jobId, { quiet }) {
  return new Promise((resolve, reject) => {
    let lastReceived = 0;
    let lastTime     = Date.now();
    let speed        = 0;

    const req = http.get({ hostname: '127.0.0.1', port: DAEMON_PORT, path: '/download/events' }, (res) => {
      let buf = '';

      res.on('data', (chunk) => {
        buf += chunk.toString();
        const blocks = buf.split('\n\n');
        buf = blocks.pop();

        for (const block of blocks) {
          let type = 'message', data = null;
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6).trim();
          }
          if (!data) continue;

          let payload;
          try { payload = JSON.parse(data); } catch { continue; }
          if (payload.id !== jobId) continue;

          if (type === 'progress' && !quiet) {
            const { overall } = payload;
            const received = overall.receivedBytes || 0;
            const total    = overall.totalBytes    || 0;
            const now      = Date.now();
            const dt       = (now - lastTime) / 1000;
            if (dt >= 0.25) {
              speed        = (received - lastReceived) / dt;
              lastReceived = received;
              lastTime     = now;
            }
            const pct     = Math.round(overall.percent || 0);
            const sizeStr = total ? `${formatBytes(received)}/${formatBytes(total)}` : formatBytes(received);
            const etaSec  = speed > 0 && total ? Math.round((total - received) / speed) : null;
            process.stdout.write(
              `\r${renderBar(pct)} ${pct}% | ${formatBytes(speed)}/s | ${etaSec !== null ? `ETA ${etaSec}s` : 'ETA --'} | ${sizeStr}    `
            );
          }

          if (type === 'status') {
            const { status, dest, error } = payload;
            if (status === 'completed') {
              req.destroy();
              if (!quiet) {
                process.stdout.write(`\r${renderBar(100)} 100%${' '.repeat(40)}\n`);
                console.log(`Saved: ${dest}`);
              }
              resolve();
            } else if (status === 'error') {
              req.destroy();
              reject(new Error(error || 'Download failed'));
            } else if (status === 'cancelled') {
              req.destroy();
              reject(new Error('Cancelled'));
            }
          }
        }
      });

      res.on('error', reject);
    });

    req.on('error', reject);
  });
}

// ─── Daemon mode ───────────────────────────────────────────────────────────

async function runViaDaemon(args) {
  const dest = resolveDest(args.url, args.output);
  const { id } = await apiPost('/download/add', { url: args.url, dest });
  if (!args.quiet) console.log(`Queued via GUI daemon → ${path.basename(dest)}`);
  await watchJob(id, { quiet: args.quiet });
}

// ─── Standalone mode ───────────────────────────────────────────────────────

async function runStandalone(args) {
  const DownloadQueue = require('./src/engine/DownloadQueue');

  if (!process.env.JDM_DOWNLOAD_DIR) {
    process.env.JDM_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'JDM');
  }

  const dest = resolveDest(args.url, args.output);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const queue = new DownloadQueue({ maxConcurrent: args.concurrency || 1 });

  let lastReceived = 0;
  let lastTime     = Date.now();
  let speed        = 0;
  let finalDest    = dest;

  if (!args.quiet) {
    queue.on('job:progress', ({ overall }) => {
      const { percent, receivedBytes: received, totalBytes: total } = overall;
      const now = Date.now();
      const dt  = (now - lastTime) / 1000;
      if (dt >= 0.25) {
        speed        = (received - lastReceived) / dt;
        lastReceived = received;
        lastTime     = now;
      }
      const pct     = Math.round(percent || 0);
      const sizeStr = total ? `${formatBytes(received)}/${formatBytes(total)}` : formatBytes(received);
      const etaSec  = speed > 0 && total ? Math.round((total - received) / speed) : null;
      process.stdout.write(
        `\r${renderBar(pct)} ${pct}% | ${formatBytes(speed)}/s | ${etaSec !== null ? `ETA ${etaSec}s` : 'ETA --'} | ${sizeStr}    `
      );
    });
  }

  await new Promise((resolve, reject) => {
    queue.on('job:status', ({ status, error, job }) => {
      if (status === 'completed') {
        if (job) finalDest = job.dest;
        if (!args.quiet) {
          process.stdout.write(`\r${renderBar(100)} 100%${' '.repeat(40)}\n`);
          console.log(`Saved: ${finalDest}`);
        }
        resolve();
      } else if (status === 'error') {
        reject(new Error((error && error.message) || error || 'unknown error'));
      }
    });

    queue.add(args.url, dest, { chunkCount: args.chunks });
  });
}

// ─── Entry point ───────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.url) {
    printHelp();
    process.exit(args.url ? 0 : 1);
  }

  try {
    if (await daemonRunning()) {
      await runViaDaemon(args);
    } else {
      await runStandalone(args);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`\nError: ${err.message}\n`);
    process.exit(1);
  }
}

main();
