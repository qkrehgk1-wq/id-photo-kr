/**
 * 앱 껍데기만 캐시한다.
 * 얼굴 인식 모델은 CDN에서 받으므로 첫 실행에는 인터넷이 필요하다.
 * 사진 자체는 어디에도 캐시하지 않는다 — 캐시에 남기지 않는 것도 프라이버시의 일부다.
 */
const CACHE = 'idphoto-v2'; // 앱 파일을 바꾸면 index.html 의 ?v= 와 함께 올린다
const SHELL = [
  './',
  './index.html',
  './js/app.js',
  './js/specs.js',
  './js/geometry.js',
  './js/quality.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

/**
 * network-first: 새 버전을 고치면 바로 반영되게 한다.
 * 캐시 우선으로 두면 앱을 고쳐도 사용자 화면에는 옛 버전이 계속 남는다.
 * 캐시는 오프라인일 때만 쓰는 안전망이다.
 */
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })), // ?v= 가 붙어도 오프라인 캐시를 찾는다
  );
});
