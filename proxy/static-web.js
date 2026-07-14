'use strict';

const fs = require('fs');
const path = require('path');

function createStaticWebHandler(webDir) {
  // The webapp is static and intentionally served by the same process as the
  // proxy. This keeps setup to "run start.bat, open localhost".
  return (req, res) => {
    let rawPath = '/';
    try {
      rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch (_) {
      res.writeHead(400); res.end('Bad request'); return;
    }

    // The public host owns the marketing landing page. The local proxy opens
    // the operational workspace directly so local-only users have no extra
    // account or navigation step.
    const safePath = rawPath === '/' ? 'app.html' : rawPath.replace(/^\/+/, '');
    const filePath = path.normalize(path.join(webDir, safePath));
    const relativePath = path.relative(webDir, filePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      // path.relative is safer than a string prefix check on Windows, where a
      // sibling such as "webapp2" would otherwise share the same text prefix.
      res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'text/plain';
      res.writeHead(200, {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        ...(path.basename(filePath).toLowerCase() === 'release.json' ? { 'Cache-Control': 'no-store' } : {}),
      });
      res.end(data);
    });
  };
}

module.exports = {
  createStaticWebHandler,
};
