# Roadmap

## V1 — Basic Download (current scope)

**Goal:** Download any media file (video, audio, image, archive) from a direct URL. Works via GUI **and** terminal.

### GUI
- Paste URL → click Download
- File streams to `/downloads`
- Progress bar + filename + status (downloading/completed/error)
- Single download at a time is fine; multiple concurrent is bonus

### CLI
- `node cli.js <url>` — downloads to `/downloads`
- Flags:
  - `-o <path>` — custom output path
  - `-q` — quiet mode (no progress bar)
- Progress bar in terminal (simple `\r` overwrite, % + bytes)
- Exit codes: `0` success, `1` failure

### Shared engine
- `src/downloader.js` is the single source of truth
- GUI imports it via IPC; CLI imports it directly
- Handles: HTTP + HTTPS, redirects (3xx), content-length parsing, stream-to-disk via `fs.createWriteStream`
- Filename derived from URL path or `Content-Disposition` header

### Media support
- No special handling needed — direct file URLs work for audio (`.mp3`, `.wav`, `.flac`), video (`.mp4`, `.webm`), images, archives
- Stream-based, so file size doesn't matter

### Done when
- `node cli.js https://example.com/song.mp3` saves the file with progress
- GUI does the same
- Both code paths share `downloader.js`

---

## V2 — Real Download Manager (from mvp.md)

**Goal:** Real pause/resume + parallel performance + better UX.

- **True resume** via HTTP Range Requests (`Range: bytes=N-`)
  - Persist partial download state (bytes received, etag)
  - Resume from byte offset, not restart
- **Multi-thread chunk downloads**
  - Split file into N chunks (e.g. 4 or 8)
  - Parallel range requests, merge on completion
  - Falls back to single-stream if server doesn't support ranges
- **Speed limiter** — throttle bytes/sec per download (token bucket)
- **Better UI**
  - Card-based dashboard
  - Per-download speed (MB/s), ETA, size
  - Cancel + retry buttons
  - Persistent download history (sqlite or json file)
- **Queue** — max N concurrent, rest wait

### Done when
- Pause a 1GB download mid-flight, close app, reopen, resume from same byte
- Multi-thread visibly faster than single-stream on supported servers
- UI shows real-time speed + ETA

---

## V3 — Browser Extension Integration

**Goal:** Capture downloads from the browser, route them through the manager.

### Extension (Chrome/Firefox)
- Manifest V3
- Intercept `<a download>` clicks + right-click "Save link as"
- Optionally hook `chrome.downloads.onCreated` to redirect all browser downloads
- "Send to Download Manager" context menu
- Detects media on page (audio/video tags, sources) → one-click download

### Bridge
- **Native messaging host** OR **local HTTP server** in Electron app
  - Local HTTP (e.g. `http://127.0.0.1:9999`) is simpler, cross-browser
  - Native messaging is more secure but per-browser config
- Extension sends `{ url, headers, cookies, referer }` → manager starts download
- Cookies + headers passed through so authenticated/protected URLs work

### Features
- Sniff streaming media (HLS `.m3u8`, DASH `.mpd`) → optional ffmpeg merge
- Batch link grabber (grab all links matching pattern from a page)
- Right-click image/video/audio → download via manager
- Settings sync between extension and app (download folder, speed limit)

### Done when
- Click any download link in browser → app picks it up automatically
- Authenticated downloads (cookies) work
- HLS stream from a page can be captured and saved as a single file

---

## Out of scope (all versions)
- Cloud sync / accounts
- Torrent support
- Mobile apps
- Built-in player
