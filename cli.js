#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const DownloadQueue = require('./src/engine/DownloadQueue');
const { parseArgs, formatBytes, renderBar } = require('./src/util');

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

function resolveDest(url, outputArg) {
  const parsed = new URL(url);
  const urlBasename = path.basename(parsed.pathname) || parsed.hostname || `download-${Date.now()}`;

  if (!outputArg) {
    const dir = process.env.JDM_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'JDM');
    return path.join(dir, urlBasename);
  }

  // If output ends with separator or is an existing directory — treat as dir
  if (outputArg.endsWith('/') || outputArg.endsWith(path.sep) || (fs.existsSync(outputArg) && fs.statSync(outputArg).isDirectory())) {
    return path.join(outputArg, urlBasename);
  }

  // Otherwise treat as a full file path
  return outputArg;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.url) {
    printHelp();
    process.exit(args.url ? 0 : 1);
  }

  if (!process.env.JDM_DOWNLOAD_DIR) {
    process.env.JDM_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'JDM');
  }

  const dest = resolveDest(args.url, args.output);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const queue = new DownloadQueue({ maxConcurrent: args.concurrency || 1 });

  let lastReceived = 0;
  let lastTime = Date.now();
  let speed = 0;
  let finalDest = dest;

  if (!args.quiet) {
    queue.on('job:progress', ({ overall }) => {
      const { percent, receivedBytes: received, totalBytes: total } = overall;
      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      if (dt >= 0.25) {
        speed = (received - lastReceived) / dt;
        lastReceived = received;
        lastTime = now;
      }

      const pct = Math.round(percent || 0);
      const speedStr = `${formatBytes(speed)}/s`;
      const sizeStr = total
        ? `${formatBytes(received)}/${formatBytes(total)}`
        : formatBytes(received);
      const etaSec = speed > 0 && total ? Math.round((total - received) / speed) : null;
      const etaStr = etaSec !== null ? `ETA ${etaSec}s` : 'ETA --';

      process.stdout.write(`\r${renderBar(pct)} ${pct}% | ${speedStr} | ${etaStr} | ${sizeStr}    `);
    });
  }

  queue.on('job:status', ({ status, error, job }) => {
    if (status === 'completed') {
      if (job) finalDest = job.dest;
      if (!args.quiet) {
        process.stdout.write(`\r${renderBar(100)} 100%${' '.repeat(40)}\n`);
        console.log(`Saved: ${finalDest}`);
      }
      process.exit(0);
    } else if (status === 'error') {
      process.stderr.write(`\nError: ${(error && error.message) || error || 'unknown error'}\n`);
      process.exit(1);
    }
  });

  queue.add(args.url, dest, { chunkCount: args.chunks });
}

main();
