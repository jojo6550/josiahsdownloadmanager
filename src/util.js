const path = require('path');
const { extFromMime } = require('./mimeTypes');

function filenameFromResponse(res, urlObj, fallback) {
  const cd = res.headers['content-disposition'];
  if (cd) {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    if (match) return decodeURIComponent(match[1]);
  }

  let name = path.basename(urlObj.pathname) || fallback;

  if (!path.extname(name)) {
    const ext = extFromMime(res.headers['content-type']);
    if (ext) name = `${name}.${ext}`;
  }

  return name;
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

function parseArgs(argv) {
  const args = { url: null, output: null, chunks: null, concurrency: null, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') {
      args.output = argv[++i];
    } else if (a === '-c' || a === '--chunks') {
      args.chunks = Math.max(1, Math.min(32, parseInt(argv[++i], 10) || 8));
    } else if (a === '-C' || a === '--concurrency') {
      args.concurrency = Math.max(1, Math.min(16, parseInt(argv[++i], 10) || 1));
    } else if (a === '-q' || a === '--quiet') {
      args.quiet = true;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (!a.startsWith('-') && !args.url) {
      args.url = a;
    }
  }
  return args;
}

module.exports = { filenameFromResponse, formatBytes, renderBar, parseArgs };
