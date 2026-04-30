# Josiah's Download Manager

Desktop download manager built with Electron + Node.js. Download files from URLs via GUI or terminal.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer

## Install

```bash
git clone <repo-url>
cd josiahsdownloadmanager
npm install
```

## Run

### GUI (Electron app)

```bash
npm start
```

A window opens. Paste a URL → click Download.

### CLI

```bash
# Run without installing
npm run dl -- https://example.com/song.mp3

# Or directly
node cli.js https://example.com/video.mp4 -o ~/Videos/

# Install globally so `jdm` is on PATH
npm install -g .
jdm https://example.com/file.zip
```

CLI options:

| Flag | Meaning |
|------|---------|
| `-o, --output <path>` | Output file or directory |
| `-q, --quiet` | No progress bar |
| `-h, --help` | Show help |

## Where files save

Default: `~/Downloads/JDM/` (or `%USERPROFILE%\Downloads\JDM\` on Windows).

Override with `-o` flag, or set `JDM_DOWNLOAD_DIR` env var.

## Build distributable binary

```bash
npm run build:win     # Windows .exe (NSIS installer)
npm run build:mac     # macOS .dmg
npm run build:linux   # Linux AppImage
npm run build         # Current platform
```

Output goes to `dist/`.

## Test

```bash
npm test
```

27 tests via Node built-in test runner. No extra deps.

## Project structure

```
.
├── main.js              # Electron main process
├── preload.js           # Electron IPC bridge
├── cli.js               # CLI entry point
├── src/
│   ├── downloader.js    # Shared download engine (HTTP stream → fs)
│   ├── ipcHandlers.js   # GUI ↔ engine wiring
│   └── util.js          # Pure helpers (parsing, formatting)
├── renderer/
│   ├── index.html       # UI
│   ├── app.js           # Frontend logic
│   └── styles.css
└── test/                # Unit + integration tests
```

## Roadmap

See [`roadmap.md`](roadmap.md) for V1 / V2 / V3 scope.

- **V1** (current): direct URL download, GUI + CLI, shared engine
- **V2**: HTTP Range resume, multi-thread chunks, speed limit, dashboard
- **V3**: browser extension integration

## License

MIT
