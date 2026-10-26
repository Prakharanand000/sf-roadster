// CARS agent — tiny static server (Node handles Windows long paths that python's http.server
// trips over).  Usage from sf-roadster/:  node dev/cars-serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8102);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
http.createServer((req, res) => {
  // optional cache-busting prefix: /~anything/dev/x.html serves /dev/x.html
  const url = decodeURIComponent(req.url.split('?')[0]).replace(/^\/~[^/]*/, '');
  let p = path.join(root, url);
  if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
  if (url.endsWith('/')) p = path.join(p, 'index.html');
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, () => console.log('serving ' + root + ' on http://localhost:' + port));
