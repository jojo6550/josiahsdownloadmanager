'use strict';

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_ROTATED = 3;

class Logger extends EventEmitter {
  constructor() {
    super();
    this._minLevel = LEVELS.DEBUG;
    this._logPath = null;
  }

  _ensureLogPath() {
    if (this._logPath) return this._logPath;
    const dir = process.env.JDM_DOWNLOAD_DIR;
    if (!dir) throw new Error('JDM_DOWNLOAD_DIR is not set');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this._logPath = path.join(dir, 'jdm.log');
    return this._logPath;
  }

  _rotate(logPath) {
    // Shift existing rotated files: jdm.log.2 -> jdm.log.3, jdm.log.1 -> jdm.log.2
    for (let i = MAX_ROTATED - 1; i >= 1; i--) {
      const src = `${logPath}.${i}`;
      const dst = `${logPath}.${i + 1}`;
      if (fs.existsSync(src)) {
        // If dst already exists at max boundary, remove it
        if (i === MAX_ROTATED - 1 && fs.existsSync(dst)) {
          fs.unlinkSync(dst);
        }
        fs.renameSync(src, dst);
      }
    }
    // Rename current log to .1
    if (fs.existsSync(logPath)) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  }

  _writeEntry(entry) {
    const logPath = this._ensureLogPath();
    const line = JSON.stringify(entry) + '\n';

    // Check if rotation needed
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      if (stats.size >= MAX_SIZE) {
        this._rotate(logPath);
      }
    }

    try {
      fs.appendFileSync(logPath, line, 'utf8');
    } catch (err) {
      console.error('[JDM Logger] write error:', err.message);
    }
  }

  log(level, msg, meta = {}) {
    const levelNum = typeof level === 'string' ? LEVELS[level] : level;
    if (levelNum === undefined || levelNum === null) return;
    if (levelNum < this._minLevel) return;

    const levelName = Object.keys(LEVELS).find(k => LEVELS[k] === levelNum) || String(level);
    const entry = {
      level: levelName,
      ts: new Date().toISOString(),
      msg,
      meta,
    };

    this._writeEntry(entry);
    this.emit('entry', entry);
  }

  debug(msg, meta = {}) {
    this.log('DEBUG', msg, meta);
  }

  info(msg, meta = {}) {
    this.log('INFO', msg, meta);
  }

  warn(msg, meta = {}) {
    this.log('WARN', msg, meta);
  }

  error(msg, meta = {}) {
    this.log('ERROR', msg, meta);
  }

  setLevel(level) {
    if (typeof level === 'string') {
      const num = LEVELS[level];
      if (num === undefined) throw new Error(`Unknown level: ${level}`);
      this._minLevel = num;
    } else if (typeof level === 'number') {
      if (!Object.values(LEVELS).includes(level)) throw new Error('Invalid log level: ' + level);
      this._minLevel = level;
    } else {
      this._minLevel = level;
    }
  }

  getEntries(limit = 100, levelFilter = null) {
    const logPath = this._ensureLogPath();
    if (!fs.existsSync(logPath)) return [];

    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim() !== '');

    let entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }

    // Newest first
    entries.reverse();

    // Filter by level if requested
    if (levelFilter && Object.prototype.hasOwnProperty.call(LEVELS, levelFilter)) {
      entries = entries.filter(e => e.level === levelFilter);
    }

    return entries.slice(0, limit);
  }
}

// Singleton export
const logger = new Logger();
module.exports = logger;
