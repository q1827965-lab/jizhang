/*!
 * ui.js —— 界面共用组件
 * 底部导航、弹出页骨架、格式化、图标、导出下载、toast。
 * 只碰 DOM，不做任何业务计算（计算全在 calc.js）。
 */
var UI = (function () {
  'use strict';

  /* ---------- 路径助手：兼容根目录页与 pages\ 子目录页 ---------- */
  function base() {
    var p = location.pathname;
    return /\/pages\//.test(p) ? '../' : './';
  }

  function url(page) {
    return base() + 'pages/' + page;
  }

  function abs(file) {
    return base() + file;
  }

  /* ---------- 图标 ---------- */
  var ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"></path>',
    flow: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"></path>',
    plan: '<path d="M3 3v18h18M7 15l4-4 3 3 5-6"></path>',
    calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"></rect><path d="M16 2.5v4M8 2.5v4M3 10h18"></path>',
    more: '<circle cx="5" cy="12" r="1.4"></circle><circle cx="12" cy="12" r="1.4"></circle><circle cx="19" cy="12" r="1.4"></circle>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"></path><path d="M14 6l4 4"></path>',
    pin: '<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z"></path>',
    close: '<path d="M6 6l12 12M18 6 6 18"></path>',
    plus: '<path d="M12 5v14M5 12h14"></path>',
    left: '<path d="M15 6l-6 6 6 6"></path>',
    right: '<path d="M9 6l6 6-6 6"></path>',
    down: '<path d="M6 9l6 6 6-6"></path>',
    chevron: '<path d="M9 6l6 6-6 6"></path>'
  };

  function icon(name, size, color) {
    var s = size || 22;
    var c = color || 'currentColor';
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="' + c +
      '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || '') + '</svg>';
  }

  /* ---------- 底部导航 ---------- */
  var NAV = [
    { key: 'home', label: '首页', page: 'home.html', icon: 'home' },
    { key: 'flow', label: '流水', page: 'flow.html', icon: 'flow' },
    { key: 'plan', label: '排表', page: 'plan.html', icon: 'plan' },
    { key: 'calendar', label: '日历', page: 'calendar.html', icon: 'calendar' },
    { key: 'more', label: '更多', page: 'more.html', icon: 'more' }
  ];

  function nav(current) {
    return '<nav class="nav" aria-label="底部导航">' + NAV.map(function (n) {
      var on = n.key === current;
      return '<a href="' + url(n.page) + '"' + (on ? ' class="on" aria-current="page"' : '') + '>' +
        icon(n.icon) + '<span>' + n.label + '</span></a>';
    }).join('') + '</nav>';
  }

  /** 渲染整个手机外壳 */
  function shell(opts) {
    var o = opts || {};
    document.body.innerHTML =
    '<div class="phone' + (o.tall ? ' phone--tall' : '') + '">' +
      '<div class="scroll' + (o.tight ? ' scroll--tight' : '') + '" id="scroll"></div>' +
      (o.nav ? nav(o.nav) : '') +
      '</div>';
    startPWA();
    return document.getElementById('scroll');
  }

  /* ---------- 弹出页骨架 ---------- */
  function sheet(opts) {
    var o = opts || {};
    var pad = o.maskPad || 'short';
    var mask = document.createElement('div');
    mask.className = 'sheet-mask sheet-mask--' + pad;
    mask.id = 'sheet';
    mask.innerHTML =
      '<div class="sheet">' +
      '<div class="sheet-grip"></div>' +
      '<div class="topbar topbar--center">' +
      '<h2>' + (o.title || '') + '</h2>' +
      '<a class="icon-btn icon-btn--flat" href="' + (o.close || '#') + '" aria-label="关闭">' + icon('close', 18) + '</a>' +
      '</div>' +
      '<div id="sheetBody" class="stack" style="gap:16px"></div>' +
      '</div>';
    var phone = document.querySelector('.phone');
    phone.appendChild(mask);
    return document.getElementById('sheetBody');
  }

  /* ---------- 查询参数 ---------- */
  function qs(key) {
    var m = new RegExp('[?&]' + key + '=([^&]*)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function qsNum(key) {
    var v = qs(key);
    return v === '' ? null : Number(v);
  }

  /** 跳转并带上参数 */
  function go(page, params) {
    var q = [];
    for (var k in params) {
      if (params[k] === '' || params[k] == null) continue;
      q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
    location.href = url(page) + (q.length ? '?' + q.join('&') : '');
  }

  function back(fallback) {
    if (history.length > 1) history.back();
    else location.href = url(fallback || 'home.html');
  }

  /* ---------- 格式化 ---------- */
  var money = Calc.money;
  var num = Calc.num;

  function signed(v) {
    return (v < 0 ? '−' : '−') + Calc.num(Math.abs(v));
  }

  function signedPlus(v) {
    return (v < 0 ? '−' : '+') + Calc.num(Math.abs(v));
  }

  /* ---------- 小组件 ---------- */
  function tile(k, v, prefix) {
    return '<div class="tile"><div class="k">' + k + '</div><div class="v">' +
      (prefix ? '<span class="tile__p">' + prefix + '</span>' : '') + v + '</div></div>';
  }

  function tag(text, tone, wide) {
    return '<span class="tag' + (tone ? ' tag--' + tone : '') + (wide ? ' tag--wide' : '') + '">' + text + '</span>';
  }

  /** 条件项/排定项行：整行不可点，只有编辑图标可点（规格第 8 节） */
  function itemRow(opts) {
    var o = opts;
    var edit = '<button type="button" class="item-row__edit" data-edit="' + o.id + '" aria-label="编辑' +
      esc(o.name) + '">' + icon('edit', 16) + '</button>';
    var pin = '';
    if (o.pinnable) {
      pin = '<button type="button" class="item-row__pin' + (o.pinned ? ' on' : '') + '" data-pin="' + o.id +
        '" aria-label="置顶' + esc(o.name) + '" aria-pressed="' + (o.pinned ? 'true' : 'false') + '">' +
        icon('pin', 18) + '</button>';
    }
    var amount = (o.amount == null) ? '<span class="item-row__amt muted">待定</span>'
      : '<span class="item-row__amt">' + Calc.num(o.amount) + '</span>';
    var badge = o.badge ? tag(o.badge, o.badgeTone, true) : (o.label ? tag(o.label, '', true) : '');
    return '<div class="item-row">' +
      '<div class="item-row__name" style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">' +
      '<span class="item-row__name">' + esc(o.name) + '</span>' + amount + edit + badge + '</div>' +
      (o.pinnable ? pin : '') +
      '</div>';
  }

/** 柱状图：虚线为底线，低于底线的柱子用橙色
      几何要点（实测踩过的坑）：
        · 柱子和虚线必须在同一个坐标系里 —— 都用「距容器底多少 px」。
        · 柱子不能靠 flex 撑开。之前的写法是 .bar 里放「数字 + 柱子」，
          数字 15px + gap 2px + 柱子 62px = 79px > 容器 76px，
          flex-end 把柱子整体往上顶了 3px，于是柱子比虚线高出 3px，
          看起来就像「柱子画在虚线下面」。
        · 容器有 border-bottom: 1px，content box 底和 border box 底差 1px。
          所以柱子和虚线都用 position:absolute + bottom 定位，
          都相对 padding box，天然对齐，不受 border 和 flex 影响。 */
  var BAR_PLOT = 78;    // 绘图区总高（px），正数区 + 负数区合起来
  var BAR_LABEL = 18;   // 数值标签预留高度

  function barChart(rows, floor) {
    var vals = rows.map(function (r) { return r.low; });
    var maxPos = Math.max.apply(null, vals.concat([floor, 0]));
    var maxNeg = Math.max.apply(null, vals.map(function (v) { return -v; }).concat([0]));  // 负数的绝对值

    /* 正负比例尺一致（第 8 节）：正数区和负数区用**同一个 scale**，
       所以 ¥38.53 的负柱和 ¥2105 的正柱在图上是同一把尺子，可以直接比高低。
       scale = 绘图区高 / (最大正数 + 最大负数绝对值)
       —— 没有任何负数时退化成 BAR_PLOT / maxPos，正数区正好占满，和以前一样。
       0 线的高度 = 最大负数 × scale，也就是负数区实际需要占的位置。 */
    var scale = BAR_PLOT / Math.max(1, maxPos + maxNeg);
    var zeroY = maxNeg * scale;             // 0 线距容器底

    function upH(v) { return Math.max(0, v) * scale; }       // 正数柱高（0 线往上）
    function downH(v) { return Math.max(0, -v) * scale; }    // 负数柱深（0 线往下）

    /* .bars__line / .bars__zero 都用 border-top 画，bottom 定位的是元素下沿，
       线本体在 border 的**上沿** = bottom + 1px，所以要减 1px */
    var floorY = zeroY + upH(floor) - 1;

    var bars = rows.map(function (r) {
      var v = r.low;
      var neg = v < 0;                        // 负数是更严重的情况，单独红色
      var low = v < floor && !neg;            // 介于 0 和底线之间，橙色
      var label = (neg ? '−' : '') + shortNum(Math.abs(v));   // 负号用排版减号，和数字对齐
      var d, labelStyle, barStyle, labelCls, barCls;
    if (neg) {
        /* 正负同一把尺子，所以这里**不能**加最小高度保底 ——
           38.53 和 2105.32 的比例必须原样反映在图上。
           柱子太细看不见时，靠 0 线上方的红色标签和红字提示传达。 */
        d = downH(v);
        /* bottom 是「距容器底多少 px」，负数柱在 0 线**下方**，
           所以要从 zeroY 往下减：bottom = zeroY - d */
        barStyle = 'height:' + d.toFixed(2) + 'px;bottom:' + (zeroY - d).toFixed(2) + 'px';
        var inside = d >= 17;
        /* 柱子够高就把标签内嵌在柱子里（白字，不被 0 线遮）；
           柱子太矮（比例尺一致时负数常常很矮）就放到 0 线上方 3px，
           用红色粗字。**不能放柱子下方** —— 绘图区底就是容器底，会溢出。 */
        labelStyle = inside
          ? 'bottom:' + (zeroY - d + 2).toFixed(2) + 'px'
          : 'bottom:' + (zeroY + 3).toFixed(2) + 'px';
        labelCls = ' neg' + (inside ? ' neg--in' : '');
        barCls = ' neg';
  } else {
        d = upH(v);
        barStyle = 'height:' + d.toFixed(2) + 'px;bottom:' + zeroY.toFixed(2) + 'px';
     labelStyle = 'bottom:' + (zeroY + d + 3).toFixed(2) + 'px';   // 标签在柱子上方
  labelCls = low ? ' low' : '';
        barCls = low ? ' low' : '';
   }
      return '<div class="bar">' +
        '<span class="bar__n' + labelCls + '" style="' + labelStyle + '">' + label + '</span>' +
        '<div class="bar__b' + barCls + '" style="' + barStyle + '"></div>' +
        '</div>';
    }).join('');

    return '<div class="bars' + (maxNeg > 0 ? ' bars--has-neg' : '') +
        '" style="grid-template-columns:repeat(' + rows.length + ',minmax(0,1fr));height:' +
        (BAR_PLOT + BAR_LABEL) + 'px">' +
      '<div class="bars__line" style="bottom:' + floorY.toFixed(2) + 'px"></div>' +
      (maxNeg > 0 ? '<div class="bars__zero" style="bottom:' + (zeroY - 1).toFixed(2) + 'px"></div>' : '') +
      bars + '</div>' +
      '<div class="bar-labels" style="grid-template-columns:repeat(' + rows.length + ',minmax(0,1fr))">' +
      rows.map(function (r) { return '<span>' + r.shortLabel + '</span>'; }).join('') +
      '</div>';
  }

  function shortNum(v) {
    var a = Math.abs(v);
    if (a >= 1000) return Math.round(v);
    if (a >= 100) return String(Math.round(v));
    if (Number.isInteger(v)) return String(v);
    return String(Math.round(v * 10) / 10);
  }

  /* ---------- 转义 ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  var pwaStarted = false;

  /** PWA 只启动一次：注册 SW + 申请持久存储 + 注入 PNG 图标。
      放在 toast 里惰性触发 —— 每个页面都会调 toast，等于全站都覆盖到，
      又不用在 14 个 html 里各写一遍。 */
  function startPWA() {
    if (pwaStarted) return;
    pwaStarted = true;
    registerSW();
    requestPersistentStorage();
    injectPNGIcons();
  }

  /**
   * 注入 PNG 版图标。
   * manifest 里放的是 SVG（纯文本，能随源码提交）。但 favicon 和
   * apple-touch-icon 用 SVG 支持不好 —— iOS 尤其不认 SVG。
   * 所以这里把 png-data.js 里的 base64 转成 blob URL 注入 <link>，
   * 拿到的是**真 PNG**。
   */
  function injectPNGIcons() {
    if (typeof IconData === 'undefined' || typeof iconBlobURL !== 'function') return;
    var items = [
      { file: 'favicon-64.png', rel: 'icon', sizes: '64x64' },
      { file: 'icon-192.png', rel: 'apple-touch-icon', sizes: '192x192' },
      { file: 'icon-512.png', rel: 'apple-touch-icon', sizes: '512x512' },
      { file: 'icon-192.png', rel: 'icon', sizes: '192x192' },
      { file: 'icon-512.png', rel: 'icon', sizes: '512x512' }
    ];
    items.forEach(function (it) {
      var b64 = IconData[it.file];
      if (!b64) return;
      var url = iconBlobURL(b64);
      if (!url) return;
      var l = document.createElement('link');
      l.rel = it.rel;
      l.setAttribute('sizes', it.sizes);
      l.href = url;
      document.head.appendChild(l);
    });
  }

  function toast(msg) {
    startPWA();
    var old = document.getElementById('toast');
    if (old) old.remove();
    var d = document.createElement('div');
    d.id = 'toast';
    d.textContent = msg;
    d.style.cssText = 'position:absolute;left:50%;bottom:96px;transform:translateX(-50%);' +
      'background:rgba(30,43,69,.92);color:#fff;font-size:14px;padding:10px 18px;border-radius:999px;' +
      'z-index:99;max-width:86%;text-align:center;line-height:1.4';
    document.querySelector('.phone').appendChild(d);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { d.remove(); }, 2200);
  }

  /* ---------- 导出下载 ---------- */
  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function exportFilename(state) {
    var d = state.today;
    return '随记-' + d + '.json';
  }

  /* ==================================================================
   * PWA：Service Worker 注册、新版本提示、持久存储
   * ================================================================== */

  /* 第 4 条：向浏览器申请持久存储，降低被系统清理的风险 */
  function requestPersistentStorage() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(false);
      // 先问是否已经持久化了
      if (navigator.storage.persisted) {
        return navigator.storage.persisted().then(function (already) {
          return already ? true : navigator.storage.persist();
        }).catch(function () { return false; });
      }
      return Promise.resolve(false);
    } catch (e) { return Promise.resolve(false); }
  }

  function isPersisted() {
    try {
      if (navigator.storage && navigator.storage.persisted) {
        return navigator.storage.persisted().catch(function () { return false; });
      }
    } catch (e) { /* noop */ }
    return Promise.resolve(false);
  }

  /* 第 3 条：注册 SW；拿到新版本时弹「有新版本，点此刷新」 */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // file:// 打开时不能用 SW（手机上不会这样，但电脑上直接双击 html 会）
    if (location.protocol === 'file:') return;

    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register(abs('sw.js')).then(function (reg) {
      /* 有新版本装好了：提示用户刷新 */
      if (reg.waiting) showUpdateBar(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(sw);
        });
      });
      // 每小时检查一次有没有新版本
      setInterval(function () { reg.update().catch(function () {}); }, 3600000);
    }).catch(function () { /* 注册失败不影响使用，只是不能离线 */ });

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController) showUpdateBar();
    });
  }

  /* 新版本提示条：点一下就刷新。没点就一直留着，不打断记账。 */
  function showUpdateBar(sw) {
    if (document.getElementById('updateBar')) return;
    var bar = document.createElement('div');
    bar.id = 'updateBar';
    bar.style.cssText = 'position:absolute;left:12px;right:12px;bottom:88px;z-index:98;' +
      'background:rgba(30,43,69,.95);color:#fff;border-radius:14px;padding:11px 14px;' +
      'display:flex;align-items:center;gap:10px;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.2)';
    bar.innerHTML = '<span style="flex:1">有新版本，点此刷新</span>' +
      '<button type="button" style="background:#fff;color:#1E2B45;border:none;border-radius:999px;' +
      'padding:7px 15px;font-size:14px;font-weight:600;cursor:pointer">刷新</button>';
    bar.querySelector('button').addEventListener('click', function () {
      if (sw) sw.postMessage({ type: 'SKIP_WAITING' });
      location.reload();
    });
    var phone = document.querySelector('.phone') || document.body;
    phone.appendChild(bar);
  }

  /* ---------- 小工具 ---------- */
  /**
   * 事件委托。**同一个 root 上同一个 (selector, event) 只绑一次**，
   * 重复调用会覆盖旧 handler 而不是叠加监听器。
   *
   * 为什么必须这样：页面普遍是「render() 重建 innerHTML + 重新绑事件」的写法，
   * 而 root 容器（#scroll / #sheet）在整个生命周期里是同一个 DOM 节点。
   * 如果每次 render 都 addEventListener，旧监听器会一直留着，
   * 点一次保存就会触发 N 次回调 —— 记一笔会记成 N 笔，属于数据损坏。
   */
  function on(root, selector, event, handler) {
    if (!root.__uiHandlers) root.__uiHandlers = {};
    var key = event + ' ' + selector;
    if (root.__uiHandlers[key]) {
      // 已绑过：只替换 handler，不再 addEventListener
      root.__uiHandlers[key] = handler;
      return;
    }
    root.__uiHandlers[key] = handler;
    root.addEventListener(event, function (e) {
      var t = e.target.closest(selector);
      if (t && root.contains(t)) root.__uiHandlers[key](t, e);
    });
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function setHTML(el, html) {
    el.innerHTML = html;
    return el;
  }

  function statusText(s) {
    return { work: '班', rest: '休', night: '晚', travel: '出行', unset: '未排' }[s] || '';
  }

  function statusClass(s) {
    return { work: 'day--work', rest: 'day--rest', night: 'day--night', travel: 'day--travel', unset: 'day--unset' }[s] || 'day--unset';
  }

  function remindText(list) {
    var t = (list || []).map(function (m) { return m >= 1440 ? '提前 1 天' : '提前 1 小时'; });
    return t.length ? '提醒：' + t.join('、') : '不提醒';
  }

  /* ---------- 保存失败提示 ----------
   * 写不进 localStorage 时，刚才的改动只在这个页面的内存里，
   * 一跳页面或关掉就没了（连「更多」页都去不了，去了就是重新读盘）。
   * 所以就地给一次机会：直接在这里下载一份当前账目。
   * 一个页面只提示一次，免得连续弹窗。 */
  var writeErrorShown = false;
  function handleWriteError() {
    if (writeErrorShown) return;
    writeErrorShown = true;
    var ok = confirm('⚠ 保存失败：手机存储可能满了或被限制，刚才的改动没有存进去。\n\n' +
      '点「确定」立刻下载一份当前账目备份（包含刚才的改动），\n' +
      '然后清理手机存储空间，再到「更多 → 导入 JSON」导回来。\n\n' +
      '下载前不要切换页面。');
    if (!ok) return;
    try {
      var s = Store.state();
      download('记账-紧急备份-' + s.today + '.json', Store.exportJSON());
    } catch (e) {
      alert('下载失败：' + (e && e.message ? e.message : e));
    }
  }
  if (typeof Store !== 'undefined' && Store.onWriteError) Store.onWriteError(handleWriteError);

  // 测试页面使用独立固定数据；正式页面在读取账目后自动记当天到期的订阅。
  if (typeof Store !== 'undefined' && !/tests\.html$/.test(location.pathname)) {
    registerSW();
    requestPersistentStorage();
    try {
      Store.recordDueSubscriptions();
      setInterval(function () {
        try {
          var due = Store.recordDueSubscriptions();
          if (due.recorded.length && Store.lastWriteOk()) {
            if (/\/(home|plan|flow|more)\.html$/.test(location.pathname)) location.reload();
            else toast('今天到期的订阅已自动记账');
          }
        } catch (e) { /* 保留正在编辑的表单，不自动跳页 */ }
      }, 60000);
    } catch (e) {
      var root = document.getElementById('scroll') || document.getElementById('sheet') || document.body;
      root.innerHTML = '<section class="card"><h2>账目升级已停止</h2><p>' + esc(e.message) + '</p><button type="button" class="btn btn--block" id="recoverOriginal">导出未覆盖的原始账目</button><button type="button" class="btn btn--outline btn--block" id="retryUpgrade">重试</button></section>';
      root.querySelector('#recoverOriginal').onclick = function () {
        download('记账-升级前原始数据.json', localStorage.getItem(Store.KEY) || '');
      };
      root.querySelector('#retryUpgrade').onclick = function () { location.reload(); };
    }
  }

  return {
    base: base, url: url, abs: abs,
    icon: icon, nav: nav, shell: shell, sheet: sheet,
    qs: qs, qsNum: qsNum, go: go, back: back,
    money: money, num: num, signed: signed, signedPlus: signedPlus,
    tile: tile, tag: tag, itemRow: itemRow, barChart: barChart, shortNum: shortNum,
    esc: esc, toast: toast, download: download, exportFilename: exportFilename,
    on: on, $: $, $$: $$, setHTML: setHTML,
    statusText: statusText, statusClass: statusClass, remindText: remindText,
    /* PWA */
    registerSW: registerSW,
    requestPersistentStorage: requestPersistentStorage,
    isPersisted: isPersisted,
    showUpdateBar: showUpdateBar,
    NAV: NAV
  };
})();
