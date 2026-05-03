# JDM V2 — IDM-Style Download Manager Redesign

## Context

V1 MVP is complete: working GUI + CLI, shared `src/downloader.js` engine, 27 passing tests. The app downloads files over HTTP/S with progress reporting but has no true pause/resume (HTTP Range), no parallel chunk downloading, no structured logging, and a plain Bootstrap UI.

Goal: Rebuild the core engine with clean architecture (Approach B), add IDM-style segmented downloading with per-thread progress visualization, a structured logger with a live sidebar debug panel, and a full Dark Pro UI overhaul.

User design decisions:
- Features: segmented/multi-thread downloads + full UI overhaul + logging/debug panel
- Theme: Dark Pro (GitHub-dark aesthetic, JetBrains Mono + Inter, blue accents)
- Log panel: persistent left sidebar with level filters (DBG/INFO/WARN/ERR)
- Progress: per-thread rows (T1–T8 each with own mini bar + speed) + overall bar above

---

## Architecture

### New files to create

| File | Purpose |
|------|---------|
| `src/engine/DownloadJob.js` | State machine per download: `idle→queued→downloading→paused→completed\|error`. Owns id, url, filename, dest, chunks[]. Emits `progress`, `status`, `chunk-progress`. |
| `src/engine/ChunkManager.js` | HEAD probe for Content-Length + Accept-Ranges. Splits into N chunks (default `CHUNK_COUNT = 8`, top-level constant). Fires N parallel RangeRequests. Merges temp files on completion. Falls back to single stream. |
| `src/engine/RangeRequest.js` | Downloads one byte range (`Range: bytes=from-to`) → temp file `.tmp/job-{id}-chunk-{n}`. Retries 3× on network error (1s/2s/4s backoff). Emits `progress`, `done`, `error`. |
| `src/engine/DownloadQueue.js` | Manages max-concurrent slot (hardcoded `MAX_CONCURRENT = 3` constant, not user-configurable in V2). `add(url)→id`, `pause(id)`, `resume(id)`, `cancel(id)`. Starts next queued job when slot opens. |
| `src/logger/Logger.js` | Levels: DEBUG/INFO/WARN/ERROR. Writes JSON lines to `~/Downloads/JDM/jdm.log` (rotate at 5MB, keep 3). Emits `entry` event in-process for IPC relay. `log(level, msg, meta)`, `getEntries(limit, level?)`. |

### Files to modify

| File | Change |
|------|--------|
| `src/ipcHandlers.js` | Wire to `DownloadQueue` + `Logger`. Relay `logger.on('entry')` → `log:entry` IPC push. |
| `preload.js` | Add: `cancelDownload(id)`, `getLogEntries(limit, level)`, `onLogEntry(cb)`. |
| `main.js` | Init `Logger` singleton. Set `JDM_DOWNLOAD_DIR`. Register updated IPC handlers. |
| `cli.js` | Use `DownloadQueue` directly (not old `downloader.js`). Logger writes to file; progress still renders to stdout. |
| `renderer/index.html` | Full rewrite — no Bootstrap. JetBrains Mono + Inter via Google Fonts. |
| `renderer/app.js` | Full rewrite — Dark Pro, sidebar log panel, download cards with per-thread rows. |
| `renderer/styles.css` | Full rewrite — CSS custom properties, Dark Pro palette. |

### Files unchanged

- `src/util.js` — filename extraction, byte formatting, CLI arg parsing
- `src/mimeTypes.js` — MIME → extension lookup

### File to deprecate

- `src/downloader.js` — replace with thin re-export shim pointing to `DownloadQueue` during transition, then delete

---

## IPC Channels

### Renderer → Main (invoke)
```
download:start    { url }              → { id }
download:pause    { id }
download:resume   { id }
download:cancel   { id }
log:get-entries   { limit, level? }    → LogEntry[]
```

### Main → Renderer (push)
```
download:progress  { id, overall: { percent, receivedBytes, totalBytes, speedBps, etaSecs }, chunks: [{ n, percent, speedBps }] }
download:status    { id, status, filename, dest, error }
                   status ∈ 'queued'|'downloading'|'paused'|'completed'|'error'
log:entry          { level, ts, msg, meta }
```

---

## Logger Design

- `Logger.js` — singleton exported from `src/logger/Logger.js`
- JSON-lines to file: `{ level, ts: ISO8601, msg, meta }`
- File rotation: new file when current exceeds 5MB; keep last 3 files
- In-process EventEmitter: `logger.on('entry', cb)` — used by `ipcHandlers.js` to push to renderer
- `ipcHandlers.js` handles `log:get-entries` by calling `logger.getEntries(limit, level)`

---

## UI Spec (Dark Pro)

### CSS variables (root)
```
--bg-base: #0d1117  |  --bg-surface: #161b22  |  --bg-elevated: #21262d
--border: #30363d   |  --border-focus: #388bfd
--text-primary: #e6edf3  |  --text-secondary: #8b949e  |  --text-muted: #484f58
--accent-blue: #388bfd   |  --accent-blue-dim: #1f6feb
--accent-green: #3fb950  |  --accent-yellow: #d29922  |  --accent-red: #f85149
```

### Fonts
- Display/mono: `JetBrains Mono` (logo, filenames, log text, stats, progress labels)
- Body: `Inter` (buttons, descriptions, badges)

### Layout (flex column)
```
┌─────────────────────────────────────────────────────┐
│ TOPBAR: [JDM logo] [URL input ────────] [Download]  │
│         [Total: 79MB/s] [Active: 2] [Queued: 3]     │
├──────────────┬──────────────────────────────────────┤
│ LOG SIDEBAR  │  DOWNLOADS MAIN                      │
│ (280px fixed)│  Active (2)                          │
│              │  ┌─ chrome-setup.exe ──────────────┐ │
│ DBG INF WRN  │  │ T1 ████████░░ 12.4MB/s          │ │
│ ERR filters  │  │ T2 ██████░░░░  9.1MB/s          │ │
│              │  │ ...                              │ │
│ [INFO] Start │  │ Overall ██████████░░░░ 67%       │ │
│ [DBG]  T1 ok │  │ [Pause] [Cancel]   79MB/s ETA4s │ │
│ [WARN] retry │  └──────────────────────────────────┘ │
│ [DBG]  Range │  Queued (3) / Completed (1)           │
└──────────────┴──────────────────────────────────────┘
```

### Download card anatomy
1. Filename (JetBrains Mono, truncated)
2. Meta row: speed (green) + ETA + size (right-aligned)
3. Overall progress bar (6px, blue gradient)
4. Per-thread rows: `T{n}` label | mini bar (4px) | speed (right, 48px wide)
5. Controls row: `{pct}%` (left) | Pause | Cancel buttons

### Log sidebar anatomy
- Header: "DEBUG LOGS" label + DBG/INF/WRN/ERR toggle pills
- Scrollable entry list: `[LEVEL] [HH:MM:SS] message`
- Entries pushed in real-time via `log:entry` IPC

---

## Error Handling

- `RangeRequest` — retry 3× on network error (1s/2s/4s), then emit `error`
- `ChunkManager` — any chunk final failure → job `error`; keep `.tmp` files so `download:resume` can continue each chunk from its last byte offset
- HEAD probe failure → log WARN + fall back to single-stream (transparent to user)
- Disk write error → immediate `error` status, log ERROR with path + errno
- Server returns no `Content-Length` or no `Accept-Ranges` → single-stream fallback + WARN log

---

## Testing

Extend existing `test/` with Node built-in test runner (no new deps):

| File | Coverage |
|------|---------|
| `test/engine/DownloadJob.test.js` | State transitions, event emission |
| `test/engine/ChunkManager.test.js` | Range probe (supported/not), chunk splitting math, merge, fallback |
| `test/engine/RangeRequest.test.js` | Byte-range HTTP request against local server, retry logic |
| `test/logger.test.js` | Log levels, file write, event emission, rotation trigger |
| `test/util.test.js` | Unchanged (17 tests) |

Local test HTTP server (already in `test/downloader.test.js`) gets extended to handle `Range` requests and return `Accept-Ranges: bytes`.

---

## Build Sequence

1. Write spec doc → `docs/superpowers/specs/2026-05-03-jdm-v2-design.md` + commit
2. `src/logger/Logger.js` — implement + test
3. `src/engine/RangeRequest.js` — implement + test
4. `src/engine/ChunkManager.js` — implement + test (Range + fallback paths)
5. `src/engine/DownloadJob.js` — implement + test
6. `src/engine/DownloadQueue.js` — implement
7. `src/ipcHandlers.js` — update to use queue + logger
8. `preload.js` — add new channels
9. `main.js` — init logger + register updated handlers
10. `cli.js` — update to use DownloadQueue
11. `renderer/` — full Dark Pro UI rewrite (index.html + app.js + styles.css)
12. `src/downloader.js` — replace with shim, then delete
13. `npm test` — all tests pass
14. `npm start` — manual verification

---

## Verification

1. `npm test` — all tests green
2. `npm start` → paste URL → per-thread bars animate → logs stream in sidebar
3. `node cli.js <url>` → progress renders → exit code 0
4. Pause mid-download → resume → completes from same byte (HTTP Range)
5. URL without Range support → single-stream fallback → WARN in log panel
6. `~/Downloads/JDM/jdm.log` file written with JSON lines
