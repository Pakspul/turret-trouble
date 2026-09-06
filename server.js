'use strict';

/*
 * Turret Trouble - zero-dependency static file server.
 *
 * Azure App Service (Linux, Node runtime) runs `npm start`, which lands here.
 * Azure App Service (Windows) routes through web.config -> iisnode -> here.
 * Nothing outside `public/` is ever served.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

// Long cache for fingerprint-free assets is risky, so keep the shell fresh and
// let versioned query strings (?v=) handle the rest.
function cacheFor(ext) {
  if (ext === '.html' || ext === '.webmanifest') return 'no-cache';
  return 'public, max-age=3600';
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff' }, headers || {}));
  res.end(body);
}

function serveFile(res, filePath, isHead) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheFor(ext),
      'Last-Modified': stat.mtime.toUTCString()
    };
    if (isHead) return send(res, 200, '', headers);
    res.writeHead(200, Object.assign({ 'X-Content-Type-Options': 'nosniff' }, headers));
    fs.createReadStream(filePath)
      .on('error', () => res.destroy())
      .pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  // Azure health probe / deployment smoke test.
  if (pathname === '/healthz') {
    return send(res, 200, JSON.stringify({ status: 'ok', uptime: process.uptime() }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
  }

  if (pathname === '/') pathname = '/index.html';

  const target = path.join(ROOT, path.normalize(pathname));
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  serveFile(res, target, req.method === 'HEAD');
});

server.listen(PORT, HOST, () => {
  console.log(`Turret Trouble listening on http://${HOST}:${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
