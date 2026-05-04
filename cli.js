#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os   = require('node:os');
const fs   = require('node:fs');

const { parseArgs, formatBytes, renderBar } = require('./src/util');

// ─── Help ──────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`Usage: jdm <url> [options]

Options:
  -o, --output <path>      Output file or directory  (default: ~/Downloads/JDM/)
  -c, --chunks <n>         Parallel chunks per file  (default: 8, max: 32)
  -C, --concurrency <n>    Simultaneous downloads    (default: 1, max: 16)
  -f, --format <id>        yt-dlp format string (skips picker, e.g. "bestvideo+bestaudio")
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

// ─── yt-dlp mode ───────────────────────────────────────────────────────────

async function pickFormat(formats, quiet) {
  const videoFmts = (() => {
    const seen = new Set();
    return formats.filter((f) => {
      if (f.vcodec === 'none') return false;
      const key = `${f.resolution}|${f.ext}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();

  if (videoFmts.length === 0 || quiet || !process.stdin.isTTY) {
    return 'bestvideo+bestaudio/best';
  }

  console.log('\nAvailable formats:');
  console.log('  0) Best (auto)');
  videoFmts.forEach((f, i) => {
    const size = f.filesize ? ` [${formatBytes(f.filesize)}]` : '';
    console.log(`  ${i + 1}) ${f.resolution} · ${f.ext.toUpperCase()}${f.note ? ` · ${f.note}` : ''}${size}`);
  });

  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question('\nSelect [0]: ', (answer) => {
      rl.close();
      const n = parseInt(answer.trim(), 10);
      if (!n || n < 1 || n > videoFmts.length) return resolve('bestvideo+bestaudio/best');
      resolve(`${videoFmts[n - 1].id}+bestaudio/best`);
    });
  });
}

async function runYtDlp(args) {
  const ytDlp = require('./src/scraper/ytDlp');
  const DownloadQueue = require('./src/engine/DownloadQueue');

  if (!process.env.JDM_DOWNLOAD_DIR) {
    process.env.JDM_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'JDM');
  }

  const dir  = args.output || process.env.JDM_DOWNLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, '%(title)s.%(ext)s');

  let formatId = args.format;
  if (!formatId) {
    const formats = args._probedFormats || (() => {
      if (!args.quiet) process.stderr.write('Fetching available formats…\n');
      return ytDlp.probe(args.url);
    })();
    formatId = await pickFormat(await Promise.resolve(formats), args.quiet);
  }

  if (!args.quiet) process.stderr.write(`\nStarting download (format: ${formatId})\n`);

  const queue = new DownloadQueue({ maxConcurrent: 1 });

  let lastReceived = 0;
  let lastTime     = Date.now();
  let speed        = 0;
  let finalDest    = dest;

  if (!args.quiet) {
    queue.on('job:progress', ({ overall }) => {
      const { percent = 0, receivedBytes: received = 0, totalBytes: total = 0, speedBps } = overall;
      speed = speedBps || speed;
      const now = Date.now(); lastTime = now; lastReceived = received;
      const pct     = Math.round(percent);
      const sizeStr = total ? `${formatBytes(received)}/${formatBytes(total)}` : formatBytes(received);
      const etaSec  = overall.etaSecs !== null ? overall.etaSecs : null;
      process.stdout.write(
        `\r${renderBar(pct)} ${pct}% | ${formatBytes(speed)}/s | ${etaSec !== null ? `ETA ${etaSec}s` : 'ETA --'} | ${sizeStr}    `
      );
    });
  }

  await new Promise((resolve, reject) => {
    queue.on('job:status', ({ status, error, job }) => {
      if (status === 'completed') {
        if (job) finalDest = job.dest || finalDest;
        if (!args.quiet) {
          process.stdout.write(`\r${renderBar(100)} 100%${' '.repeat(40)}\n`);
          console.log(`Saved: ${finalDest}`);
        }
        resolve();
      } else if (status === 'error') {
        reject(new Error((error && error.message) || error || 'unknown error'));
      }
    });

    queue.addYtDlp(args.url, formatId, dest);
  });
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
    // Probe with yt-dlp first; fall back to direct download
    const ytDlp = require('./src/scraper/ytDlp');
    let useYtDlp = !!args.format; // -f flag forces yt-dlp

    if (!useYtDlp) {
      try {
        const formats = await ytDlp.probe(args.url);
        if (formats.length > 0) useYtDlp = true;
        // Re-use probe result — attach to args so runYtDlp can skip re-probe
        args._probedFormats = formats;
      } catch {
        // Not a yt-dlp URL — direct download
      }
    }

    if (useYtDlp) {
      await runYtDlp(args);
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
