# Josiah's Download Manager

Desktop download manager built with Electron + Node.js. **CLI is the primary interface.** GUI is a floating overlay that shows what the CLI is doing.

## Requirements

- [Node.js](https://nodejs.org) 18+

## Install

```bash
git clone https://github.com/jojo6550/josiahsdownloadmanager.git
cd josiahsdownloadmanager
npm install
```

## Usage

### CLI

```bash
# Run without installing
node cli.js https://example.com/file.zip

# Install globally
npm install -g .
jdm https://example.com/file.zip
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-o, --output <path>` | `~/Downloads/JDM/` | Output file or directory |
| `-c, --chunks <n>` | `8` | Parallel download chunks (max 32) |
| `-C, --concurrency <n>` | `1` | Simultaneous downloads (max 16) |
| `-q, --quiet` | — | Suppress progress output |
| `-h, --help` | — | Show help |

**Examples:**

```bash
jdm https://example.com/video.mp4
jdm https://example.com/archive.tar.gz  -o ~/Downloads/ -c 16
jdm https://example.com/page            -o ./page.html
jdm https://example.com/               # saves as example.com.html
```

### GUI Overlay

```bash
npm start
```

Launches a compact floating overlay (bottom-right, always-on-top). Paste a URL and track progress visually. The GUI and CLI share the same download engine.

## Where files save

Default: `~/Downloads/JDM/`

Override: `-o <path>` flag, or set `JDM_DOWNLOAD_DIR` env var.

File extension is inferred from `Content-Type` when the URL has none (e.g. `text/html` → `.html`).

## Build distributable

```bash
npm run build:win     # Windows .exe (NSIS)
npm run build:mac     # macOS .dmg
npm run build:linux   # Linux AppImage
npm run build         # Current platform
```

Output: `dist/`

## Test

```bash
npm test
```

77 tests via Node built-in test runner. No extra deps.

## Project structure

```
.
├── main.js              # Electron main — overlay window + daemon startup
├── preload.js           # Electron IPC bridge
├── cli.js               # CLI entry point (true application)
├── src/
│   ├── api/
│   │   ├── queue.js     # Singleton DownloadQueue shared by daemon + GUI
│   │   └── server.js    # HTTP + SSE daemon server (port 7821)
│   ├── engine/
│   │   ├── ChunkManager.js   # Parallel chunked HTTP download
│   │   ├── DownloadJob.js    # Per-download state machine
│   │   ├── DownloadQueue.js  # Concurrency queue
│   │   └── RangeRequest.js   # HTTP Range request with retry
│   ├── logger/
│   │   └── Logger.js    # File + event logger with rotation
│   ├── ipcHandlers.js   # GUI ↔ engine IPC wiring
│   ├── mimeTypes.js     # MIME → file extension map
│   └── util.js          # Formatters, arg parser
├── renderer/
│   ├── index.html       # Overlay UI
│   ├── app.js           # Overlay logic
│   └── styles.css
└── test/                # Unit + integration tests
```

## How it works

1. `jdm <url>` runs the full download engine standalone — no GUI required
2. `npm start` opens the GUI overlay; the GUI and CLI share the same underlying engine
3. ChunkManager splits files into parallel chunks (default 8), merges them on completion
4. Falls back to single-stream for servers that block `HEAD` or don't support `Accept-Ranges`
5. File extension is inferred from `Content-Type` when absent from the URL

## License

MIT
