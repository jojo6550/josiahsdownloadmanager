'use strict';

const http = require('node:http');
const path = require('node:path');
const os   = require('node:os');
const queue = require('./queue');

const PORT = 7821;

/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of sseClients) sseWrite(res, event, data);
}

queue.on('job:progress', (p) => broadcast('progress', p));
queue.on('job:status',   (p) => broadcast('status',   p));

function resolveDestFromUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const base = path.basename(parsed.pathname) || parsed.hostname || `download-${Date.now()}`;
  const dir  = process.env.JDM_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'JDM');
  return path.join(dir, base);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end',  () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { pathname } = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ pid: process.pid }));
  }

  if (req.method === 'GET' && pathname === '/download/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write(':\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET' && pathname === '/download/jobs') {
    const jobs = queue.getJobs().map((j) => ({
      id: j.id, url: j.url, dest: j.dest, status: j.status,
      totalBytes: j.totalBytes, receivedBytes: j.receivedBytes,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(jobs));
  }

  if (req.method === 'POST') {
    readBody(req).then((body) => {
      if (pathname === '/download/add') {
        let parsed;
        try { parsed = new URL(body.url); } catch {
          res.writeHead(400); return res.end('Invalid URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          res.writeHead(400); return res.end('Only http/https');
        }
        const dest = body.dest || resolveDestFromUrl(body.url);
        const { id } = queue.add(body.url, dest);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id, dest }));
      }

      if (pathname === '/download/pause')  { queue.pause(body.id);  res.writeHead(204); return res.end(); }
      if (pathname === '/download/resume') { queue.resume(body.id); res.writeHead(204); return res.end(); }
      if (pathname === '/download/cancel') { queue.cancel(body.id); res.writeHead(204); return res.end(); }

      res.writeHead(404); res.end();
    }).catch((err) => {
      res.writeHead(400); res.end(err.message);
    });
    return;
  }

  res.writeHead(404); res.end();
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

module.exports = { startServer, PORT };
