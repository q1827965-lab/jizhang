/*!
 * store.js —— 数据层
 * 职责：造初始数据（第 16 节）、读写 localStorage、提供增删改查。
 * 本文件是唯一允许碰 localStorage 的地方（calc.js 完全不知道存储的存在）。
 *
 * 数据安全（第 8 条）：
 *  · SCHEMA_VERSION 是数据结构版本号。每次改动数据结构 +1，
 *    并在 upgrade() 里加一条从旧版升到新版的转换。
 *  · 打开 App 时先检查版本，如果发现旧数据，先自动导出一份原始 JSON 备份
 *    （存到 localStorage 的备份槽，也会提示用户下载），再转换成新格式。
 *  · 任何情况下都不丢旧数据。
 */
var Store = (function () {
  'use strict';

  var KEY = 'ledger-v1';           // 正式版数据键
  var BACKUP_KEY = 'ledger-v1-auto-backup';   // 自动备份槽（每次结构升级覆盖一次）
  var BACKUP_HISTORY_KEY = 'ledger-v1-backups'; // 自动备份历史（最多存 5 份）
  var SCHEMA_VERSION = 2;          // 数据结构版本号

  /* ---------- 今天的日期 ---------- */
  function realToday() {
    var d = new Date();
    return d.getFullYear() + '-' + Calc.pad2(d.getMonth() + 1) + '-' + Calc.pad2(d.getDate());
  }

  /** 试用版从安装当天开始，不再有 Demo 数据基准日 */
  function today() { return realToday(); }

  /* ==================================================================
   * 初始数据（规格第 16 节）
   * ================================================================== */
  function defaultCategories() {
    return [
      { id: 'c-food', name: '吃喝', children: [
        { id: 'c-food-main', name: '正餐', defaultEnvelope: 'food' },
        { id: 'c-food-takeout', name: '外卖（计次）', counted: 'takeout' },
        { id: 'c-food-snack', name: '零食', defaultEnvelope: 'free' },
        { id: 'c-food-fruit', name: '水果', defaultEnvelope: 'other' }
      ] },
      { id: 'c-trans', name: '交通出行', children: [
        { id: 'c-trans-taxi', name: '打车（计次）', counted: 'taxi' },
        { id: 'c-trans-need', name: '必要出行', defaultEnvelope: 'other' }
      ] },
      { id: 'c-life', name: '生活', children: [
        { id: 'c-life-daily', name: '日用', defaultEnvelope: 'other' },
        { id: 'c-life-med', name: '医疗', defaultEnvelope: 'other' },
        { id: 'c-life-cloth', name: '必要衣物', defaultEnvelope: 'other' },
        { id: 'c-life-gift', name: '人情', defaultEnvelope: 'other' }
      ] },
      { id: 'c-fix', name: '固定缴费', children: [
        { id: 'c-fix-sub', name: '订阅', defaultEnvelope: 'sub' },
        { id: 'c-fix-phone', name: '话费', defaultEnvelope: 'sub' }
      ] },
      { id: 'c-hobby', name: '爱好与想要', children: [
        { id: 'c-hobby-wh', name: '战锤', defaultEnvelope: 'free' },
        { id: 'c-hobby-extra', name: '非必要', defaultEnvelope: 'free' }
      ] }
    ];
  }

  function defaultSettings() {
    return {
      envelopes: { food: 1050, sub: 645, mobility: 825, mobilityOther: 400, free: 570 },
      taxi: { price: 25, surplus: 4, unassignedWeekNightShifts: 3 },
      takeout: { perCycle: 4 },
      warn: { mealDaily: 25, mobilityOther: [80, 100] },
      plan: { floor: 200, abcBuffer: 350, worstPaydayFallback: 15, coldThreshold: 255, coldDays: 1 },
      emergency: { target: 10000, perCycle: 500 },
      review: { overspendCycles: 2, bigSurplusPct: 30 },
      calendar: { teachingWeek: 5, teachingWeekAnchor: '2026-10-05' }
    };
  }

  /** 规格 16.1：日历排班为空，由用户自己填 */
  function defaultCalendar() {
    return {};
  }

  /** 规格 16.1：不放任何示例出行 */
  function defaultTrips() {
    return [];
  }

  /** 规格 16.1：不放任何示例事项 */
  function defaultEvents() {
    return [];
  }

  /**
   * 初始状态 = **空的**（试用版）。
   * 没有余额、没有排表项、没有流水、没有定期存单、没有应急金余额，
   * 只有设置项默认值和分类表 —— 这两样是 App 运行必须的，不算账目。
   * 第一次用的时候通过「更多 → 导入 JSON」把真实账目导进来。
   */
  function initialState() {
    var t = today();
    return {
      version: SCHEMA_VERSION,
      createdAt: t,
      today: t,
      accounts: {
        cangzhe: 0,     // 支付宝「攒着」
        abc: 0,         // 农行
        icbc: 0,        // 工行，工资卡
        goal: 0,        // 目标账户
        deposit: 0      // 定期
      },
      cycleAbcOpening: 0,
      lastPayday: '',
      lastPaydayFlowAt: '',
      paydayRecords: [],
      settings: defaultSettings(),
      categories: defaultCategories(),
      entries: [],
      planItems: [],
      calendar: {},
      trips: [],
      events: [],
      goals: [],
      deposits: [],
      emergency: { balance: 0, target: 10000, uses: [] },
      cycleHistory: [],
      boughtLog: [],
      lastExportAt: '',
      carry: { taxiUsed: 0, takeoutUsed: 0 }
    };
  }

  /* ==================================================================
   * 读取 / 保存
   * ================================================================== */

  var cache = null;
  var lastUpgrade = null;   // 本次打开时的结构升级信息，给「更多」页显示

  /**
   * 读取。流程：
   *   1. 没有数据 → 造一份空的初始状态
   *   2. 有数据但版本号比现在旧 → **先把原始数据自动备份**，再升级
   *      备份存两个地方：localStorage 的自动备份槽 + 备份历史（最多 5 份）
   *   3. 升级完写回
   * 任何一步失败都退回「用原始数据 + 补齐缺省字段」，不丢东西。
   */
  function read() {
    if (cache) return cache;
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }
    if (!raw) {
      cache = initialState();
      write(cache);
      return cache;
    }
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      // 解析失败：数据不能丢，原样存进备份槽再开新的
      pushAutoBackup(raw, 0);
      lastUpgrade = { from: '无法解析', to: SCHEMA_VERSION, at: today(), autoBackup: true };
      cache = initialState();
      write(cache);
      return cache;
    }

    var v = (typeof parsed.version === 'number') ? parsed.version : 0;
    if (v < SCHEMA_VERSION) {
      /* 旧数据：先自动备份原始 JSON，再升级 */
      pushAutoBackup(raw, v);
      var upgraded = upgrade(parsed, v);
      lastUpgrade = { from: v, to: SCHEMA_VERSION, at: today(), autoBackup: true };
      cache = upgraded;
      write(cache);
      return cache;
    }

    cache = fill(parsed);
    return cache;
  }

  /** 结构升级：从任意旧版本逐级升到当前版本。每升一级都要补齐该级新增的字段。 */
  function upgrade(s, fromV) {
    var out = fill(Calc.clone(s));
    // 逐级升级：以后 SCHEMA_VERSION 涨到 3，就在 for 循环里加 i === 2 的分支
    for (var i = fromV + 1; i <= SCHEMA_VERSION; i++) {
      if (i === 2) {
        // v1 → v2：已买记录从「只存条件项」扩展到存排表项完整快照；新增存档式备份
        out.boughtLog = (out.boughtLog || []).map(function (r) {
          var rec = Calc.clone(r);
          if (!rec.planItem) {
            rec.planItem = {          // 没有快照的旧记录，放回时按这些字段重建
              id: '', type: rec.type || 'conditional', name: rec.name || '',
              amount: Calc.nz(rec.estimate, 0), cycleKey: rec.type === 'scheduled' ? (rec.cycleKey || '') : '',
              pinned: false, buyBefore: '', note: ''
            };
          }
          return rec;
        });
      }
    }
    out.version = SCHEMA_VERSION;
    return out;
  }

  /** 补齐缺省字段，避免页面读到 undefined。不改已有数据。 */
  function fill(s) {
    var base = initialState();
    var out = Object.assign({}, base, s);
    out.settings = Object.assign({}, base.settings, s.settings || {});
    out.settings.envelopes = Object.assign({}, base.settings.envelopes, (s.settings || {}).envelopes || {});
    out.settings.taxi = Object.assign({}, base.settings.taxi, (s.settings || {}).taxi || {});
    out.settings.takeout = Object.assign({}, base.settings.takeout, (s.settings || {}).takeout || {});
    out.settings.warn = Object.assign({}, base.settings.warn, (s.settings || {}).warn || {});
    out.settings.plan = Object.assign({}, base.settings.plan, (s.settings || {}).plan || {});
    out.settings.emergency = Object.assign({}, base.settings.emergency, (s.settings || {}).emergency || {});
    out.settings.review = Object.assign({}, base.settings.review, (s.settings || {}).review || {});
    out.settings.calendar = Object.assign({}, base.settings.calendar, (s.settings || {}).calendar || {});
    out.accounts = Object.assign({}, base.accounts, s.accounts || {});
    out.emergency = Object.assign({}, base.emergency, s.emergency || {});
    out.carry = Object.assign({}, base.carry, s.carry || {});
    out.entries = s.entries || [];
    out.planItems = s.planItems || [];
    out.calendar = s.calendar || {};
    out.trips = s.trips || [];
    out.events = s.events || [];
    out.goals = s.goals || [];
    out.deposits = s.deposits || [];
    out.paydayRecords = s.paydayRecords || [];
    out.boughtLog = s.boughtLog || [];
    out.cangzheOpening = (typeof s.cangzheOpening === 'number') ? s.cangzheOpening : Calc.nz(out.accounts.cangzhe, 0);
    out.lastPayday = s.lastPayday || '';
    out.lastPaydayFlowAt = s.lastPaydayFlowAt || '';
    out.cycleHistory = s.cycleHistory || [];
    out.lastExportAt = s.lastExportAt || '';
    out.categories = s.categories && s.categories.length ? s.categories : base.categories;
    /* 「今天」默认刷新到真实日期，保证倒计时 / 教学周是真的。
       但导入了带 today 的数据（导出给随记再导入）时，以数据里带的 today 为准。 */
    out.today = s.today || today();
    out.version = SCHEMA_VERSION;
    return out;
  }

  /* ---------- 自动备份槽（第 8 条：改动结构前先把旧数据存一份） ---------- */

  function pushAutoBackup(rawText, fromVersion) {
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify({
        at: new Date().toISOString(),
        fromVersion: fromVersion,
        toVersion: SCHEMA_VERSION,
        text: rawText
      }));
    } catch (e) { /* 存不下就跳过，不能因为备份失败而挡住启动 */ }
    // 历史里再存一份，最多 5 份
    try {
      var hist = JSON.parse(localStorage.getItem(BACKUP_HISTORY_KEY) || '[]');
      if (!Array.isArray(hist)) hist = [];
      hist.unshift({ at: new Date().toISOString(), fromVersion: fromVersion, text: rawText });
      while (hist.length > 5) hist.pop();
      localStorage.setItem(BACKUP_HISTORY_KEY, JSON.stringify(hist));
    } catch (e) { /* noop */ }
  }

  /** 自动备份列表（给「更多」页展示，用户可以下载） */
  function autoBackups() {
    try {
      var hist = JSON.parse(localStorage.getItem(BACKUP_HISTORY_KEY) || '[]');
      return Array.isArray(hist) ? hist : [];
    } catch (e) { return []; }
  }

  function write(s) {
    cache = s;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* 隐私模式下写不进去也不影响本次会话 */ }
    return s;
  }

  /** 取一份可安全改的副本 */
  function state() {
    return read();
  }

  /** 外部直接写入一份完整数据（导入、测试注入种子用），会清掉内存缓存。
      注意：这里不走 migrate，所以注入的 today 等字段原样保留。 */
  /**
   * 直接塞一份数据进来（测试注入、导入旧版本文件）。
   * 关键：**照样走版本升级**，否则导入一个旧版本的文件，
   * 新代码读到缺失的字段就会出错。
   */
  function loadRaw(obj) {
    var data = obj;
    var v = (obj && typeof obj.version === 'number') ? obj.version : 0;
    if (v < SCHEMA_VERSION) {
      /* 旧版本数据：先自动备份原始内容，再升级 —— 和打开 App 时同一条路径 */
      pushAutoBackup(JSON.stringify(obj), v);
      lastUpgrade = { from: v, to: SCHEMA_VERSION, at: today(), autoBackup: true };
      data = upgrade(obj, v);
    } else {
    data = fill(Calc.clone(obj));
    }
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* noop */ }
    cache = data;
    return data;
  }

  function save(mutator) {
    var s = read();
    var next = mutator ? mutator(s) : s;
    return write(next);
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* noop */ }
    cache = null;
    return read();
  }

  /* ==================================================================
   * 业务写入
   * ================================================================== */

  function uid(prefix) {
    return (prefix || 'x') + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4).toString(36);
  }

  /** 记一笔 */
  function addEntry(draft) {
    var s = read();
    var cycle = Calc.deriveCycle(s);
    var envName = draft.envelope || Calc.defaultEnvelope(s, draft.catId, { cycle: cycle });
    var cat = Calc.findCategory(s, draft.catId);
    var date = draft.date || s.today;
    var entry = {
      id: uid('e'),
      date: date,
      time: draft.time || nowHM(),
      amount: Calc.round2(Calc.nz(draft.amount, 0)),
      catId: cat.id,
      catName: cat.name,
      cat1: cat.parent,
      envelope: envName,
      note: draft.note || ''
    };
    /* 发薪日当天的归属由用户二选一决定（第 12 节）；没选就按日期自动归属 */
    if (draft.cycleKey) entry.cycleKey = draft.cycleKey;
    var entryCycleKey = entry.cycleKey || Calc.cycleKeyForDate(s, entry.date);
    // 第 12 节：记在已结束周期的账只用于复盘，不改变当前账户余额和预测，
    // 因为那个周期的钱在发薪日对账时已经结清。
    entry.reviewOnly = (entryCycleKey !== cycle.key);
    var next = Calc.clone(s);
    next.entries = next.entries || [];
    next.entries.push(entry);
    // 账户同步：自由支配扣攒着，其余扣农行。已结束周期的账不动余额。
    if (!entry.reviewOnly) {
      if (entry.envelope === 'free') next.accounts.cangzhe = Calc.round2(Calc.nz(next.accounts.cangzhe, 0) - entry.amount);
      else next.accounts.abc = Calc.round2(Calc.nz(next.accounts.abc, 0) - entry.amount);
    }
    return { state: write(next), entry: entry };
  }

  function removeEntry(id) {
    return save(function (s) {
      var next = Calc.clone(s);
      var cycle = Calc.deriveCycle(s);
      var found = null;
      next.entries = (next.entries || []).filter(function (e) {
        if (e.id === id) { found = e; return false; }
        return true;
      });
      if (found) {
        var k = found.cycleKey || Calc.cycleKeyForDate(s, found.date);
        // 同样是已结束周期的账，余额当初就没扣过，删掉也不用还
        if (k === cycle.key) {
          if (found.envelope === 'free') next.accounts.cangzhe = Calc.round2(Calc.nz(next.accounts.cangzhe, 0) + found.amount);
          else next.accounts.abc = Calc.round2(Calc.nz(next.accounts.abc, 0) + found.amount);
        }
      }
      return next;
    });
  }

  function nowHM() {
    var d = new Date();
    return Calc.pad2(d.getHours()) + ':' + Calc.pad2(d.getMinutes());
  }

  /** 排表项目增删改 */
  function upsertPlanItem(item) {
    return save(function (s) {
      var next = Calc.clone(s);
      next.planItems = next.planItems || [];
      var id = item.id || uid('p');
      var rec = {
        id: id,
        type: item.type === 'conditional' ? 'conditional' : 'scheduled',
        name: item.name || '未命名',
        amount: (item.amount === '' || item.amount == null) ? null : Calc.round2(Calc.nz(item.amount, 0)),
        cycleKey: item.cycleKey || next.cycleKey || Calc.deriveCycle(next).key,
        pinned: !!item.pinned,
        buyBefore: item.buyBefore || '',
        note: item.note || '',
        removed: false
      };
      var idx = -1;
      for (var i = 0; i < next.planItems.length; i++) if (next.planItems[i].id === id) idx = i;
      if (idx >= 0) next.planItems[idx] = rec; else next.planItems.push(rec);
      return next;
    });
  }

  /**
   * 移除排表项（第 8 节「已买记录」）。
   * 排定项和条件项都算：转成支出时写一条已买记录。
   * 记录里存一份**排表项的完整快照**（planItem），
   * 删除这笔支出选「放回排表」时按快照原样恢复：
   * 原 id、置顶状态、「希望在某周期前买到」等全部字段都回到原样。
   * 转成支出只有两条路：「已经买了」和记一笔的排表匹配检查确认，
   * 两边都要传 opt.bought = true 才会写记录。
   */
  function removePlanItem(id, opt) {
    return save(function (s) {
      var next = Calc.clone(s);
      var found = null;
      next.planItems = (next.planItems || []).filter(function (it) {
        if (it.id === id) { found = it; return false; }
        return true;
      });
      if (found && opt && opt.bought) {
        next.boughtLog = next.boughtLog || [];
        var rec = {
          id: uid('bl'),
          name: found.name,
          type: found.type,                                    // 排定项 / 条件项
          estimate: found.amount,                              // 排表里的估计金额
          actual: (opt.amount != null && isFinite(opt.amount)) ? Calc.round2(opt.amount) : found.amount,
          cycleKey: opt.cycleKey || Calc.deriveCycle(next).key,
          date: opt.date || next.today,
          entryId: opt.entryId || '',   // 关联的流水 id
          /* 排表项完整快照：放回排表时按它原样恢复 */
          planItem: Calc.clone(found)
        };
        next.boughtLog.push(rec);
        if (opt.entryId) linkEntry(next, opt.entryId, rec.id);
      }
      return next;
    });
  }

  /** 把已买记录挂到对应的流水上（删除支出时才知道要不要放回排表） */
  function linkEntry(s, entryId, boughtId) {
    for (var i = 0; i < (s.entries || []).length; i++) {
      if (s.entries[i].id === entryId) { s.entries[i].boughtId = boughtId; return; }
    }
  }

  /** 找出某笔支出对应的已买记录 */
  function boughtRecordOf(state, entryId) {
    var log = state.boughtLog || [];
    for (var i = 0; i < log.length; i++) {
      if (log[i].entryId === entryId) return log[i];
    }
    // 兼容早期只按 id 挂的
    for (var j = 0; j < (state.entries || []).length; j++) {
      if (state.entries[j].id === entryId && state.entries[j].boughtId) {
        for (var k = 0; k < log.length; k++) if (log[k].id === state.entries[j].boughtId) return log[k];
      }
    }
    return null;
  }

  /**
   * 把一笔支出「放回排表」（第 8 节）：删掉已买记录并**原样恢复**排表项。
   * 按已买记录里的 planItem 快照恢复 —— 原 id、置顶状态、
   * 「希望在某周期前买到」等全部字段都回到原样。
   * 只有周期按规则调整：条件项回待买（cycleKey 清空，照常排队）；
   * 排定项原周期没过用原周期，过了放当前周期（已经到期该付了）。
   */
  function restoreToPlan(entryId, opt) {
    return save(function (s) {
      var next = Calc.clone(s);
      var rec = boughtRecordOf(next, entryId);
      if (!rec) return next;
      next.boughtLog = (next.boughtLog || []).filter(function (r) { return r.id !== rec.id; });
      next.entries = (next.entries || []).map(function (e) {
        if (e.id !== entryId) return e;
        var c = Calc.clone(e);
        delete c.boughtId;
        return c;
      });
      next.planItems = next.planItems || [];

      /* 优先按快照原样恢复；没有快照的旧数据退回按记录字段重建 */
      var item = rec.planItem ? Calc.clone(rec.planItem) : {
        id: uid('p'),
        type: rec.type,
        name: rec.name,
        amount: rec.estimate,
        pinned: false,
        buyBefore: '',
        note: ''
      };

      // 金额用实际金额（买的时候可能和估计的不一样）
      if (opt && opt.amount != null && isFinite(opt.amount)) {
        item.amount = Calc.round2(opt.amount);
      } else if (opt && opt.keepEstimate) {
        item.amount = rec.estimate;
      }

      /* 周期按规则调整 */
      if (item.type === 'scheduled') {
        var cur = Calc.deriveCycle(next).key;
        var target = item.cycleKey || rec.cycleKey || cur;
        // monthsBetween(cur, target) 为负 = target 在 cur 之前 = 原周期已经过了
        if (Calc.monthsBetweenKeys(cur, target) < 0) item.cycleKey = cur;
        else item.cycleKey = target;
      } else {
        item.cycleKey = '';        // 条件项放回待买，照常按置顶和金额排队
      }

      // 同 id 已经存在（理论上不会）就替换，避免排表里出现两项同名
      var replaced = false;
      for (var i = 0; i < next.planItems.length; i++) {
        if (next.planItems[i].id === item.id) { next.planItems[i] = item; replaced = true; break; }
      }
      if (!replaced) next.planItems.push(item);

      return next;
    });
  }

  function togglePin(id) {
    return save(function (s) {
      var next = Calc.clone(s);
      (next.planItems || []).forEach(function (it) { if (it.id === id) it.pinned = !it.pinned; });
      return next;
    });
  }

  /** 买不买 → 放进排表 */
  function addFromVerdict(v) {
    return save(function (s) {
      var next = Calc.clone(s);
      next.planItems = next.planItems || [];
      next.planItems.push({
        id: uid('p'),
        type: v.addAs === 'scheduled' ? 'scheduled' : 'conditional',
        name: v.name || '未命名',
        amount: Calc.round2(Calc.nz(v.amount, 0)),
        cycleKey: v.addAs === 'scheduled' ? (v.cycleKey || Calc.nextCycleKeys(Calc.deriveCycle(next).key, 1)[0]) : '',
        pinned: false,
        buyBefore: '',
        note: ''
      });
      return next;
    });
  }

  /** 日历：点日期依次切换 上班 → 休息 → 晚班 → 出行 → 未排（第 11 节） */
  var CYCLE_STATUS = ['work', 'rest', 'night', 'travel', 'unset'];

  function cycleDayStatus(dateStr) {
    return save(function (s) {
      var next = Calc.clone(s);
      next.calendar = next.calendar || {};
      var cur = Calc.dayStatus(next, dateStr);
      // 出行由 trips 决定，点到下一档是「未排」：先把该日从 trips 里摘掉
      if (cur === 'travel') {
        next.trips = (next.trips || []).filter(function (t) { return !(dateStr >= t.start && dateStr <= t.end); });
        delete next.calendar[dateStr];
        return next;
      }
      // 没排班过也从「上班」开始切
      var idx = CYCLE_STATUS.indexOf(cur);
      if (idx < 0) idx = CYCLE_STATUS.length - 1;   // 停在「未排」，下一档回到「上班」
      var nextStatus = CYCLE_STATUS[(idx + 1) % CYCLE_STATUS.length];
      if (nextStatus === 'travel') {
        // 出行：把这一天单独记成 1 天出行
        next.trips = (next.trips || []).filter(function (t) { return !(dateStr >= t.start && dateStr <= t.end); });
        next.trips.push({ id: uid('tr'), title: '出行', start: dateStr, end: dateStr, note: '' });
        delete next.calendar[dateStr];
        return next;
      }
      // 未排：从 calendar 里删掉这个键，表示没排班
      if (nextStatus === 'unset') delete next.calendar[dateStr];
      else next.calendar[dateStr] = nextStatus;
      return next;
    });
  }

  function addEvent(ev) {
    return save(function (s) {
      var next = Calc.clone(s);
      next.events = next.events || [];
      next.events.push({
        id: uid('ev'),
        date: ev.date || next.today,
        time: ev.time || '09:00',
        title: ev.title || '新事项',
        remind: ev.remind || [],
        note: ev.note || ''
      });
      next.events.sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; });
      return next;
    });
  }

  function addTrip(t) {
    return save(function (s) {
      var next = Calc.clone(s);
      next.trips = next.trips || [];
      next.trips.push({
        id: uid('tr'),
        title: t.title || '出行',
        start: t.start || next.today,
        end: t.end || t.start || next.today,
        note: t.note || ''
      });
      return next;
    });
  }

  function removeById(listName, id) {
    return save(function (s) {
      var next = Calc.clone(s);
      next[listName] = (next[listName] || []).filter(function (x) { return x.id !== id; });
      return next;
    });
  }

  /** 大目标 */
  function upsertGoal(g) {
    return save(function (s) {
      var next = Calc.clone(s);
      next.goals = next.goals || [];
      var id = g.id || uid('g');
      var rec = {
        id: id,
        name: g.name || '新目标',
        target: Calc.round2(Calc.nz(g.target, 0)),
        saved: Calc.round2(Calc.nz(g.saved, 0)),
        cycleKey: g.cycleKey || Calc.addMonthsKey(Calc.deriveCycle(next).key, 6),
        order: Calc.nz(g.order, next.goals.length + 1)
      };
      var idx = -1;
      for (var i = 0; i < next.goals.length; i++) if (next.goals[i].id === id) idx = i;
      if (idx >= 0) next.goals[idx] = rec; else next.goals.push(rec);
      return next;
    });
  }

  /** 绩效到账 */
  function addBonus(amount) {
    return save(function (s) {
      var next = Calc.clone(s);
      var plan = Calc.allocateBonus(next, amount);
      plan.toGoal.forEach(function (t) {
        (next.goals || []).forEach(function (g) {
          if (g.id === t.id) g.saved = Calc.round2(Calc.nz(g.saved, 0) + t.amount);
        });
        next.accounts.goal = Calc.round2(Calc.nz(next.accounts.goal, 0) + t.amount);
      });
      if (plan.toDeposit > 0) {
        next.deposits = next.deposits || [];
        next.deposits.push(Calc.makeDeposit(next, plan.toDeposit, next.today));
        next.accounts.deposit = Calc.round2(Calc.nz(next.accounts.deposit, 0) + plan.toDeposit);
      }
      if (plan.toCangzhe > 0) next.accounts.cangzhe = Calc.round2(Calc.nz(next.accounts.cangzhe, 0) + plan.toCangzhe);
      return next;
    });
  }

  /** 应急金动用 */
  function useEmergency(amount, reason) {
    return save(function (s) {
      var next = Calc.clone(s);
      next.emergency = next.emergency || { balance: 0, target: 10000, uses: [] };
      next.emergency.uses = next.emergency.uses || [];
      next.emergency.uses.push({ id: uid('eu'), date: next.today, amount: Calc.round2(amount), reason: reason || '' });
      next.emergency.balance = Calc.round2(Calc.nz(next.emergency.balance, 0) - Calc.round2(amount));
      return next;
    });
  }

  /** 设置页保存 */
  function saveSettings(patch) {
    return save(function (s) {
      var next = Calc.clone(s);
      next.settings = patch;
      return next;
    });
  }

  /** 周期档案：某个周期各信封实际花了多少（复盘/导出用） */
  function cycleArchive(cycleKey) {
    var s = read();
    var env = Calc.envelopeState(s, { key: cycleKey, label: Calc.cycleLabel(cycleKey) });
    var rows = env._entries.map(function (e) {
      return {
        time: e.time, amount: e.amount, cat: e.catName, cat1: e.cat1, envelope: e.envelope, note: e.note
      };
    });
    return { cycleKey: cycleKey, entries: rows };
  }

  /** 导出给随记：生成 JSON 文本（真正下载在 ui.js 做）。
      这份 JSON 就是完整数据，既是备份、也给随记做复盘。 */
  function exportJSON() {
    var s = read();
    var payload = Calc.exportPayload(s);
    payload.exportedAt = new Date().toISOString();   // 每次导出都记下导出时间
    return JSON.stringify(payload, null, 2);
  }

  function markExported() {
    return save(function (s) {
      var next = Calc.clone(s);
      next.lastExportAt = new Date().toISOString();
      return next;
    });
  }

  /* ==================================================================
   * 导入 / 备份提醒 / 清空确认
   * ================================================================== */

  /** 导入前的「这份文件里有什么」预览，只读不写 */
  function inspectJSON(text) {
    var data = null;
    try { data = JSON.parse(text); } catch (e) {
      return { ok: false, error: '这个文件不是有效的 JSON，可能选错了或者下载不完整。' };
    }
    if (!data || typeof data !== 'object') {
      return { ok: false, error: '文件里没有账目数据。' };
    }
    var entries = Array.isArray(data.entries) ? data.entries : [];
    var planItems = Array.isArray(data.planItems) ? data.planItems : [];
    var deposits = Array.isArray(data.deposits) ? data.deposits : [];
    var goals = Array.isArray(data.goals) ? data.goals : [];
    var acc = data.accounts || {};
    var totalSpent = entries.reduce(function (a, e) { return a + (Number(e.amount) || 0); }, 0);
    return {
      ok: true,
      data: data,
      summary: {
        app: data.app || '（未知）',
        exportedAt: data.exportedAt || data.lastExportAt || '',
        version: (typeof data.version === 'number') ? data.version : 0,
        entryCount: entries.length,
        planCount: planItems.length,
        scheduledCount: planItems.filter(function (p) { return p.type === 'scheduled'; }).length,
        conditionalCount: planItems.filter(function (p) { return p.type === 'conditional'; }).length,
        boughtCount: Array.isArray(data.boughtLog) ? data.boughtLog.length : 0,
        depositCount: deposits.length,
        goalCount: goals.length,
        calendarDays: Object.keys(data.calendar || {}).length,
        totalSpent: Math.round(totalSpent * 100) / 100,
        accounts: {
          cangzhe: Number(acc.cangzhe) || 0,
          abc: Number(acc.abc) || 0,
          icbc: Number(acc.icbc) || 0,
          goal: Number(acc.goal) || 0,
          deposit: Number(acc.deposit) || 0
        },
        emergency: Number((data.emergency || {}).balance) || 0
      }
    };
  }

  /**
   * 用导入的数据覆盖当前数据。
   * **覆盖前自动把当前数据存一份备份**，即使导入错了也能退回。
   */
  function importJSON(text) {
    var cur = read();
    try { pushAutoBackup(JSON.stringify(cur), cur.version); } catch (e) { /* noop */ }
    var data = JSON.parse(text);
    cache = fill(data);
    write(cache);
    return cache;
  }

  /** 距上次备份多少天。没导出过算 0 天（= 该备份了） */
  function daysSinceBackup() {
    var s = read();
    if (!s.lastExportAt) return null;      // 从来没导过
    var then = new Date(s.lastExportAt).getTime();
    if (!then) return null;
    var now = new Date().getTime();
    return Math.floor((now - then) / 86400000);
  }

  /** 备份提醒：超过 7 天就该备份了 */
  var BACKUP_REMIND_DAYS = 7;
  function backupReminder() {
    var s = read();
    if (!s.lastExportAt) {
      return { need: true, days: null, text: '还没有导出过备份', since: s.lastExportAt };
    }
    var d = daysSinceBackup();
    if (d === null) return { need: true, days: null, text: '还没有导出过备份', since: s.lastExportAt };
    return {
      need: d >= BACKUP_REMIND_DAYS,
      days: d,
      since: s.lastExportAt,
      text: d >= BACKUP_REMIND_DAYS ? ('已经 ' + d + ' 天没导出') : ('距上次备份 ' + d + ' 天')
    };
  }

  return {
    KEY: KEY,
    today: today,
    realToday: realToday,
    initialState: initialState,
    defaultCategories: defaultCategories,
    defaultSettings: defaultSettings,
    state: state,
    loadRaw: loadRaw,
    save: save,
    reset: reset,
    write: write,
    uid: uid,
    nowHM: nowHM,
    addEntry: addEntry,
    removeEntry: removeEntry,
    upsertPlanItem: upsertPlanItem,
    removePlanItem: removePlanItem,
    boughtRecordOf: boughtRecordOf,
    restoreToPlan: restoreToPlan,
    togglePin: togglePin,
    addFromVerdict: addFromVerdict,
    cycleDayStatus: cycleDayStatus,
    addEvent: addEvent,
    addTrip: addTrip,
    removeById: removeById,
    upsertGoal: upsertGoal,
    addBonus: addBonus,
    useEmergency: useEmergency,
    saveSettings: saveSettings,
    cycleArchive: cycleArchive,
    exportJSON: exportJSON,
    markExported: markExported,
    inspectJSON: inspectJSON,
    importJSON: importJSON,
    daysSinceBackup: daysSinceBackup,
    backupReminder: backupReminder,
    autoBackups: autoBackups,
    lastUpgradeInfo: function () { return lastUpgrade; },
    BACKUP_REMIND_DAYS: BACKUP_REMIND_DAYS,
    SCHEMA_VERSION: SCHEMA_VERSION
  };
})();