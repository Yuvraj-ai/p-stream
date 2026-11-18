// Local test target for verifying the p-stream proxy (see ../server.mjs).
// Serves a header echo endpoint, a POST body echo, and a small HLS tree
// (master playlist with key/map/variant/segment) to exercise m3u8 rewriting.
//
//   node test/echo-target.mjs        # listens on :8098
//   PORT=8100 node test/echo-target.mjs

import http from 'node:http';

const PORT = Number(process.env.PORT || 8098);

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI="keys/key1",IV=0x1
#EXT-X-MAP:URI="init.mp4"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720
720p.m3u8
#EXTINF:4.0,
seg1.ts
`;

const CHILD = `#EXTM3U
#EXTINF:4.0,
seg2.ts
#EXTINF:4.0,
seg3.ts
`;

http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (url.pathname === '/echo') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.headers));
    return;
  }
  if (url.pathname === '/body') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`BODY:${Buffer.concat(chunks).toString('utf8')}`);
    });
    return;
  }
  if (url.pathname === '/live/master.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(PLAYLIST);
    return;
  }
  if (url.pathname === '/live/720p.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(CHILD);
    return;
  }
  if (url.pathname.startsWith('/live/')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from('fakebin'));
    return;
  }
  res.writeHead(404);
  res.end('nope');
}).listen(PORT, () => console.log(`[echo-target] listening on :${PORT}`));
