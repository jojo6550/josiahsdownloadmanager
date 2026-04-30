#!/usr/bin/env node
const downloader = require('./src/downloader');

function parseArgs(argv) {
  const args = { url: null, output: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') {
      args.output = argv[++i];
    } else if (a === '-q' || a === '--quiet') {
      args.quiet = true;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (!args.url) {
      args.url = a;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node cli.js <url> [options]

Options:
  -o, --output <path>   Output file or directory (default: ./downloads/)
  -q, --quiet           Suppress progress bar
  -h, --help            Show help

Examples:
  node cli.js https://example.com/song.mp3
  node cli.js https://example.com/video.mp4 -o ~/Videos/
  node cli.js https://example.com/file.zip -o ./myfile.zip
`);
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}

function renderBar(percent, width = 30) {
  const filled = Math.round((percent / 100) * width);
  return '[' + '='.repeat(filled) + ' '.repeat(width - filled) + ']';
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.url) {
    printHelp();
    process.exit(args.url ? 0 : 1);
  }

  const id = `cli_${Date.now()}`;
  const startedAt = Date.now();
  let lastReceived = 0;
  let lastTime = startedAt;
  let speed = 0;

  if (!args.quiet) {
    downloader.on('progress', ({ id: pid, percent, received, total }) => {
      if (pid !== id) return;
      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      if (dt >= 0.25) {
        speed = (received - lastReceived) / dt;
        lastReceived = received;
        lastTime = now;
      }
      const sizeStr = total ? `${formatBytes(received)}/${formatBytes(total)}` : formatBytes(received);
      const speedStr = `${formatBytes(speed)}/s`;
      process.stdout.write(`\r${renderBar(percent)} ${percent}% ${sizeStr} ${speedStr}    `);
    });
  }

  downloader.on('status', (s) => {
    if (s.id !== id) return;
    if (s.status === 'downloading') {
      if (!args.quiet) console.log(`Downloading: ${s.filename}`);
    } else if (s.status === 'completed') {
      if (!args.quiet) {
        process.stdout.write(`\r${renderBar(100)} 100%${' '.repeat(40)}\n`);
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`Saved: ${s.dest} (${elapsed}s)`);
      }
      process.exit(0);
    } else if (s.status === 'error') {
      console.error(`\nError: ${s.error}`);
      process.exit(1);
    }
  });

  downloader.startDownload(args.url, id, { outputPath: args.output });
}

main();
