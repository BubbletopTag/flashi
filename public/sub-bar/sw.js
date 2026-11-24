/* Sub Bar service worker: lets the app open and play with no signal.
   App files: network first (so changes show up), falling back to the saved copy.
   Audio: saved copy first. Safari asks for audio in pieces (Range requests), so those are answered here. */
importScripts('data.js');
const CACHE = 'sub-bar-' + SUBBAR.build;           // a new build of the audio makes a new cache
const SHELL = ['./', 'index.html', 'engine.js', 'data.js', 'manifest.webmanifest', 'icon.png', 'icon-192.png', 'icon-512.png'];
const AUDIO = [...SUBBAR.orders, ...SUBBAR.subs].map(x => x.file);

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll([...SHELL, ...AUDIO].map(url => new Request(url, { cache: 'reload' })));
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('sub-bar-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  event.respondWith(url.pathname.endsWith('.mp3') ? audio(req) : networkFirst(req));
});

function fetchWithin(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('slow')), ms);
    fetch(req).then(res => { clearTimeout(timer); resolve(res); }, err => { clearTimeout(timer); reject(err); });
  });
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetchWithin(req, 3000);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true }))
      || (req.mode === 'navigate' ? await cache.match('index.html') : null)
      || Response.error();
  }
}

async function audio(req) {
  const cache = await caches.open(CACHE);
  let res = await cache.match(req.url);              // keyed by address, ignoring the Range header
  if (!res) {
    res = await fetch(req.url);
    if (res.ok) await cache.put(req.url, res.clone());
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  if (!range || !res.ok) return res;
  const bytes = await res.arrayBuffer(), size = bytes.byteLength;
  const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
  const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  return new Response(bytes.slice(start, end + 1), {
    status: 206, statusText: 'Partial Content',
    headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
  });
}
