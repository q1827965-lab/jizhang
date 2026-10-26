/*!
 * sw.js —— Service Worker
 * 作用：
 *  1. 离线可用：把 App 的文件缓存下来，断网也能打开
 *  2. 新版本提示：拿到新文件时不立刻清缓存，而是通知页面「有新版本，点此刷新」
 *
 * 注意：**账目数据不在这里**，数据存在 localStorage，SW 不碰。
 */
var CACHE = 'ledger-v3-today-sticky-20261026';
var ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './icons/icon-maskable-192.svg',
  './icons/icon-maskable-512.svg',
  './js/png-data.js',
  './css/app.css',
  './js/calc.js',
  './js/store.js',
  './js/ui.js',
  './vendor/flatpickr/flatpickr.min.js',
  './vendor/flatpickr/flatpickr.min.css',
  './vendor/flatpickr/zh.js',
  './pages/home.html',
  './pages/flow.html',
  './pages/plan.html',
  './pages/calendar.html',
  './pages/more.html',
  './pages/accounts.html',
  './pages/review-entry.html',
  './pages/settings.html',
  './pages/add.html',
  './pages/buy.html',
  './pages/payday.html',
  './pages/goals.html',
  './pages/deposits.html',
  './pages/edit-item.html'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 单个文件失败不能让整个安装失败
      return Promise.all(ASSETS.map(function (u) {
        return c.add(u).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  // 跨域（Google Fonts 等）不缓存，走网络
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      // 先看有没有新版：拿网络上的和缓存里的比 ETag / Last-Modified
      var net = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return hit;      // 断网：返回缓存
      });

      if (hit) {
        // 有缓存就先用缓存秒开，同时后台更新；不阻塞响应
        net.catch(function () {});
        return hit;
      }
      return net;
    })
  );
});

/* 页面主动要求「跳过等待，立刻用新版」 */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
