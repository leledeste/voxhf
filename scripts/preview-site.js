'use strict';

// Serve the static public pages and demo workspace without starting the local
// Altitude bridge. This is for visual review and screenshot generation only.

const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '../webapp');
const port = Number(process.env.VOXHF_PREVIEW_PORT || 4173);
const host = process.env.VOXHF_PREVIEW_HOST || '127.0.0.1';
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (_) {
    res.writeHead(400).end('Bad request');
    return;
  }

  const route = pathname === '/' ? '/index.html'
    : pathname === '/setup' ? '/setup.html'
      : pathname === '/servers' ? '/servers.html'
        : pathname;
  const file = path.normalize(path.join(root, route.replace(/^\/+/, '')));
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  });
}).listen(port, host, () => {
  console.log(`[site-preview] http://${host}:${port}`);
});
