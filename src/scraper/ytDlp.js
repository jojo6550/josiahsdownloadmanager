'use strict';

const { spawn } = require('node:child_process');

// [download]  42.3% of 1.23GiB at 5.67MiB/s ETA 00:30
const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+([\d.]+)(\w+)\s+at\s+([\d.]+)(\w+)\/s\s+ETA\s+([\d:]+)/;

function parseBytes(val, unit) {
  const n = parseFloat(val);
  const u = unit.toLowerCase();
  if (u === 'kib') return n * 1024;
  if (u === 'mib') return n * 1024 ** 2;
  if (u === 'gib') return n * 1024 ** 3;
  if (u === 'kb')  return n * 1e3;
  if (u === 'mb')  return n * 1e6;
  if (u === 'gb')  return n * 1e9;
  return n;
}

function parseEta(str) {
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

/**
 * Probe a URL with yt-dlp and return available video formats.
 * @param {string} url
 * @returns {Promise<Array<{id:string, ext:string, resolution:string, filesize:number|null, note:string, vcodec:string, acodec:string}>>}
 */
function probe(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-json', '--no-playlist', '--quiet', url]);

    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `yt-dlp exited ${code}`));
      try {
        const info = JSON.parse(out);
        const formats = (info.formats || []).map((f) => ({
          id:         f.format_id,
          ext:        f.ext,
          resolution: f.resolution || (f.height ? `${f.height}p` : 'audio only'),
          filesize:   f.filesize || f.filesize_approx || null,
          note:       f.format_note || '',
          vcodec:     f.vcodec || 'none',
          acodec:     f.acodec || 'none',
        }));
        resolve(formats);
      } catch {
        reject(new Error('Failed to parse yt-dlp output'));
      }
    });

    proc.on('error', () => reject(new Error('yt-dlp not found — install it: https://github.com/yt-dlp/yt-dlp')));
  });
}

/**
 * Download via yt-dlp.
 * @param {string} url
 * @param {string} formatId - yt-dlp format string, e.g. "137+140" or "bestvideo+bestaudio"
 * @param {string} dest - output path (no extension; yt-dlp adds it)
 * @param {object} [opts]
 * @param {function} [opts.onProgress]
 * @param {function} [opts.onFilename]
 * @returns {{ proc: import('node:child_process').ChildProcess, promise: Promise<void> }}
 */
function download(url, formatId, dest, { onProgress, onFilename } = {}) {
  const proc = spawn('yt-dlp', [
    '--format', formatId,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--newline',
    '--progress',
    '-o', dest,
    url,
  ]);

  const promise = new Promise((resolve, reject) => {
    const handleLine = (line) => {
      // Detect destination filename
      const destMatch = line.match(/(?:Destination|Merging formats into):\s*(.+)/);
      if (destMatch && onFilename) onFilename(destMatch[1].trim());

      // Parse progress
      const m = PROGRESS_RE.exec(line);
      if (m && onProgress) {
        const percent      = parseFloat(m[1]);
        const totalBytes   = parseBytes(m[2], m[3]);
        const speedBps     = parseBytes(m[4], m[5]);
        const etaSecs      = parseEta(m[6]);
        const receivedBytes = totalBytes * (percent / 100);
        onProgress({ percent, totalBytes, receivedBytes, speedBps, etaSecs });
      }
    };

    let stdoutBuf = '';
    proc.stdout.on('data', (d) => {
      stdoutBuf += d;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      lines.forEach(handleLine);
    });

    let stderrBuf = '';
    let lastErr = '';
    proc.stderr.on('data', (d) => {
      stderrBuf += d;
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop();
      lines.forEach((l) => { handleLine(l); lastErr = l || lastErr; });
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(lastErr || `yt-dlp exited ${code}`));
    });

    proc.on('error', () => reject(new Error('yt-dlp not found')));
  });

  return { proc, promise };
}

module.exports = { probe, download };
