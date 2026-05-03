#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const DownloadQueue = require('./src/engine/DownloadQueue');
const { parseArgs, formatBytes, renderBar } = require('./src/util');

function printHelp() {
  console.log(`Usage: node cli.js <url> [options]

Options:
  -o, --output <path>   Output file or directory (default: ~/Downloads/JDM/)
  -q, --quiet           Suppress progress bar
  -h, --help            Show help

Examples:
  node cli.js https://example.com/song.mp3
  node cli.js https://example.com/video.mp4 -o ~/Videos/
  node cli.js https://example.com/file.zip -o ./myfile.zip
`);
}

function resolveDest(url, outputArg) {
  const urlBasename = path.basename(new URL(url).pathname) || `download-${Date.now()}`;

  if (!outputArg) {
    const dir = process.env.JDM_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'JDM');
    return path.join(dir, urlBasename);
  }

  // If output ends with separator or is an existing directory — use it as a dir
  if (outputArg.endsWith('/') || outputArg.endsWith(path.sep) || fs.existsSync(outputArg) && fs.statSync(outputArg).isDirectory()) {
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

  // Set download dir so Logger can initialise
  if (!process.env.JDM_DOWNLOAD_DIR) {
    process.env.JDM_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'JDM');
  }

  const dest = resolveDest(args.url, args.output);

  // Ensure destination directory exists
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const queue = new DownloadQueue({ maxConcurrent: 1 });

  const startedAt = Date.now();
  let lastReceived = 0;
  let lastTime = startedAt;
  let speed = 0;

  if (!args.quiet) {
    queue.on('job:progress', ({ percent, received, total }) => {
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
        ? `${formatBytes(received)}/${formatBytes(total)} MB`
        : formatBytes(received);

      const etaSec = speed > 0 && total ? Math.round((total - received) / speed) : null;
      const etaStr = etaSec !== null ? `ETA ${etaSec}s` : 'ETA --';

      process.stdout.write(
        `\r${renderBar(pct)} ${pct}% | ${speedStr} | ${etaStr} | ${sizeStr}    `
      );
    });
  }

  queue.on('job:status', ({ status, error }) => {
    if (status === 'completed') {
      if (!args.quiet) {
        process.stdout.write(`\r${renderBar(100)} 100%${' '.repeat(40)}\n`);
        console.log(`Saved: ${dest}`);
      }
      process.exit(0);
    } else if (status === 'error') {
      process.stderr.write(`\nError: ${error || 'unknown error'}\n`);
      process.exit(1);
    }
  });

  queue.add(args.url, dest);
}

main();
