/*!
 * calc.js —— 记账与现金流规划 App · 纯计算引擎
 *
 * 硬性约束（甲方要求，打包成原生 App 时本文件要原样复用）：
 *   · 零 DOM：不碰任何浏览器页面对象与元素 API
 *   · 零存储：不碰任何浏览器端持久化 API
 *   · 零全局对象：不引用任何宿主全局对象
 *   · 只接收纯数据对象（普通 JS 对象与数组），返回纯数据对象
 *
 * 约定：
 *   · 日期一律用 'YYYY-MM-DD' 字符串，避免时区问题
 *   · 金额一律用 number，运算中统一 round2，显示时再格式化
 *   · 周期以「开始发薪的月份」命名，cycleKey 形如 '2026-09'，标签 '9月周期'
 */
var Calc = (function () {
  'use strict';

  /* ==================================================================
   * 0. 基础工具
   * ================================================================== */

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** 四舍五入到两位，消除浮点尾差（84.879999999 -> 84.88） */
  function round2(n) {
    if (!isFinite(n)) return 0;
    var v = Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
    return v === 0 ? 0 : v;
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** 取值，非数字给兜底 */
  function nz(v, d) {
    return isNum(v) ? v : (d || 0);
  }

  function num(v, digits) {
    var d = digits == null ? 2 : digits;
    var s = round2(nz(v, 0)).toFixed(d);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function money(v, digits) {
    return '¥' + num(v, digits);
  }

  /** 整数显示（次数、天数） */
  function int(v) {
    return String(Math.round(nz(v, 0)));
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function sum(arr, pick) {
    var t = 0;
    for (var i = 0; i < arr.length; i++) t += nz(pick ? pick(arr[i]) : arr[i], 0);
    return round2(t);
  }

  /* ==================================================================
   * 0.5 账户与假期周期（第五轮修订）
   * ================================================================== */

  /** 账户 key → 中文名。原「攒着」已改名「余额宝」；「攒着（假期周转）」是独立的假期周转金账户 */
  var ACCOUNT_NAMES = {
    abc: '农行',
    yuebao: '余额宝',
    holiday: '攒着（假期周转）',
    icbc: '工行',
    goal: '目标账户',
    deposit: '定期',
    jiaohang: '交行（应急金）'
  };

  function accountName(key) {
    return ACCOUNT_NAMES[key] || key;
  }

  // 收入分类独立于用户已有的支出分类，不迁移或覆盖旧分类。
  function incomeCategories() {
    return [
      { id: 'c-income-salary', name: '工资', defaultEnvelope: 'income' },
      { id: 'c-income-subsidy', name: '补贴', defaultEnvelope: 'income' },
      { id: 'c-income-yield', name: '收益', defaultEnvelope: 'income' },
      { id: 'c-income-other', name: '其他收入', defaultEnvelope: 'income' }
    ];
  }

  function incomeCategory(catId) {
    var cats = incomeCategories();
    for (var i = 0; i < cats.length; i++) if (cats[i].id === catId) return cats[i];
    return null;
  }

  function entryTotals(list) {
    var income = sum(list, function (e) { return e.amount < 0 ? -e.amount : 0; });
    var expense = sum(list, function (e) { return e.amount > 0 ? e.amount : 0; });
    return { income: income, expense: expense, net: round2(income - expense) };
  }

  /**
   * 一笔流水从哪个账户出钱。
   * 普通流水按信封推（自由支配 → 余额宝，其余 → 农行）；
   * 「待核对」流水带 account 字段，拆分后各分片也沿用，保证对账基数不乱。
   */
  function entryAccount(entry) {
    if (entry && entry.account) return entry.account;
    if (entry && entry.envelope === 'emergency') return 'jiaohang';
    return (entry && entry.envelope === 'free') ? 'yuebao' : 'abc';
  }

  /** 四个花钱信封每周期合计（默认 3090） */
  function envelopeTotal(state) {
    var env = (state && state.settings && state.settings.envelopes) || {};
    return round2(nz(env.food, 1050) + nz(env.sub, 645) + nz(env.mobility, 825) + nz(env.free, 570));
  }

  /** 某个周期 key 是不是假期周期（2 月、8 月工资到账的那种，实发比平常少） */
  function isHolidayCycle(state, cycleKey) {
    var cfg = (state && state.settings && state.settings.holiday) || {};
    var list = cfg.cycles || [];
    return list.indexOf(cycleKey) >= 0 || list.indexOf(String(cycleKey).slice(5, 7)) >= 0;
  }

  /** afterKey 之后最近的一个假期周期 key；没有则返回 '' */
  function nextHolidayKey(state, afterKey) {
    var cfg = (state && state.settings && state.settings.holiday) || {};
    for (var i = 1; i <= 120; i++) {
      var key = addMonthsKey(afterKey, i);
      if (isHolidayCycle(state, key)) return key;
    }
    return '';
  }

  /** 假期周期的缺口 = 四信封合计 − 假期周期预计实发（默认 3090 − 1600 = 1490） */
  function holidayGap(state) {
    var cfg = (state && state.settings && state.settings.holiday) || {};
    return round2(Math.max(0, envelopeTotal(state) - nz(cfg.expectedSalary, 1600)));
  }

  /**
   * 订阅自动入账（第五轮）：到扣款日当天该记的订阅。
   * 月付：每月固定日号；年付：填了月份，每年那一月的那一天。
   * 已记过的不再重复记（按 autoSubId + 月份/年份去重）。
   */
  function dueSubscriptions(state, todayStr) {
    var today = todayStr || state.today;
    var subs = (state.settings && state.settings.subscriptions) || [];
    var subCatId = categoryIdsByName(state, '订阅')[0] || 'c-fix-sub';
    var out = [];
    for (var i = 0; i < subs.length; i++) {
      var sub = subs[i];
      if (!sub || !sub.name || !(nz(sub.amount, 0) > 0)) continue;
      var annual = nz(sub.month, 0) >= 1 && nz(sub.month, 0) <= 12;
      var day = Math.min(31, Math.max(1, Math.round(nz(sub.day, 1))));
      var due = false;
      if (annual) {
        due = monthKey(today) === (today.slice(0, 4) + '-' + pad2(sub.month))
          && dayOfMonth(today) === Math.min(day, daysInMonth(+today.slice(0, 4), sub.month));
      } else {
        due = dayOfMonth(today) === Math.min(day, daysInMonth(+today.slice(0, 4), +today.slice(5, 7)));
      }
      if (!due) continue;
      var exists = (state.subscriptionOccurrences || []).indexOf(sub.id + ':' + monthKey(today)) >= 0 || (state.entries || []).some(function (e) {
        if (e.autoSubId !== sub.id) return false;
        return annual
          ? String(e.date).slice(0, 4) === today.slice(0, 4)
          : monthKey(e.date) === monthKey(today);
      });
      if (exists) continue;
      out.push({
        id: sub.id,
        catId: subCatId,
        envelope: sub.envelope || 'sub',
        amount: round2(nz(sub.amount, 0)),
        note: sub.name + ' · 自动',
        date: today,
        time: '09:00',
        autoSubId: sub.id
      });
    }
    return out;
  }

  /* ==================================================================
   * 1. 日期工具（全部基于 'YYYY-MM-DD' 字符串）
   * ================================================================== */

  function parseYmd(s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0, 0);
  }

  function ymd(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function addDays(s, n) {
    var d = parseYmd(s);
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  function diffDays(a, b) {
    return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86400000);
  }

  /** 星期几，周一 = 0 … 周日 = 6 */
  function dowIndex(s) {
    return (parseYmd(s).getDay() + 6) % 7;
  }

  function weekMonday(s) {
    return addDays(s, -dowIndex(s));
  }

  function monthKey(s) {
    return String(s).slice(0, 7);
  }

  function cycleLabel(key) {
    var p = String(key).split('-');
    return (+p[1]) + '月周期';
  }

  /** 柱状图/条件项标签用的短标签：'2026-12' -> '12月' */
  function monthLabel(key) {
    var p = String(key).split('-');
    return (+p[1]) + '月';
  }

  function addMonthsKey(key, n) {
    var p = String(key).split('-');
    var d = new Date(+p[0], +p[1] - 1 + n, 1, 12);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  /** 从 startKey 起连续 n 个周期键 */
  function nextCycleKeys(startKey, n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(addMonthsKey(startKey, i + 1));
    return out;
  }

  /** aKey 到 bKey 之间相差几个月（b 在后为正） */
  function monthsBetweenKeys(aKey, bKey) {
    var a = String(aKey).split('-'), b = String(bKey).split('-');
    return (+b[0] - +a[0]) * 12 + (+b[1] - +a[1]);
  }

  function dayOfMonth(s) {
    return +String(s).slice(8, 10);
  }

  function daysInMonth(year, month /* 1-12 */) {
    return new Date(year, month, 0, 12).getDate();
  }

  /** startStr 之后最近的一个「day 号」，月份沿用 start 所在月 */
  function nextDateWithDayAfter(startStr, day) {
    var k = monthKey(startStr);
    var y = +k.slice(0, 4);
    var m = +k.slice(5, 7);
    var d = Math.min(Math.max(1, day | 0), daysInMonth(y, m));
    var dt = new Date(y, m - 1, d, 12);
    if (ymd(dt) <= startStr) {
      var ny = dt.getFullYear();
      var nm = dt.getMonth() + 2;
      if (nm > 12) { nm = 1; ny += 1; }
      d = Math.min(Math.max(1, day | 0), daysInMonth(ny, nm));
      dt = new Date(ny, nm - 1, d, 12);
    }
    return ymd(dt);
  }

  function eachDate(from, to) {
    var out = [];
    if (from > to) return out;
    var cur = from;
    var guard = 0;
    while (cur <= to && guard++ < 4000) {
      out.push(cur);
      cur = addDays(cur, 1);
    }
    return out;
  }

  /** 把 [from,to] 拆成自然周（周一起），返回每周的完整 7 天与区间内的天 */
  function eachWeek(from, to) {
    var out = [];
    if (from > to) return out;
    var cur = weekMonday(from);
    var guard = 0;
    while (cur <= to && guard++ < 600) {
      var days = [];
      for (var i = 0; i < 7; i++) days.push(addDays(cur, i));
      var inRange = days.filter(function (d) { return d >= from && d <= to; });
      if (inRange.length) {
        out.push({ monday: cur, sunday: addDays(cur, 6), days: days, inRange: inRange });
      }
      cur = addDays(cur, 7);
    }
    return out;
  }

  /** 指定日期所在月份里、日号为 day 的那一天（同月同日号） */
  function dayInMonthOfMonth(refStr, day) {
    var y = +String(refStr).slice(0, 4);
    var m = +String(refStr).slice(5, 7);
    var d = Math.min(Math.max(1, day | 0), daysInMonth(y, m));
    return ymd(new Date(y, m - 1, d, 12));
  }

  /**
   * 本周期内「还没到的最坏发薪日」。
   * 最坏发薪日是本周期发薪最晚可能落到的那天，所以要以本周期的预计发薪日为锚，
   * 往后找日号匹配的那天；已经早于今天的往后推一个月。
   * 注意不能拿周期起始日当锚——起始日在上个月的话会算出过去的日期。
   */
  function nextWorstPayday(cycleStart, expectedPayday, worstDay, today) {
    var base = (expectedPayday && expectedPayday >= cycleStart) ? expectedPayday : cycleStart;
    var d = dayInMonthOfMonth(base, worstDay);
    if (d < base) d = dayInMonthOfMonth(addMonthsKey(monthKey(base), 1), worstDay);
    if (today && d < today) d = dayInMonthOfMonth(addMonthsKey(monthKey(d), 1), worstDay);
    return d;
  }

  function weekdayCN(s) {
    return '周' + '一二三四五六日'.charAt(dowIndex(s));
  }

  function mdLabel(s) {
    return (+s.slice(5, 7)) + '月' + (+s.slice(8, 10)) + '日';
  }

  /* ==================================================================
   * 2. 发薪日自动学习（第 12 节）
   * ================================================================== */

  /**
   * 预计发薪日 = 最近 3 次的平均日期；最坏发薪日 = 有记录以来最晚的那天；
   * 记录不满 3 次时最坏发薪日按设置里的 fallback（默认 15 号）。
   */
  /**
   * 平均日期取整（第 12 节）：四舍五入，正好 .5 时往后取一天。
   * 往后取一天 = 预计发薪日更晚 → 每天可花更少 → 更保守。
   * 例：16.1 的 8 号与 10 号平均 9，整数不涉及取整；
  *     若平均是 9.5 则取 10 号。
   */
  function roundDayHalfUp(avg) {
    return Math.round(avg);   // JS 的 Math.round 正是「.5 往后取」
  }

  function autoLearnPayday(records, settings) {
    var rs = (records || []).slice().sort();
    var st = (settings && settings.plan) || {};
    var fallbackWorst = nz(st.worstPaydayFallback, 15);
    var expectedDay, worstDay, learned = false;

    if (rs.length >= 3) {
      var last3 = rs.slice(-3);
      var s = 0;
      for (var i = 0; i < last3.length; i++) s += dayOfMonth(last3[i]);
      // 四舍五入，正好 .5 时往后取一天（第 12 节）
      expectedDay = roundDayHalfUp(s / last3.length);
      var mx = 0;
      for (var j = 0; j < rs.length; j++) mx = Math.max(mx, dayOfMonth(rs[j]));
      worstDay = mx;
      learned = true;
    } else if (rs.length === 2) {
      /* 两条记录：取平均后四舍五入，.5 往后取一天 */
      expectedDay = roundDayHalfUp((dayOfMonth(rs[0]) + dayOfMonth(rs[1])) / 2);
      worstDay = fallbackWorst;
    } else if (rs.length === 1) {
      expectedDay = dayOfMonth(rs[0]);
      worstDay = fallbackWorst;
    } else {
      expectedDay = 8;
      worstDay = fallbackWorst;
    }

    expectedDay = Math.min(28, Math.max(1, expectedDay));
    worstDay = Math.min(28, Math.max(expectedDay, worstDay));

    return {
      expectedDay: expectedDay,
      worstDay: worstDay,
      samples: rs.length,
      learned: learned,
note: rs.length < 3
        ? '发薪记录 ' + rs.length + ' 条，不满 3 次，最坏发薪日按每月 ' + worstDay + ' 号'
        : '按最近 ' + Math.min(3, rs.length) + ' 次平均，四舍五入，正好 .5 时往后取一天'
    };
  }

  /* ==================================================================
   * 3. 周期推导
   * ================================================================== */

  /**
   * 当前处于哪个发薪周期，以及预计/最坏发薪日、缓冲模式。
   * 周期从「最近一次发薪日」开始，到下一个发薪日前夜结束。
   */
  function deriveCycle(state) {
    var today = state.today;
    var records = (state.paydayRecords || []).slice().sort();
    var learn = autoLearnPayday(records, state.settings);

    var start = records.length ? records[0] : today;
    for (var i = 0; i < records.length; i++) {
      if (records[i] <= today) start = records[i];
    }

    var nominalEnd = nextDateWithDayAfter(start, learn.expectedDay); // 预计发薪日
    var worstEnd = nextWorstPayday(start, nominalEnd, learn.worstDay, today); // 最坏发薪日
    var bufferMode = today > nominalEnd;                            // 过了预计发薪日工资未到
    var displayEnd = bufferMode ? worstEnd : nominalEnd;

    var key = monthKey(start);

    return {
      key: key,
      label: cycleLabel(key),
      start: start,
      nominalEnd: nominalEnd,
      worstEnd: worstEnd,
      displayEnd: displayEnd,
      bufferMode: bufferMode,
      expectedPayday: nominalEnd,
      worstPayday: worstEnd,
      daysToPayday: Math.max(0, diffDays(today, displayEnd)),
      daysToExpected: diffDays(today, nominalEnd),
      daysToWorst: diffDays(today, worstEnd),
      learn: learn,
      today: today
    };
  }

/** 某个日期属于哪个周期（用发薪记录切分） */
  function cycleKeyForDate(state, dateStr) {
    var records = (state.paydayRecords || []).slice().sort();
    if (records.length && dateStr < records[0]) {
      return monthKey(dateStr) < monthKey(records[0]) ? monthKey(dateStr) : addMonthsKey(monthKey(records[0]), -1);
    }
    var start = records.length ? records[0] : dateStr;
    for (var i = 0; i < records.length; i++) {
   if (records[i] <= dateStr) start = records[i];
    }
    return monthKey(start);
  }

  /**
   * 按周期 key 造一个 cycle 对象（复盘看历史周期时用）。
   * start = 该周期 key 对应月份的、落在该月内的一条发薪记录；
   * 没有记录时用当月 1 号占位，保证 start / displayEnd 都能算出打车额度。
   */
  function cycleOfKey(state, key) {
    var records = (state.paydayRecords || []).slice().sort();
    var learn = autoLearnPayday(records, state.settings);
    var start = '';
    for (var i = 0; i < records.length; i++) {
      if (monthKey(records[i]) === key) { start = records[i]; break; }
    }
    if (!start) {
      var p = String(key).split('-');
      start = key + '-' + pad2(Math.min(Math.max(1, learn.expectedDay), daysInMonth(+p[0], +p[1])));
    }
    var nominalEnd = nextDateWithDayAfter(start, learn.expectedDay);
    var worstEnd = nextWorstPayday(start, nominalEnd, learn.worstDay, state.today);
    return {
 key: key,
      label: cycleLabel(key),
start: start,
      nominalEnd: nominalEnd,
      worstEnd: worstEnd,
      displayEnd: nominalEnd,
      bufferMode: false,
      expectedPayday: nominalEnd,
      worstPayday: worstEnd,
      daysToPayday: 0,
  daysToExpected: 0,
      daysToWorst: 0,
      learn: learn,
      today: state.today
    };
  }

  /** 教学周：设置里填「第几教学周」，之后每周一自动加 1（第 5 节） */
  function teachingWeek(state, todayStr) {
    var c = (state.settings && state.settings.calendar) || {};
    var anchor = c.teachingWeekAnchor || '2026-10-05';
    var base = nz(c.teachingWeek, 1);
    var monday = weekMonday(todayStr || state.today);
    var n = Math.floor(diffDays(anchor, monday) / 7);
    return {
      week: base + n,
      monday: monday,
      sunday: addDays(monday, 6),
      label: mdLabel(monday) + '–' + (+addDays(monday, 6).slice(8, 10)) + '日'
    };
  }

  /* ==================================================================
   * 4. 日历 / 晚班数 / 打车额度
   * ================================================================== */

  function isTravelDay(state, dateStr) {
    var trips = state.trips || [];
    for (var i = 0; i < trips.length; i++) {
      if (dateStr >= trips[i].start && dateStr <= trips[i].end) return true;
    }
    return false;
  }

  /** 某天状态：work / rest / night / travel / unset（第 11 节，没排班就是 unset，不能默认显示成休息） */
  function dayStatus(state, dateStr) {
    if (isTravelDay(state, dateStr)) return 'travel';
    var c = state.calendar || {};
    return c[dateStr] || 'unset';
  }

  /** 日历点击循环顺序（第 11 节）：上班 → 休息 → 晚班 → 未排 → 上班 */
  var DAY_CYCLE = ['work', 'rest', 'night', 'unset'];

  function nextDayStatus(state, dateStr) {
    var cur = dayStatus(state, dateStr);
    // 出行日不参与排班循环，点一下先取消出行
    if (cur === 'travel') return 'work';
    var i = DAY_CYCLE.indexOf(cur);
    return DAY_CYCLE[(i + 1) % DAY_CYCLE.length];
  }

  function setDayStatus(state, dateStr, st) {
    var next = clone(state);
    next.calendar = next.calendar || {};
    if (st === 'unset') delete next.calendar[dateStr];
    else next.calendar[dateStr] = st;
    return next;
  }

  function hasCalendarEntry(state, dateStr) {
    return !!(state.calendar && state.calendar[dateStr]);
  }

  /**
   * 数 [from, to] 区间内的晚班数（第 2 节）：
   *   · 晚班从日历读；
   *   · 整周没有任何排班数据的周，按设置里的估值算（默认 3 个）；
   *   · 周期首尾不满一周的部分按天数折算：3 × 天数 ÷ 7；
   *   · 整个周期合计后才四舍五入成整数。
   *   · 出行日不算晚班，打车额度不给这几天预留。
   */
  function countNightShifts(state, from, to) {
    var st = (state.settings && state.settings.taxi) || {};
    var est = nz(st.unassignedWeekNightShifts, 3);
    var weeks = eachWeek(from, to);
    var night = 0;
    var estimatedRaw = 0;   // 未排班部分按天折算的原始值（不对每一周单独取整）
    var scheduledWeeks = 0;
    var unscheduledWeeks = 0;

    for (var i = 0; i < weeks.length; i++) {
      var w = weeks[i];
      var anyData = false;
      for (var d = 0; d < 7; d++) {
        if (hasCalendarEntry(state, w.days[d])) { anyData = true; break; }
      }
      if (anyData) {
        scheduledWeeks++;
        for (var j = 0; j < w.inRange.length; j++) {
          var day = w.inRange[j];
          if ((state.calendar || {})[day] === 'night' && !isTravelDay(state, day)) night++;
        }
      } else {
        unscheduledWeeks++;
        // 出行日不预留打车额度，所以这几天从折算天数里扣掉
        var tripDays = 0;
        for (var k = 0; k < w.inRange.length; k++) {
          if (isTravelDay(state, w.inRange[k])) tripDays++;
        }
        // 不满一周的部分按天数折算：3 × 天数 ÷ 7
        estimatedRaw += est * Math.max(0, w.inRange.length - tripDays) / 7;
      }
    }

    // 整个周期合计后四舍五入成整数（第 2 节）
    var estimated = Math.round(estimatedRaw);

    return {
      from: from,
      to: to,
      night: night,
      estimated: estimated,
      estimatedRaw: round2(estimatedRaw),
      total: night + estimated,
      scheduledWeeks: scheduledWeeks,
      unscheduledWeeks: unscheduledWeeks
    };
  }

  /**
   * 打车额度（第 2 节）：额度次数 = 本周期晚班数 + 余量次数，每次一个单价。
   * 额度按「整个周期」算（发薪日一次性重算）；预警用的「剩下晚班数」按今天往后算。
   */
  function taxiQuota(state, cycle) {
    var st = (state.settings && state.settings.taxi) || {};
    var price = nz(st.price, 25);
    var surplus = nz(st.surplus, 4);
    var perCycle = countNightShifts(state, cycle.start, cycle.displayEnd);
    // 预警用的「本周期剩下的晚班数」：从今天往后的日历晚班（未排班周按估值）
    var remain = countNightShifts(state, state.today > cycle.start ? state.today : cycle.start, cycle.displayEnd);
    var quotaCount = perCycle.total + surplus;

    var usedCount = countEntries(state, {
      cycleKey: cycle.key,
      catIds: categoryIdsByName(state, '打车（计次）')
    }) + nz((state.carry || {}).taxiUsed, 0);

    return {
      price: price,
      surplus: surplus,
      nightShifts: perCycle.total,
      nightFromCalendar: perCycle.night,
      nightEstimated: perCycle.estimated,
      unscheduledWeeks: perCycle.unscheduledWeeks,
      remainingNightShifts: remain.total,
      quotaCount: quotaCount,
      quotaAmount: round2(quotaCount * price),
      usedCount: usedCount,
      leftCount: Math.max(0, quotaCount - usedCount),
      exhausted: usedCount >= quotaCount,
      note: perCycle.night + ' 个晚班（未排班 ' + perCycle.unscheduledWeeks + ' 周按 ' + nz(st.unassignedWeekNightShifts, 3) + ' 个估）'
    };
  }

  /* ==================================================================
   * 5. 流水读取
   * ================================================================== */

  function categoryIdsByName(state, name) {
    var cats = state.categories || [];
    var out = [];
    for (var i = 0; i < cats.length; i++) {
      for (var j = 0; j < cats[i].children.length; j++) {
        if (cats[i].children[j].name === name) out.push(cats[i].children[j].id);
      }
    }
    return out;
  }

  function findCategory(state, catId) {
    var income = incomeCategory(catId);
    if (income) return { id: catId, name: income.name, parent: '收入', parentId: 'c-income', node: income };
    var cats = state.categories || [];
    for (var i = 0; i < cats.length; i++) {
      for (var j = 0; j < cats[i].children.length; j++) {
        if (cats[i].children[j].id === catId) {
          return { id: catId, name: cats[i].children[j].name, parent: cats[i].name, parentId: cats[i].id, node: cats[i].children[j] };
        }
      }
    }
    return { id: catId, name: '未分类', parent: '其他', parentId: '', node: {} };
  }

  function entriesOfCycle(state, cycleKey) {
    var out = [];
    var list = state.entries || [];
    for (var i = 0; i < list.length; i++) {
      // 发薪日当天由用户二选一指定归属（第 12 节），没指定才按日期推
      var k = list[i].cycleKey || cycleKeyForDate(state, list[i].date);
      if (k === cycleKey) out.push(list[i]);
    }
    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.time || '') < (b.time || '') ? -1 : 1;
    });
    return out;
  }

  function countEntries(state, opt) {
    var list = entriesOfCycle(state, opt.cycleKey);
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (opt.catIds && opt.catIds.indexOf(list[i].catId) >= 0 && nz(list[i].amount, 0) > 0) n++;
    }
    return n;
  }

  /** 某分类在本周期是第几次（1 起） */
  function occurrenceIndex(state, entry) {
    var list = entriesOfCycle(state, entry.cycleKey || cycleKeyForDate(state, entry.date));
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].catId !== entry.catId) continue;
      n++;
      if (list[i].id === entry.id) return n;
    }
    return n;
  }

  /* ==================================================================
   * 6. 信封状态（第 2 节）
   * ================================================================== */

  var ABC_ENVELOPES = { food: 1, sub: 1, taxi: 1, other: 1, free: 0 };

  function isFromAbc(envelope) {
    return !!ABC_ENVELOPES[envelope];
  }

  /**
   * 信封余额。
   *   自由支配余额 = 余额宝 + 农行里本周期还没花的自由支配
   *   缓冲模式下农行不拆信封，自由支配全部在余额宝
   */
  function envelopeState(state, cycleOrKey) {
    var env = state.settings.envelopes;
    var taxiCfg = state.settings.taxi || {};
    var taxiPrice = nz(taxiCfg.price, 25);
    // 复盘会直接传 cycleKey 字符串，这里统一成 cycle 对象，
    // 否则 cycle.start / cycle.displayEnd 取不到，打车额度会算成 0（第 9 条界面问题）
    var cycle = (typeof cycleOrKey === 'string')
      ? cycleOfKey(state, cycleOrKey)
      : (cycleOrKey || deriveCycle(state));
    var list = entriesOfCycle(state, cycle.key);
    var taxiIds = categoryIdsByName(state, '打车（计次）');
    var takeoutIds = categoryIdsByName(state, '外卖（计次）');
    // 起始状态：10 月 6 日到首次发薪之间已打车 4 次、外卖 1 次（规格第 16 节）
    var carry = state.carry || {};
    var carryTaxi = nz(carry.taxiUsed, 0);
    var carryTakeout = nz(carry.takeoutUsed, 0);

    var used = { food: 0, sub: 0, taxi: round2(carryTaxi * taxiPrice), other: 0, free: 0 };
    var taxiCount = carryTaxi;
    var takeoutCount = carryTakeout;
    var seqTakeout = carryTakeout;
    var seqTaxi = carryTaxi;

    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var amt = nz(e.amount, 0);
      if (used[e.envelope] == null) continue;
      used[e.envelope] = round2(used[e.envelope] + amt);
      if (amt > 0 && taxiIds.indexOf(e.catId) >= 0) { taxiCount++; seqTaxi++; }
      if (amt > 0 && takeoutIds.indexOf(e.catId) >= 0) { seqTakeout++; if (seqTakeout <= nz(state.settings.takeout.perCycle, 4)) takeoutCount++; }
    }

    var taxi = taxiQuota(state, cycle);
    var freeQuota = nz(env.free, 570);
    var freeInAbc = cycle.bufferMode ? 0 : Math.max(0, round2(freeQuota - used.free));
    var yuebao = nz(state.accounts.yuebao, 0);

    var foodQuota = nz(env.food, 1050);
    var otherQuota = nz(env.mobilityOther, 400);

    var result = {
      cycleKey: cycle.key,
      cycleLabel: cycle.label,
      bufferMode: cycle.bufferMode,
      food: {
        quota: foodQuota,
        used: used.food,
        left: round2(foodQuota - used.food),
        overspent: used.food > foodQuota
      },
      sub: {
        quota: nz(env.sub, 645),
        used: used.sub,
        left: round2(nz(env.sub, 645) - used.sub)
      },
      taxi: {
        quotaCount: taxi.quotaCount,
        usedCount: taxi.usedCount,
        leftCount: taxi.leftCount,
        price: taxiPrice,
        quotaAmount: taxi.quotaAmount,
        used: used.taxi,
        left: round2(Math.max(0, taxi.quotaAmount - used.taxi)),
        nightShifts: taxi.nightShifts,
        remainingNightShifts: taxi.remainingNightShifts,
        exhausted: taxi.exhausted,
        detail: taxi
      },
      other: {
        quota: otherQuota,
        used: used.other,
        /* 第五轮：机动·其他剩余 = 机动总额 − 机动已花 − 打车剩余次数 × 单价。
           打车还没用完的次数是「预留」，先从机动总额里扣掉，剩下的才是其他能用的。 */
        left: round2(nz(env.mobility, 825) - used.taxi - used.other - taxi.leftCount * taxiPrice),
        usedPct: otherQuota > 0 ? round2((used.other / otherQuota) * 100) : 0
      },
      free: {
        quota: freeQuota,
        used: used.free,
        leftInAbc: freeInAbc,
        yuebao: round2(yuebao),
        balance: round2(yuebao + freeInAbc)
      },
      takeout: {
        perCycle: nz(state.settings.takeout.perCycle, 4),
        usedInQuota: takeoutCount,
        totalCount: seqTakeout,
        leftCount: Math.max(0, nz(state.settings.takeout.perCycle, 4) - takeoutCount),
        exhausted: takeoutCount >= nz(state.settings.takeout.perCycle, 4)
      },
      abcBalance: round2(nz(state.accounts.abc, 0)),
      abcOpening: round2(nz(state.cycleAbcOpening, nz(state.accounts.abc, 0))),
      yuebao: round2(yuebao),
      holiday: round2(nz(state.accounts.holiday, 0)),
      cmbDebt: round2(nz(state.cmbDebt, 0)),
      _used: used,
      _entries: list
    };
    var reserve = threeEnvelopeLeft(state, result);
    result.funding = { shortfall: reserve.shortfall, mobilityShortfall: reserve.mobilityShortfall };
    if (!cycle.bufferMode) {
      var freeAfterShortfall = round2(freeInAbc - reserve.shortfall);
      result.free.leftInAbc = Math.max(0, freeAfterShortfall);
      result.free.balance = round2(yuebao + freeAfterShortfall);
    }
    return result;
  }

  /** 吃饭今日可花 = 吃饭剩余 ÷ 距预计发薪日天数；缓冲模式改显缓冲剩余 */
  function mealDaily(state, cycle, env) {
    if (cycle.bufferMode) {
      var bufferLeft = round2(nz(state.accounts.abc, 0));
      var daysWorst = Math.max(1, diffDays(state.today, cycle.worstEnd));
      return {
        bufferMode: true,
        label: '吃饭 · 缓冲剩余',
        main: bufferLeft,
        perDay: round2(bufferLeft / daysWorst),
        days: daysWorst,
        daysTo: '距最坏发薪日 ' + daysWorst + ' 天',
        rest: bufferLeft,
        restLabel: '缓冲剩余',
        takeoutLeft: env.takeout.leftCount
      };
    }
    var days = Math.max(1, diffDays(state.today, cycle.expectedPayday));
    var left = env.food.left;
    return {
      bufferMode: false,
      label: '吃饭 · 今日可花',
      main: round2(left / days),
      perDay: round2(left / days),
      days: days,
      daysTo: '距预计发薪日 ' + days + ' 天',
      rest: left,
      restLabel: '本周期剩',
      takeoutLeft: env.takeout.leftCount
    };
  }

  /* ==================================================================
   * 7. 自由支配余额预测（第 8 节 · 保守算法）
   * ================================================================== */

  // 旧账中已经过期的未买项目，立即按当前周期预留；不在读取/预测时改写账目。
  function scheduledCycleKey(item, currentKey) {
    return item.cycleKey && item.cycleKey < currentKey ? currentKey : item.cycleKey;
  }

  function scheduledIn(state, cycleKey, currentKey) {
    return (state.planItems || []).filter(function (it) {
      return it.type === 'scheduled' && scheduledCycleKey(it, currentKey) === cycleKey && !it.removed;
    });
  }

  function conditionalIn(state) {
    return (state.planItems || []).filter(function (it) {
      return it.type === 'conditional' && !it.removed;
    });
  }

  /**
   * 吃饭、机动、固定订阅三个信封本周期的剩余额度合计（第 8 节）。
   * 已发生支出已在账户扣除；这里只预留尚未花掉的额度和剩余打车次数。
   */
  function threeEnvelopeLeft(state, env) {
    var es = (state && state.settings && state.settings.envelopes) || {};
    var used = (env && env._used) || {};
    var food = Math.max(0, round2(nz(es.food, 1050) - nz(used.food, 0)));
    // 剩余打车预留不能因其他消费超支而消失，也不重复扣已发生的支出。
    var mobilityRemaining = round2(nz(es.mobility, 825) - nz(used.taxi, 0) - nz(used.other, 0));
    var taxiReserve = round2(nz(env && env.taxi && env.taxi.leftCount, 0) * nz(env && env.taxi && env.taxi.price, 25));
    var mobility = Math.max(0, mobilityRemaining, taxiReserve);
    var sub = Math.max(0, round2(nz(es.sub, 645) - nz(used.sub, 0)));
    var mobilityShortfall = Math.max(0, round2(taxiReserve - mobilityRemaining));
    var shortfall = round2(Math.max(0, nz(used.food, 0) - nz(es.food, 1050)) +
      Math.max(0, nz(used.sub, 0) - nz(es.sub, 645)) + mobilityShortfall);
    return {
      food: round2(food),
      mobility: round2(mobility),
      sub: round2(sub),
      mobilityShortfall: mobilityShortfall,
      shortfall: shortfall,
      total: round2(food + mobility + sub)
    };
  }

  /**
   * 发薪日扫入余额宝的金额（第 8 节，第五轮加招行欠款）：
   *   扫入 = 预计发薪日农行余额 − 招行总欠款 − 缓冲（350）
   * 结果为负数表示要从余额宝补到农行。
   *
   *   · 当前周期：预计发薪日农行余额 = 农行当前实际余额 − 吃饭/机动/固定订阅三个信封本周期的剩余额度
   *     （若调用方直接给定了发薪日农行余额，如 16.2 验收场景，就直接用它）
   *   · 之后的标准周期：扫入 570（= 自由支配额度，规格第 2 节）
   * 招行信用卡每月 17 日从农行自动全额扣款，所以发薪日农行里「还没被划走」的钱
   * 要先减去招行总欠款，剩下的才是能扫进余额宝的。
   */
  function sweepAtPayday(state, cycle, env, opts) {
    opts = opts || {};
    var bufferTarget = nz(state.settings.plan.abcBuffer, 350);
    var cmbDebt = round2(nz(opts.cmbDebt, nz(state.cmbDebt, 0)));
    var abcAtPayday;
    if (isNum(opts.paydayAbcBalance)) {
      abcAtPayday = opts.paydayAbcBalance;
    } else {
      abcAtPayday = round2(nz(state.accounts.abc, 0) - threeEnvelopeLeft(state, env).total);
    }
    return round2(abcAtPayday - cmbDebt - bufferTarget);
  }

  /**
   * 预测起点：余额宝余额（本周期刚过发薪日，信封都是满的，自由支配还没开始花）。
   *
   * 农行里那部分自由支配不在这里加——发薪日会以「扫入余额宝」的形式单独结算，
   * 否则会和下面的调整重复计算。
   */
  function forecastStartBalance(state) {
    return round2(nz(state.accounts.yuebao, 0));
  }

  /**
   * 只按排定项算出的各周期最低余额。
   *   · 吃饭和机动每周期全部花完（不影响自由支配）
   *   · rows[0] 就是当前周期，之后每个周期开头按第 8 节公式扫入一次
   *   · 排定项到期直接扣，允许跌破底线但不能变负
   */
  /**
   * 预测范围（第 8 节）：从当前周期开始，至少到最远的排定项所在周期，且不少于 6 个周期。
   * 返回要预测的周期 key 数组（第一个是当前周期）。
   */
  function forecastCycleKeys(state, cycle, horizon) {
    var n = Math.max(1, horizon || 6);
    // 至少 6 个周期（不算当前周期这一个是「之后」的个数，这里取总数更直白）
    if (n < 6) n = 6;
    // 要覆盖到最远的排定项所在周期
    var items = state.planItems || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.type !== 'scheduled' || it.removed) continue;
      if (!it.cycleKey) continue;
      var gap = monthsBetweenKeys(cycle.key, it.cycleKey);
      if (gap >= n) n = gap + 1;   // 含当前周期，所以 +1
    }
    return [cycle.key].concat(nextCycleKeys(cycle.key, n));
  }

  function forecast(state, opts) {
    opts = opts || {};
    var cycle = opts.cycle || deriveCycle(state);
    var env = opts.env || envelopeState(state, cycle);
    var horizon = opts.horizon || 6;
    var keys = opts.cycleKeys || forecastCycleKeys(state, cycle, horizon);
    var freeQuota = nz(state.settings.envelopes.free, 570);
    var startBalance = forecastStartBalance(state);
    var floor = nz(state.settings.plan.floor, 200);
    // 当前周期这次发薪日扫入多少；之后的标准周期都按自由支配额度扫入
    var sweepNow = sweepAtPayday(state, cycle, env, opts);

    /* 假期周期（第五轮）：假期周期的发薪日实发比平常少（默认 1600），
       缺口 = 四信封合计 − 预计实发。周转金够用时余额宝和平常一样；
       不够时，差额从余额宝出，余额宝预测从那个周期起整体下移。 */
    var gap = holidayGap(state);
    var holidayBal = round2(nz(state.accounts.holiday, 0));
    var holidayShortfall = 0;
    var holidayShortfallCycle = '';
    var firstHolidayShortfall = 0;
    var holidayCarry = nz((state.paydayCarry || {}).holiday, 0);
    var holidayPerCycle = Math.max(0, nz((state.settings.holiday || {}).transferPerCycle, 300));

    var rows = [];
    var bal = startBalance;
    for (var i = 0; i < keys.length; i++) {
      var due = scheduledIn(state, keys[i], cycle.key);
      var schedAmt = sum(due, function (it) { return it.amount; });
      var start = bal;
      var afterScheduled = round2(start - schedAmt);
      rows.push({
        index: i,
        key: keys[i],
        label: cycleLabel(keys[i]),
        shortLabel: monthLabel(keys[i]),
        isCurrent: i === 0,
        holiday: isHolidayCycle(state, keys[i]),
        holidayBalance: holidayBal,
        start: round2(start),
        scheduled: schedAmt,
        scheduledNames: due.map(function (it) { return it.name; }),
        afterScheduled: afterScheduled,
        low: afterScheduled,
        conditional: 0,
        conditionalNames: [],
        items: []
      });
      // 下一个周期的期初 = 本周期最低点 + 发薪日扫入；若下个周期是假期周期，先扣差额
      var delta = round2(i === 0 ? sweepNow : freeQuota);
      if (i + 1 < keys.length && isHolidayCycle(state, keys[i + 1])) {
        var covered = round2(Math.min(gap, Math.max(0, holidayBal)));
        var short = round2(Math.max(0, gap - holidayBal));
        if (short > 0) {
          holidayShortfall = round2(holidayShortfall + short);
          if (!holidayShortfallCycle) {
            holidayShortfallCycle = keys[i + 1];
            firstHolidayShortfall = short;
          }
        }
        holidayBal = round2(holidayBal - covered);
        holidayCarry = round2(holidayCarry + holidayPerCycle);
        delta = round2(delta - short);
      } else if (i + 1 < keys.length) {
        if (!nextHolidayKey(state, keys[i + 1]) || holidayBal < gap) {
          holidayBal = round2(holidayBal + holidayPerCycle + holidayCarry);
        }
        holidayCarry = 0;
      }
      bal = round2(afterScheduled + delta);
    }

    var minLow = rows.length ? Math.min.apply(null, rows.map(function (r) { return r.low; })) : startBalance;

    return {
      cycleKey: cycle.key,
      cycleLabel: cycle.label,
      horizon: horizon,
      keys: keys,
      rows: rows,
      startBalance: round2(startBalance),
      sweepNow: sweepNow,
      abcBuffer: nz(state.settings.plan.abcBuffer, 350),
      threeLeft: threeEnvelopeLeft(state, env),
      freeQuota: freeQuota,
      floor: floor,
      minLow: round2(minLow),
      safeSpend: round2(Math.max(0, minLow - floor)),
      willGoNegative: rows.some(function (r) { return r.low < 0; }),
      holiday: {
        fund: round2(nz(state.accounts.holiday, 0)),
        gap: gap,
        shortfall: holidayShortfall,
        firstShortfall: firstHolidayShortfall,
        shortfallCycle: holidayShortfallCycle
      }
    };
  }

  /** 条件项排序：置顶优先，其余金额从高到低 */
  function sortConditional(items) {
    return items.slice().sort(function (a, b) {
      var pa = a.pinned ? 0 : 1;
      var pb = b.pinned ? 0 : 1;
      if (pa !== pb) return pa - pb;
      var aa = isNum(a.amount) ? a.amount : -1;
      var bb = isNum(b.amount) ? b.amount : -1;
      if (aa !== bb) return bb - aa;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
  }

  /**
   * 条件项可买算法（第 8 节四步）：
   *   1. 可用余量 = 该周期及未来所有时点的最低余额 − 底线
   *   2. 置顶优先，其余金额从高到低
   *   3. 按顺序看：金额 ≤ 可用余量就标为本周期可买并从余量里扣掉，买不起跳过让便宜的插队
   *   4. 剩下的顺延到下一个周期重复
   * 返回每个条件项的可买周期、以及扣除购买后的各周期最低余额。
   */
  function allocateConditionals(state, fc) {
    var floor = nz(state.settings.plan.floor, 200);
    var lows = fc.rows.map(function (r) { return r.low; });
    var pool = conditionalIn(state).filter(function (it) {
      return isNum(it.amount) && it.amount > 0;
    });
    var unpriced = conditionalIn(state).filter(function (it) {
      return !isNum(it.amount) || it.amount <= 0;
    });

    var assign = {};   // id -> row index
    var bought = [];   // [{item, rowIndex}]
    var guard = 0;

    for (var idx = 0; idx < fc.rows.length && guard < 500; idx++) {
      var inner = 0;
      while (inner++ < 200) {
        guard++;
        var futureMin = Infinity;
        for (var j = idx; j < lows.length; j++) futureMin = Math.min(futureMin, lows[j]);
        var margin = round2(futureMin - floor);

        var remaining = pool.filter(function (it) { return assign[it.id] === undefined; });
        var ordered = sortConditional(remaining);
        var picked = null;
        for (var k = 0; k < ordered.length; k++) {
          if (round2(ordered[k].amount) <= margin + 1e-9) { picked = ordered[k]; break; }
        }
        if (!picked) break;

        assign[picked.id] = idx;
        bought.push({ item: picked, rowIndex: idx });
        for (var m = idx; m < lows.length; m++) lows[m] = round2(lows[m] - picked.amount);
      }
    }

    // 回填：条件项花掉的钱会永久离开余额宝，所以下一周期的期初要在扣减之后再算。
    // 下一周期开头扫进来多少：当前周期用本次发薪日扫入额，之后的标准周期用自由支配额度。
    for (var n = 0; n < fc.rows.length; n++) {
      var row = fc.rows[n];
      row.low = lows[n];
      row.conditional = 0;
      row.conditionalNames = [];
      row.items = [];
      if (n > 0) row.start = round2(lows[n - 1] + (n === 1 ? fc.sweepNow : fc.freeQuota));
    }
    for (var b = 0; b < bought.length; b++) {
      var it2 = bought[b].item;
      var r2 = fc.rows[bought[b].rowIndex];
      r2.conditional = round2(r2.conditional + it2.amount);
      r2.conditionalNames.push(it2.name);
      r2.items.push(it2);
    }

    var minLowConditional = fc.rows.length
      ? Math.min.apply(null, fc.rows.map(function (r) { return r.low; }))
      : fc.startBalance;

    // 条件项视图
    var items = [];
    var all = conditionalIn(state);
    for (var q = 0; q < all.length; q++) {
      var it = all[q];
      var rec = {
        id: it.id,
        name: it.name,
        amount: it.amount,
        pinned: !!it.pinned,
        buyBefore: it.buyBefore || '',
        type: 'conditional'
      };
      if (!isNum(it.amount) || it.amount <= 0) {
        rec.rowIndex = -1;
        rec.cycleKey = '';
        rec.badge = '未估价';
        rec.badgeTone = 'muted';
        rec.affordable = false;
      } else if (assign[it.id] === undefined) {
        rec.rowIndex = -1;
        rec.cycleKey = '';
        rec.badge = '排不开';
        rec.badgeTone = 'warn';
        rec.affordable = false;
      } else {
        rec.rowIndex = assign[it.id];
        rec.cycleKey = fc.keys[rec.rowIndex];
        rec.badge = monthLabel(rec.cycleKey) + '可买';
        rec.badgeTone = 'ok';
        rec.affordable = true;
        rec.marginAtCycle = round2(
          Math.min.apply(null, fc.rows.slice(rec.rowIndex).map(function (r) { return r.low; })) - floor
        );
        // 「希望在哪个周期前买到」——排期晚于期望就标出来
        if (it.buyBefore) {
          var wantIdx = fc.keys.indexOf(it.buyBefore);
          if (wantIdx >= 0 && wantIdx < rec.rowIndex) {
            rec.late = true;
            rec.badgeTone = 'late';
            rec.badge = monthLabel(rec.cycleKey) + '可买 · 晚于期望';
          }
        }
      }
      items.push(rec);
    }

    fc.items = items;
    fc.lows = lows;
    // 安全可花只看排定项：条件项是「够钱才买」，买不买由用户决定，不能拿来压底线
    // （规格 16.1：10 月周期排定项最低点 861.47，安全可花 661.47）
    fc.minLowAfterConditional = round2(minLowConditional);
    fc.willGoNegative = fc.rows.some(function (r) { return r.low < 0; });
    fc.assigned = assign;
    fc.unpriced = unpriced;

    return fc;
  }

  /** 排表页一次算全：预测 + 条件项分配 */
  function planView(state, opts) {
    var cycle = (opts && opts.cycle) || deriveCycle(state);
    var env = envelopeState(state, cycle);
    var fc = forecast(state, {
      cycle: cycle, env: env,
      horizon: (opts && opts.horizon) || 6,
      paydayAbcBalance: opts && opts.paydayAbcBalance
    });
    allocateConditionals(state, fc);

    var scheduled = (state.planItems || []).filter(function (it) {
      return it.type === 'scheduled' && !it.removed;
    }).map(function (it) {
      var key = scheduledCycleKey(it, cycle.key);
      return {
        id: it.id, name: it.name, amount: it.amount, type: 'scheduled',
        cycleKey: key, label: cycleLabel(key),
        shortLabel: monthLabel(key), note: it.note || ''
      };
    }).sort(function (a, b) {
      if (a.cycleKey !== b.cycleKey) return a.cycleKey < b.cycleKey ? -1 : 1;
      return nz(b.amount, 0) - nz(a.amount, 0);
    });

    /* 负数周期：照计划付排定项时钱不够（第 8 节）。
       这是最重要的预警，要把「差多少、差哪几项」都算清楚给界面用。 */
    var negativeCycles = fc.rows.filter(function (r) { return r.low < 0; }).map(function (r) {
      return {
        key: r.key,
        label: r.label,
        shortLabel: r.shortLabel,
        gap: round2(-r.low),                       // 差多少（正数）
        scheduledNames: (r.scheduledNames || []).slice(),
        scheduledAmount: round2(r.scheduled)
      };
    });

    return {
      cycle: cycle,
      env: env,
      forecast: fc,
      freeBalance: env.free.balance,
      safeSpend: fc.safeSpend,
      minLow: fc.minLow,
      willGoNegative: fc.willGoNegative,
      negativeCycles: negativeCycles,
      firstNegative: negativeCycles.length ? negativeCycles[0] : null,
      scheduled: scheduled,
      conditional: fc.items,
      /* 假期周转金：单独显示，不计入安全可花、不参与条件项分配 */
      holidayBalance: round2(nz(state.accounts.holiday, 0)),
      holidayShortfall: fc.holiday ? fc.holiday.shortfall : 0
    };
  }

  /** 单个条件项目前按现在的余额哪个周期可买（编辑页用） */
  function affordableCycleOf(state, item, opts) {
    var probe = clone(state);
    var found = null;
    for (var i = 0; i < probe.planItems.length; i++) {
      if (probe.planItems[i].id === item.id) found = probe.planItems[i];
    }
    if (!found) {
      found = { id: item.id, type: item.type || 'conditional', name: item.name || '新项目', amount: item.amount, pinned: !!item.pinned, buyBefore: item.buyBefore || '' };
      probe.planItems.push(found);
    } else {
      found.amount = item.amount;
      found.pinned = !!item.pinned;
      found.buyBefore = item.buyBefore || '';
    }
    var pv = planView(probe, opts);
    for (var j = 0; j < pv.conditional.length; j++) {
      if (pv.conditional[j].id === found.id) return pv.conditional[j];
    }
    return { id: found.id, badge: '未估价', badgeTone: 'muted', affordable: false, cycleKey: '' };
  }

  /* ==================================================================
   * 8. 买不买（第 9 节）
   * ================================================================== */

  /**
   * kind: 'need' 必要的 / 'want' 想要的
   * 返回 { conclusion, label, cycleKey, cycleLabel, reasons[], addAs, margin }
   *
   * 第五轮改判断顺序（去掉冷处理）：
   *   · 必要的：买了会让余额宝未来变负、或挤掉排定项 → 「不建议买」（写明会挤掉哪几项）；
   *     不会 → 「现在能买」。
   *   · 想要的：金额 > 可用余量（安全可花）→ 「X 月周期后能买」，给出最早周期，
   *     预测范围内都排不开时写「预测范围内排不开」；否则 → 「现在能买」。
   *   · 想要的不走「不建议买」这一格 —— 买不起就等，等待本身就是冷静。
   */
  function buyVerdict(state, input) {
    var amount = round2(nz(input.amount, 0));
    var kind = input.kind === 'need' ? 'need' : 'want';
    var plan = input.plan || planView(state, { paydayAbcBalance: input.paydayAbcBalance });
    var fc = plan.forecast;
    var floor = nz(state.settings.plan.floor, 200);
    var reasons = [];

    var margin = plan.safeSpend;

    if (amount <= 0) {
      return {
        conclusion: 'unknown', label: '先填金额', reasons: ['填上金额才能给结论'],
        addAs: kind === 'need' ? 'scheduled' : 'conditional', margin: margin,
        cycleKey: '', plan: plan
      };
    }

    // 把这件东西放进排表重算一遍，看会不会把未来算成负数
    var probe = clone(state);
    probe.planItems.push({
      id: '__probe__',
      type: kind === 'need' ? 'scheduled' : 'conditional',
      name: input.name || '待定',
      amount: amount,
      cycleKey: kind === 'need' ? (input.cycleKey || nextCycleKeys(plan.cycle.key, 1)[0]) : '',
      pinned: false
    });
    var probePlan = planView(probe, { paydayAbcBalance: input.paydayAbcBalance });
    var willGoNegative = probePlan.forecast.willGoNegative;

    // 「挤掉排定项」：放进排表后，有周期变负且那个周期有排定项要付
    var squeezedNames = [];
    probePlan.forecast.rows.forEach(function (r) {
      if (r.low < 0 && r.scheduled > 0) {
        (r.scheduledNames || []).forEach(function (n) {
          if (squeezedNames.indexOf(n) < 0) squeezedNames.push(n);
        });
      }
    });

    var earliest = null;
    for (var i = 0; i < probePlan.conditional.length; i++) {
      if (probePlan.conditional[i].id === '__probe__') earliest = probePlan.conditional[i];
    }

    var changedNames = [];
    for (var j = 0; j < probePlan.conditional.length; j++) {
      var pi = probePlan.conditional[j];
      if (pi.id === '__probe__') continue;
      for (var k = 0; k < plan.conditional.length; k++) {
        var oi = plan.conditional[k];
        if (oi.id === pi.id && oi.cycleKey !== pi.cycleKey) {
          var early = monthsBetweenKeys(pi.cycleKey, oi.cycleKey) > 0;
          changedNames.push(pi.name + '（' + (early ? '提前到' : '推到') + shortOf(pi.cycleKey) + '）');
        }
      }
    }

    /* ---------- 必要的 ---------- */
    if (kind === 'need') {
      if (willGoNegative || squeezedNames.length) {
        if (margin <= 0) {
          reasons.push('现在安全可花 ' + money(margin) + '，买了会让余额宝未来变负');
        } else {
          reasons.push('买了会让 ' + shortOf(fc.keys[0]) + '周期的余额宝变负');
        }
        if (squeezedNames.length) {
          reasons.push('会挤掉排定项：' + squeezedNames.join('、') + '（排定项到期必须付）');
        }
        reasons.push('建议先别买，或把它挪到更晚的周期再看看');
        return {
          conclusion: 'no', label: '不建议买', reasons: reasons,
          addAs: 'scheduled',
          margin: margin, cycleKey: '', plan: plan, probePlan: probePlan
        };
      }
      var targetKey = input.cycleKey || nextCycleKeys(plan.cycle.key, 1)[0];
      var targetRow = null;
      for (var t = 0; t < probePlan.forecast.rows.length; t++) {
        if (probePlan.forecast.rows[t].key === targetKey) targetRow = probePlan.forecast.rows[t];
      }
      reasons.push('必要项按 ' + cycleLabel(targetKey) + '付款，到期直接扣');
      reasons.push(targetRow
        ? '付完后该周期最低点 ' + money(targetRow.low) + (targetRow.low < floor ? '，会短暂跌破底线 ' + money(floor) : '，还在底线之上')
        : '已排进排表');
      reasons.push('放进排表后按最贵优先排，条件项可买周期' + (changedNames.length ? '会变：' + changedNames.join('、') : '不变'));
      return {
        conclusion: 'now', label: '现在能买', reasons: reasons, addAs: 'scheduled',
        margin: margin, cycleKey: targetKey, plan: plan, probePlan: probePlan
      };
    }

    /* ---------- 想要的 ---------- */
    // 买不起 → 某周期后能买（等待本身就是冷静，不再另设冷处理）
    if (amount > margin) {
      var cyc = earliest && earliest.cycleKey ? earliest.cycleKey : '';
      reasons.push('现在安全可花 ' + money(margin) + '，买了会低于 ' + money(floor) + ' 底线');
      if (cyc) {
        reasons.push('等一等就好：等到' + cycleLabel(cyc) + '就有钱买了');
      } else {
        reasons.push('预测范围内都排不开，要等更久或先攒一攒');
      }
      reasons.push(changedNames.length
        ? '放进排表后按最贵优先排，' + changedNames.join('、') + '会变'
        : '放进排表后按最贵优先排，其他条件项的可买周期不变');
      return {
        conclusion: 'later',
        label: cyc ? cycleLabel(cyc) + '后能买' : '预测范围内排不开',
        reasons: reasons, addAs: 'conditional', margin: margin,
        cycleKey: cyc, plan: plan, probePlan: probePlan
      };
    }

    // 买得起 → 现在能买
    reasons.push('现在安全可花 ' + money(margin) + '，买了还剩 ' + money(margin - amount));
    reasons.push(changedNames.length
      ? '放进排表后按最贵优先排，' + changedNames.join('、') + '会变'
      : '放进排表后按最贵优先排，其他条件项的可买周期不变');
    return {
      conclusion: 'now', label: '现在能买', reasons: reasons, addAs: 'conditional',
      margin: margin, cycleKey: plan.cycle.key, plan: plan, probePlan: probePlan
    };
  }

  function shortOf(cycleKey) {
    return cycleKey ? monthLabel(cycleKey) : '—';
  }

  /* ==================================================================
   * 9. 进度预警（第 10 节）
   * ================================================================== */

  function bufferAdvice(state) {
    var cycle = deriveCycle(state);
    var env = envelopeState(state, cycle);
    var taxi = env.taxi;
    var days = Math.max(0, diffDays(cycle.expectedPayday, cycle.worstPayday));
    var mealDailyCost = nz(state.settings.envelopes.food, 1050) / 30;
    var taxiDailyCost = (taxi.nightShifts * taxi.price) / 30;
    var daily = mealDailyCost + taxiDailyCost;
    var need = round2(days * daily);
    var bufferTarget = nz(state.settings.plan.abcBuffer, 350);
    return {
      gapDays: days,
      dailyCost: round2(daily),
      suggested: need,
      bufferTarget: bufferTarget,
      shouldWarn: need > bufferTarget,
      text: need > bufferTarget
        ? '发薪可能晚 ' + days + ' 天，那几天要花 ' + money(need) + '，超过缓冲 ' + money(bufferTarget) + '，建议改缓冲额'
        : ''
    };
  }

  /**
   * 六类预警。只返回数据，界面自己决定怎么显示。
   * level: 'info' 提示 / 'warn' 注意 / 'danger' 危险
   */
  function alerts(state) {
    var cycle = deriveCycle(state);
    var env = envelopeState(state, cycle);
    var meal = mealDaily(state, cycle, env);
    var plan = planView(state, { cycle: cycle, env: env });
    var out = [];

    // 1 吃饭：每日可花摊下来低于提醒线
    var mealLine = nz(state.settings.warn.mealDaily, 25);
    if (meal.perDay < mealLine) {
      out.push({
        type: 'meal', level: meal.perDay < 0 ? 'danger' : 'warn',
        text: cycle.bufferMode
          ? '缓冲剩余每天可花 ' + money(meal.perDay) + '，低于提醒线 ' + money(mealLine)
          : '吃饭今日可花 ' + money(meal.perDay) + '，低于提醒线 ' + money(mealLine)
      });
    }

    // 2 外卖：剩余次数为 0
    if (env.takeout.leftCount <= 0) {
      out.push({
        type: 'takeout', level: 'warn',
        text: '外卖本周期 ' + env.takeout.perCycle + ' 次已用完，再点默认从自由支出'
      });
    }

    // 3 打车：剩余次数少于本周期剩下的晚班数
    if (env.taxi.leftCount < env.taxi.remainingNightShifts) {
      out.push({
        type: 'taxi', level: 'warn',
        text: '打车剩 ' + env.taxi.leftCount + ' 次，本周期还有 ' + env.taxi.remainingNightShifts + ' 个晚班'
      });
    }

    // 4 机动·其他：用到 80% / 100%
    var lines = state.settings.warn.mobilityOther || [80, 100];
    if (env.funding.mobilityShortfall > 0) {
      out.push({ type: 'other', level: 'danger', text: '机动含剩余打车预留缺口 ' + money(env.funding.mobilityShortfall) + '，已从自由支配中预留，排表按剩余资金重算' });
    } else if (env.other.usedPct >= nz(lines[1], 100)) {
      out.push({ type: 'other', level: 'danger', text: '机动·其他已用 100%' });
    } else if (env.other.usedPct >= nz(lines[0], 80)) {
      out.push({ type: 'other', level: 'warn', text: '机动·其他已用 ' + Math.round(env.other.usedPct) + '%' });
    }

    // 5 缓冲
    if (cycle.bufferMode) {
      out.push({
        type: 'buffer', level: 'info',
        text: '缓冲模式：预计发薪日 ' + mdLabel(cycle.expectedPayday) + ' 已过，距最坏发薪日 ' + cycle.daysToPayday + ' 天'
      });
    }
    var ba = bufferAdvice(state);
    if (ba.shouldWarn) {
      out.push({ type: 'buffer', level: 'warn', text: ba.text });
    }

    // 6 自由支配：未来最低余额要变负（第 8 节：写具体是哪个周期、差多少、付不齐排定项）
    if (plan.forecast.willGoNegative) {
      var neg = plan.forecast.rows.filter(function (r) { return r.low < 0; })[0];
      var negNames = (neg.scheduledNames || []).join('、');
      out.push({
        type: 'free', level: 'danger',
        text: neg.label + '差 ' + money(-neg.low) + '，付不齐排定项' +
          (negNames ? '（要付：' + negNames + '）' : '')
      });
    }

    // 7 假期周转金不够（第五轮）：假期周期实发比平常少，周转金盖不住缺口时，差额从余额宝出
    var hol = plan.forecast.holiday;
    if (hol && hol.shortfall > 0) {
      out.push({
        type: 'holiday', level: 'warn',
        text: (hol.shortfallCycle ? cycleLabel(hol.shortfallCycle) : '假期周期') +
          '工资按预计实发 ' + money(nz((state.settings.holiday || {}).expectedSalary, 1600)) +
          ' 算，攒着（假期周转）不够，差 ' + money(hol.firstShortfall || hol.shortfall) + ' 要从余额宝出'
      });
    }
    if (state.lastHolidayShortfall && state.lastHolidayShortfall.cycleKey === cycle.key) {
      out.push({ type: 'holiday', level: 'warn', text: '本期攒着（假期周转）不足，差 ' +
        money(state.lastHolidayShortfall.amount) + '，已从余额宝补到农行' });
    }

    // 8 招行信用卡（第五轮）：每月扣款日的前一天提醒确认农行余额够还本期账单
    var cmbCfg = state.settings.cmb || {};
    var cmbDueDay = nz(cmbCfg.dueDay, 17);
    if (dayOfMonth(state.today) === cmbDueDay - 1) {
      out.push({
        type: 'cmb', level: 'info',
        text: '明天招行自动扣款，确认农行余额够还本期账单'
      });
    }

    return out;
  }

  /* ==================================================================
   * 10. 记一笔的影响（第 6 节）
   * ================================================================== */

  /** 深拷贝并追加一笔，返回新的 state（纯函数，不改传入对象） */
  function withEntry(state, draft) {
    var next = clone(state);
    var cat = findCategory(next, draft.catId);
    var envName = draft.envelope || defaultEnvelope(next, draft.catId, {});
    next.entries = next.entries || [];
    next.entries.push({
      id: draft.id || ('e' + (next.entries.length + 1) + '-' + Math.round(nz(draft.amount, 0) * 100)),
      date: draft.date || next.today,
      time: draft.time || '12:00',
      amount: round2(nz(draft.amount, 0)),
      catId: draft.catId,
      catName: cat.name,
      cat1: cat.parent,
      envelope: envName,
      /* 待核对 / 订阅自动入账等带 account 的流水，按 account 记账户，
         不按信封推（拆分后各分片沿用原 account，对账基数不乱） */
      account: draft.account || undefined,
      pending: draft.pending ? true : undefined,
      auto: draft.auto ? true : undefined,
      autoSubId: draft.autoSubId || undefined,
      splitFrom: draft.splitFrom || undefined,
      note: draft.note || ''
    });
    return next;
  }

  /** 应用一笔流水到账户（应急金扣交行，自由支配扣余额宝；显式 account 优先） */
  function applyEntryToAccounts(state, entry) {
    var next = clone(state);
    var amt = nz(entry.amount, 0);
    var acc = entryAccount(entry);
    if (acc === 'yuebao') next.accounts.yuebao = round2(nz(next.accounts.yuebao, 0) - amt);
    else if (acc === 'abc') next.accounts.abc = round2(nz(next.accounts.abc, 0) - amt);
    else if (acc === 'jiaohang') next.emergency.balance = round2(nz(next.emergency.balance, 0) - amt);
    return next;
  }

  /* ==================================================================
   * 排表匹配检查（第 6 节）+ 发薪日归属（第 12 节）
   * ================================================================== */

  /** 只保留汉字与字母数字，去掉空格与标点，避免「型号 + 空格 + 品类」和连写判不出来 */
  function cnOnly(s) {
    return String(s == null ? '' : s).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  }

  /** 最长公共连续子串长度（汉字/字母数字都算） */
  function commonRunLen(a, b) {
    var best = 0;
    for (var i = 0; i < a.length; i++) {
      for (var j = i + 2; j <= a.length; j++) {
        if (j - i > best && b.indexOf(a.slice(i, j)) >= 0) best = j - i;
      }
    }
    return best;
  }

/**
   * 通用词：只是描述「买了什么东西」的品类/动作词，单独重合不足以判定是同一项。
   * 比如两项东西都带「改件」「拼单」这两个词，属于这一类；
   * 真正的区分词是各自的名词，必须靠它们才能判成同一项。
   */
  var GENERIC_WORDS = [
    '改件', '拼单', '件', '包', '套', '组', '批', '单', '购', '买', '置', '办',
    '材料', '工具', '配件', '耗材', '补充', '替换', '备用', '升级', '改造',
    '手工', 'diy', '模型', '道具', '用品', '装备'
  ];

  function isGenericWord(w) {
    var s = w.toLowerCase();
    for (var i = 0; i < GENERIC_WORDS.length; i++) {
      if (GENERIC_WORDS[i].toLowerCase() === s) return true;
    }
    return false;
  }

  /**
   * 把名称切成词元：中文按 2 字滑窗切，字母数字串整体作为一个词元。
   * 中文按 2 字切是为了让「翻模」「车门」「硅胶」这类区分词能被单独取出来。
   */
  function tokenize(s) {
    var t = cnOnly(s);
    var out = [];
    var buf = '';
    // 先抽出连续的字母数字（型号，形如两个字母 + 四位数字）
    var re = /[A-Za-z0-9]+/g, m;
    var marks = [];
    while ((m = re.exec(t)) !== null) marks.push([m.index, m.index + m[0].length, m[0]]);
    var pos = 0;
    while (pos < t.length) {
      var hit = null;
      for (var i = 0; i < marks.length; i++) {
        if (marks[i][0] === pos) { hit = marks[i]; break; }
      }
      if (hit) { out.push({ w: hit[2], len: hit[2].length, at: pos }); pos = hit[1]; continue; }
      if (pos + 2 <= t.length) out.push({ w: t.slice(pos, pos + 2), len: 2, at: pos });
      else if (pos + 1 === t.length) out.push({ w: t.slice(pos), len: 1, at: pos });
      pos += 2;
    }
    buf = null;
    return { text: t, tokens: out };
  }

  /**
   * 判断两段文本是否指向同一件事。
   * 返回 { hit, runLen, shared }：
   *   · 名称完全包含（一方包含另一方）→ 直接算命中
   *   · 否则要求共享至少一个「非通用」的词元（区分词），才算命中
   */
  function sameThingName(a, b) {
    var A = tokenize(a), B = tokenize(b);
    var at = A.text, bt = B.text;
    if (!at || !bt) return { hit: false, runLen: 0, shared: '' };

    // 一方包含另一方（规格第 6 节明确允许）。
    // 但如果被包含进去的短文本整体只是一个通用词（「改件」「包」），
    // 那不足以判定是同一项，跳过继续找区分词。
    if (at.length >= 2 && bt.indexOf(at) >= 0 && !isGenericWord(at)) {
      return { hit: true, runLen: at.length, shared: at, contain: true };
    }
    if (bt.length >= 2 && at.indexOf(bt) >= 0 && !isGenericWord(bt)) {
      return { hit: true, runLen: bt.length, shared: bt, contain: true };
    }

    // 否则看是否共享区分词
    var map = {};
    for (var i = 0; i < B.tokens.length; i++) {
      if (isGenericWord(B.tokens[i].w)) continue;
      map[B.tokens[i].w] = B.tokens[i].len;
    }
    var best = { hit: false, runLen: 0, shared: '' };
    for (var j = 0; j < A.tokens.length; j++) {
      var w = A.tokens[j].w;
      if (isGenericWord(w)) continue;
      if (map[w] !== undefined && w.length >= 2 && w.length > best.runLen) {
        best = { hit: true, runLen: w.length, shared: w, contain: false };
      }
    }
    return best;
  }

  /**
   * 排表匹配检查（第 6 节）：避免同一笔钱在排表和流水里各算一次。
   * 只在出钱信封是自由支配时检查；名称重合或金额接近满足任一即命中。
   * 只提示最像的一条：名称重合优先，其次金额最接近。
   * 不用金额下限，避免日常小额支出频繁误判。
   */
  function planMatchCheck(state, draft) {
    var amount = round2(nz(draft.amount, 0));
    var envName = draft.envelope || defaultEnvelope(state, draft.catId, draft);
    if (envName !== 'free') {
      return { applies: false, reason: '出钱信封不是自由支配，不检查', hit: null, candidates: [] };
    }
    if (amount <= 0) {
      return { applies: false, reason: '金额为 0', hit: null, candidates: [] };
    }

    var cat = findCategory(state, draft.catId);
    var note = cnOnly(draft.note || '');
    var catName = cnOnly(cat.name);
    var candidates = (state.planItems || []).filter(function (it) { return !it.removed; });

    var hits = [];
    for (var i = 0; i < candidates.length; i++) {
      var it = candidates[i];
      var nm = cnOnly(it.name);
/* 分类名和备注分别比对：备注往往才是关键信息，
         拼在一起会让分类名稀释掉备注的强信号。任一段命中即算名称重合。 */
      var nmHitCat = catName ? sameThingName(catName, nm) : { hit: false };
      var nmHitNote = note ? sameThingName(note, nm) : { hit: false };
      var nmHit = nmHitNote.hit ? nmHitNote : nmHitCat;
      if (nmHitCat.hit && !nmHitNote.hit) nmHit = nmHitCat;
      // 名称重合：一方包含另一方，或共享同一个区分词（通用的「改件」「包」不算）
      var nameHit = nmHit.hit;
      var amtHit = false, diff = null;
      if (isNum(it.amount) && it.amount > 0) {
        diff = round2(Math.abs(amount - it.amount));
        amtHit = diff <= round2(it.amount * 0.10);   // 相差不超过该项金额的 10%
      }
      if (!nameHit && !amtHit) continue;
      hits.push({
        id: it.id,
        name: it.name,
        type: it.type,
        amount: it.amount,
        nameHit: nameHit,
        runLen: nmHit.runLen,
        shared: nmHit.shared,
        contain: !!nmHit.contain,
        amountHit: amtHit,
        amountDiff: diff,
        reason: nameHit
          ? (nmHit.contain ? '名称重合' : '名称重合「' + nmHit.shared + '」')
          : '金额接近'
      });
    }
    if (!hits.length) return { applies: true, hit: null, candidates: [] };

    // 只提示最像的一条：名称重合优先，其次金额最接近
    hits.sort(function (a, b) {
      if (a.nameHit !== b.nameHit) return a.nameHit ? -1 : 1;
      if (a.nameHit && b.nameHit) {
        // 都是名称命中：包含关系 > 共享区分词；再看共享词长短
        if (a.contain !== b.contain) return a.contain ? -1 : 1;
        if (a.runLen !== b.runLen) return b.runLen - a.runLen;
        // 名称一样长时，若一项金额也接近，作为更强的证据
        if (a.amountHit !== b.amountHit) return a.amountHit ? -1 : 1;
      }
      var ad = a.amountDiff == null ? Infinity : a.amountDiff;
      var bd = b.amountDiff == null ? Infinity : b.amountDiff;
      if (ad !== bd) return ad - bd;
      // 金额也接近时优先提示条件项（用户还没买，更可能是这次要记的）
      if (a.type !== b.type) return a.type === 'conditional' ? -1 : 1;
      return nz(b.amount, 0) - nz(a.amount, 0);
    });

    return { applies: true, hit: hits[0], candidates: hits };
  }

  /**
   * 发薪日当天的支出归属（第 12 节）：
   * 日期等于某个发薪日时，表单出现二选一「这笔属于：X 月周期 / Y 月周期」。
   *
   * 默认值：发薪日当天的账一律默认算「上一周期」——
   * 这一天的支出在结算前发生，通常属于刚结束的周期；补记同样默认上一周期，
   * 用户可在表单里手动改选新周期。
   */
  function paydayAttribution(state, dateStr, entryTime) {
    var records = (state.paydayRecords || []).slice().sort();
    var isPayday = records.indexOf(dateStr) >= 0;
    if (!isPayday) {
      return { isPayday: false, options: [], defaultCycleKey: '' };
    }
    // 该发薪日开启的新周期 = 日期所在月；上一周期 = 前一个月
    var newKey = monthKey(dateStr);
    var prevKey = addMonthsKey(newKey, -1);
    return {
      isPayday: true,
      paydayDate: dateStr,
      options: [
        { key: prevKey, label: cycleLabel(prevKey), desc: '发薪日当天记的默认' },
        { key: newKey, label: cycleLabel(newKey), desc: '想算进新周期就改选这个' }
      ],
      defaultCycleKey: prevKey
    };
  }

  /**
   * 「记下后的影响」：算出自由支配最低点怎么变、哪些条件项的可买周期变了。
   */
  function impactOfEntry(state, draft) {
    var amount = round2(nz(draft.amount, 0));
    var envName = draft.envelope || defaultEnvelope(state, draft.catId, draft);
    if (envName !== 'free' || amount <= 0) {
      return { applies: false, reason: envName !== 'free' ? '出钱信封不是自由支配，不影响排表' : '金额为 0' };
    }

    var before = planView(state);
    var probe = clone(state);
    probe.entries = probe.entries || [];
    var cat = findCategory(probe, draft.catId);
    var id = draft.id || '__impact__';
    probe.entries.push({
      id: id, date: draft.date || probe.today, time: draft.time || '12:00',
      amount: amount, catId: draft.catId, catName: cat.name, cat1: cat.parent,
      envelope: 'free', note: draft.note || ''
    });
    probe.accounts.yuebao = round2(nz(probe.accounts.yuebao, 0) - amount);
    var after = planView(probe);

    var minBefore = before.forecast.minLow;
    var minAfter = after.forecast.minLow;

    var changed = [];
    for (var i = 0; i < after.conditional.length; i++) {
      var a = after.conditional[i];
      for (var j = 0; j < before.conditional.length; j++) {
        var b = before.conditional[j];
        if (a.id === b.id && a.cycleKey !== b.cycleKey) {
          changed.push({ name: a.name, from: b.cycleKey, to: a.cycleKey });
        }
      }
    }
    var newlyBought = [];
    for (var m = 0; m < after.conditional.length; m++) {
      var aa = after.conditional[m];
      if (aa.id === id) continue;
      for (var n = 0; n < before.conditional.length; n++) {
        var bb = before.conditional[n];
        if (aa.id === bb.id && !bb.affordable && aa.affordable) newlyBought.push(aa.name);
      }
    }

    var lowRow = null;
    for (var r = 0; r < before.forecast.rows.length; r++) {
      if (before.forecast.rows[r].low === minBefore) lowRow = before.forecast.rows[r];
    }

    var head = (lowRow ? lowRow.label : '未来') + '最低点 ' + money(minBefore) + ' → ' + money(minAfter);
    /* 措辞按方向区分：变早说「提前到 X 月」，变晚说「推到 X 月」 */
    var changedText = changed.map(function (c) {
      var earlier = monthsBetweenKeys(c.to, c.from) > 0;   // to 比 from 早
      return c.name + (earlier ? '提前到' : '推到') + shortOf(c.to);
    }).join('、');
    var tail = changed.length
      ? '，' + changedText
      : (newlyBought.length ? '，' + newlyBought.join('、') + '变得可买' : '，条件项可买周期不变');

    return {
      applies: true,
      minBefore: minBefore,
      minAfter: minAfter,
      safeBefore: before.safeSpend,
      safeAfter: after.safeSpend,
      changed: changed,
      newlyBought: newlyBought,
      text: head + tail,
      cycleLabel: lowRow ? lowRow.label : ''
    };
  }

  /* ==================================================================
   * 11. 分类默认信封（第 6 节）
   * ================================================================== */

  function defaultEnvelope(state, catId, ctx) {
    var cat = findCategory(state, catId);
    var node = cat.node || {};
    var cycle = ctx && ctx.cycle ? ctx.cycle : deriveCycle(state);
    var env = ctx && ctx.env ? ctx.env : envelopeState(state, cycle);

    if (cat.name === '外卖（计次）' && env.takeout.exhausted) return 'free';
    if (cat.name === '打车（计次）' && env.taxi.exhausted) return 'free';
    if (node.counted) {
      var countedEnv = node.counted === 'takeout' ? 'food' : 'taxi';
      return node.overrides && node.overrides[countedEnv] ? node.overrides[countedEnv] : countedEnv;
    }
    return node.defaultEnvelope || 'other';
  }

  /** 某分类在本周期是第几次（决定默认信封用不用切自由支配） */
  function categoryCounter(state, catId, cycleKey) {
    var ids = [catId];
    return countEntries(state, { cycleKey: cycleKey, catIds: ids }) + 1;
  }

  /* ==================================================================
   * 12. 大目标 / 应急金 / 定期（第 13 节）
   * ================================================================== */

  function cycleDistance(fromKey, toKey) {
    var a = +fromKey.slice(0, 4) * 12 + (+fromKey.slice(5, 7)) ;
    var b = +toKey.slice(0, 4) * 12 + (+toKey.slice(5, 7));
    return b - a;
  }

  /** 大目标应拨 =（目标 − 已攒）÷ 剩余周期数 */
  function goalPlan(state, goal, cycleKey) {
    var target = nz(goal.target, 0);
    var saved = nz(goal.saved, 0);
    var remainAmt = round2(Math.max(0, target - saved));
    var dist = cycleDistance(cycleKey, goal.cycleKey);
    var remainCycles = Math.max(1, dist + 1);
    return {
      id: goal.id,
      name: goal.name,
      target: target,
      saved: saved,
      remain: remainAmt,
      cycleKey: goal.cycleKey,
      cycleLabel: cycleLabel(goal.cycleKey),
      remainCycles: remainCycles,
      perCycle: round2(remainAmt / remainCycles),
      pct: target > 0 ? Math.min(100, round2((saved / target) * 100)) : 0,
      done: saved >= target && target > 0
    };
  }

  function goalPlans(state) {
    var cycle = deriveCycle(state);
    var list = (state.goals || []).slice().sort(function (a, b) {
      return nz(a.order, 0) - nz(b.order, 0);
    });
    return list.map(function (g) { return goalPlan(state, g, cycle.key); });
  }

  /** 「收到绩效」：有进行中的目标时全部投进目标，按顺序先填满一个 */
  function allocateBonus(state, amount) {
    var amt = round2(nz(amount, 0));
    var goals = (state.goals || []).slice().sort(function (a, b) { return nz(a.order, 0) - nz(b.order, 0); });
    var active = goals.filter(function (g) { return nz(g.saved, 0) < nz(g.target, 0); });
    if (!active.length) {
      return { toGoal: [], toDeposit: round2(amt / 2), toYuebao: round2(amt - amt / 2), note: '没有进行中的目标，一半进定期一半进余额宝' };
    }
    var left = amt;
    var toGoal = [];
    for (var i = 0; i < active.length && left > 0; i++) {
      var g = active[i];
      var need = round2(nz(g.target, 0) - nz(g.saved, 0));
      var give = round2(Math.min(left, need));
      if (give <= 0) continue;
      toGoal.push({ id: g.id, name: g.name, amount: give });
      left = round2(left - give);
    }
    return { toGoal: toGoal, toDeposit: 0, toYuebao: left, note: toGoal.length ? '全部投进目标：' + toGoal.map(function (t) { return t.name; }).join('、') : '' };
  }

  /** 应急金：动用过就一次补完，否则每周期拨固定额直到目标 */
  function emergencyPlan(state) {
    var cfg = state.settings.emergency || {};
    var target = nz(cfg.target, 10000);
    var perCycle = nz(cfg.perCycle, 500);
    var balance = nz(state.emergency.balance, 0);
    // 保留旧的独立动用记录；新应急金流水直接参与统计，不另写一份动用记录。
    var uses = (state.emergency.uses || []).slice().concat((state.entries || []).filter(function (e) {
      return e.envelope === 'emergency' && entryAccount(e) === 'jiaohang' && !e.pending;
    }).map(function (e) {
      return { id: e.id, date: e.date, amount: e.amount, reason: e.note || e.catName || '应急金支出',
        entryCycleKey: e.cycleKey || cycleKeyForDate(state, e.date), reviewOnly: !!e.reviewOnly };
    }));
    var lastPayday = (state.paydayRecords || []).slice().sort().pop() || '';
    var currentCycleKey = deriveCycle(state).key;
    var usedSince = uses.filter(function (u) {
      if (u.entryCycleKey) return !u.reviewOnly && u.entryCycleKey === currentCycleKey;
      return !lastPayday || u.date > lastPayday;
    });
    var usedTotal = sum(usedSince, function (u) { return u.amount; });
    var amount = usedSince.length
      ? round2(Math.min(target, balance + usedTotal) - balance)
      : round2(Math.min(perCycle, target - balance));

    return {
      target: target,
      balance: round2(balance),
      perCycle: perCycle,
      usedTotal: round2(sum(uses, function (u) { return u.amount; })),
      usedSincePayday: usedTotal,
      touched: usedSince.length > 0,
      amount: round2(Math.max(0, amount)),
      shortfall: round2(Math.max(0, target - balance)),
      pct: target > 0 ? Math.min(100, round2((balance / target) * 100)) : 0,
      cyclesToFull: perCycle > 0 ? Math.ceil(Math.max(0, target - balance) / perCycle) : 0,
      uses: uses.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; })
    };
  }

/** 定期存单（第 13 节）：记本金和到期日，不记利率
   起始数据用 date 存开出日，新记录用 openDate，这里两种都认 */
  function depositPlans(state) {
    return (state.deposits || []).slice().sort(function (a, b) {
   return (a.dueDate || a.date || '') < (b.dueDate || b.date || '') ? -1 : 1;
    }).map(function (d) {
      var open = d.openDate || d.date || '';
      return {
      id: d.id,
        principal: round2(nz(d.principal, 0)),
        openDate: open,
        dueDate: d.dueDate || (open ? addYears(open, 1) : ''),
 note: d.note || '',
        term: d.term || '一年期'
      };
    });
  }

  function makeDeposit(state, principal, openDate) {
    var p = round2(nz(principal, 0));
    var open = openDate || state.today;
    var due = openDate ? addYears(open, 1) : '';
    return { id: 'd' + (state.deposits || []).length + '-' + Math.round(p * 100), principal: p, openDate: open, dueDate: due, note: '' };
  }

  function addYears(s, n) {
    var d = parseYmd(s);
    var ny = d.getFullYear() + n;
    var m = d.getMonth() + 1;
    var day = Math.min(d.getDate(), daysInMonth(ny, m));
    return ny + '-' + pad2(m) + '-' + pad2(day);
  }

  /* ==================================================================
   * 13. 发薪日流程（第 12 节）
   * ================================================================== */

  /** 按记账算出农行应有余额（用于对账） */
  function expectedAbcBalance(state, cycleKey) {
    var opening = nz(state.cycleAbcOpening, nz(state.accounts.abc, 0));
    var list = entriesOfCycle(state, cycleKey);
    var spent = 0;
    for (var i = 0; i < list.length; i++) {
      if (entryAccount(list[i]) === 'abc') spent += nz(list[i].amount, 0);
  }
    return round2(opening - spent);
  }

  /**
   * 按记账算出余额宝应有余额（用于对账）。
   * 余额宝 = 上一周期发薪日扫入后的余额 − 本周期自由支配支出 − 本周期买掉的条件项
   */
  function expectedYuebaoBalance(state, cycleKey) {
    var opening = nz(state.yuebaoOpening, nz(state.accounts.yuebao, 0));
    var list = entriesOfCycle(state, cycleKey);
    var spent = 0;
    for (var i = 0; i < list.length; i++) {
      if (entryAccount(list[i]) === 'yuebao') spent += nz(list[i].amount, 0);
    }
    return round2(opening - spent);
  }

  /* 旧名兼容（内部已全部改用 expectedYuebaoBalance） */
  function expectedCangzheBalance(state, cycleKey) { return expectedYuebaoBalance(state, cycleKey); }

  /**
   * 第 12 节对账（第五轮加招行总欠款）：比较「农行 − 招行总欠款 + 余额宝」的合计。
   * 记账算出的应有合计 vs 用户填的实际合计；对不上提示补记差额。
   * 招行信用卡每月 17 日从农行自动全额扣款 —— 钱还在农行里、但已经被划走了，
   * 所以实际余额要先减去招行总欠款再比。
   */
  function reconcileTotal(state, input) {
    var cycleKey = (input.cycle && input.cycle.key) || deriveCycle(state).key;
    var expectAbc = expectedAbcBalance(state, cycleKey);
    var expectYue = expectedYuebaoBalance(state, cycleKey);
    var expectTotal = round2(expectAbc - nz(state.cycleCmbOpening, 0) + expectYue);
    var cmbDebt = round2(nz(input.cmbDebt, nz(state.cmbDebt, 0)));

    var abcActual = isNum(input.abcActual) ? round2(input.abcActual) : null;
    var yueActual = isNum(input.yuebaoActual) ? round2(input.yuebaoActual) : null;
    var hasBoth = (abcActual !== null && yueActual !== null);

    var actualTotal = hasBoth ? round2(abcActual - cmbDebt + yueActual) : null;
    var diff = hasBoth ? round2(actualTotal - expectTotal) : null;

    return {
   expectedAbc: expectAbc,
      expectedYuebao: expectYue,
      expectedCangzhe: expectYue,
      cmbDebt: cmbDebt,
      expectedTotal: expectTotal,
      abcActual: abcActual,
      yuebaoActual: yueActual,
      actualTotal: actualTotal,
   diff: diff,
      ready: hasBoth,
      // 对上（或补记完）后不再提示
      balanced: hasBoth && Math.abs(diff) < 0.005,
   needFillSalary: !isNum(input.salary) || nz(input.salary, 0) <= 0,
      needFillBoth: !hasBoth
    };
  }

  /**
   * 生成转账清单（第五轮）。固定顺序：
   *   1 农行 ↔ 余额宝（调到缓冲额）—— 假期周期换成「从攒着取出 X 元转到农行」
   *   2 工行 → 农行（假期周期：实发全部转入）
   *   3 工行 → 交行（应急金）
   *   4 工行 → 目标账户
   *   5 工行 → 攒着（假期周转）—— 余额已够覆盖下个假期周期缺口时自动跳过
   *   6 工行 → 定期（剩下的全部）
   * 工资扣掉农行拨款后不够时，应急金 → 目标 → 周转的欠额顺延；定期没有欠额。
   * 假期周期：应急金、目标、周转、定期这一期都为 0，欠额同样顺延。
   */
  function paydayPlan(state, input) {
    input = input || {};
    var cycle = input.cycle || deriveCycle(state);
    var salary = round2(nz(input.salary, 0));
    var paydayDate = input.paydayDate || state.today;
    var newCycleKey = monthKey(paydayDate);
    var holidayCycle = isHolidayCycle(state, newCycleKey);
    var abcActual = round2(nz(input.abcActual, nz(state.accounts.abc, 0)));
    var cmbDebt = round2(nz(input.cmbDebt, nz(state.cmbDebt, 0)));
    var bufferTarget = nz(state.settings.plan.abcBuffer, 350);
    var env = state.settings.envelopes;
    var toBank = round2(sum([
      { v: env.food }, { v: env.sub }, { v: env.mobility }, { v: env.free }
    ], function (x) { return x.v; }));
    var holidayFund = round2(nz(state.accounts.holiday, 0));
    var perTransfer = nz((state.settings.holiday || {}).transferPerCycle, 300);

    var steps = [];

    // 1 农行 ↔ 余额宝 / 假期周期：从攒着取出
    var diff = round2(bufferTarget + cmbDebt - abcActual);
    var holidayTake = 0, holidayFromFund = 0, holidayFromYuebao = 0;
    if (holidayCycle) {
      holidayTake = round2(Math.max(0, toBank - salary));
      holidayFromFund = round2(Math.min(holidayTake, holidayFund));
      holidayFromYuebao = round2(holidayTake - holidayFromFund);
      steps.push({
        id: 'holiday-abc',
        order: 1,
        title: '从攒着取出 ' + money(holidayTake) + ' 转到农行',
        detail: '假期周期实发 ' + money(salary) + '，四信封要 ' + money(toBank) +
          '，差 ' + money(holidayTake) + '：假期周转出 ' + money(holidayFromFund) +
          (holidayFromYuebao > 0 ? '，不够的 ' + money(holidayFromYuebao) + ' 从余额宝补' : ''),
        amount: holidayTake,
        direction: holidayFromYuebao > 0 ? '假期周转 + 余额宝 → 农行' : '假期周转 → 农行',
        from: '攒着（假期周转）', to: '农行',
        done: holidayTake === 0,
        shortfall: 0,
        holidayTake: holidayTake, holidayFromFund: holidayFromFund, holidayFromYuebao: holidayFromYuebao
      });
    } else {
      steps.push({
        id: 'abc-yuebao',
        order: 1,
        title: '农行 ↔ 余额宝',
        detail: '农行扣除招行总欠款 ' + money(cmbDebt) + ' 后留 ' + money(bufferTarget) + (diff >= 0 ? '，不够的从余额宝补' : '，多的扫进余额宝'),
        amount: round2(Math.abs(diff)),
        direction: diff >= 0 ? '余额宝 → 农行' : '农行 → 余额宝',
        from: diff >= 0 ? '余额宝' : '农行',
        to: diff >= 0 ? '农行' : '余额宝',
        done: diff === 0,
        shortfall: 0
      });
    }

    // 2 工行 → 农行（假期周期：实发全部转入）
    steps.push({
      id: 'icbc-abc', order: 2,
      title: '工行 → 农行',
      detail: holidayCycle
        ? '假期周期：实发 ' + money(salary) + ' 全部转入农行'
        : '四个花钱信封满额 ' + money(toBank) + '，加上缓冲 ' + money(bufferTarget),
      amount: holidayCycle ? Math.max(0, salary) : toBank,
      direction: '工行 → 农行', from: '工行', to: '农行',
      done: false, shortfall: 0
    });

    // 3 工行 → 交行（应急金）
    var em = emergencyPlan(state);
    var carry = state.paydayCarry || {};
    var emWant = round2(Math.min(Math.max(0, em.target - em.balance), em.amount + nz(carry.emergency, 0)));
    steps.push({
      id: 'icbc-jiaohang', order: 3,
      title: '工行 → 交行',
      detail: holidayCycle
        ? '假期周期本笔为 0，应急金欠 ' + money(emWant) + '，顺延到下个发薪日'
        : (em.touched
          ? '应急金这个周期动用过，一次补到 ' + money(em.target)
          : '没动过，拨 ' + money(emWant) + '（含上期欠额），还差 ' + money(Math.max(0, em.target - em.balance - emWant))),
      amount: holidayCycle ? 0 : emWant,
      shortfall: holidayCycle ? emWant : 0,
      direction: '工行 → 交行', from: '工行', to: '交行',
      done: false
    });

    // 4 工行 → 目标账户
    var plans = goalPlans(state);
    var activeGoal = null;
    for (var g = 0; g < plans.length; g++) { if (!plans[g].done) { activeGoal = plans[g]; break; } }
    var goalWant = activeGoal ? round2(Math.min(activeGoal.remain, activeGoal.perCycle + nz(carry.goal, 0))) : 0;
    steps.push({
      id: 'icbc-goal', order: 4,
      title: '工行 → 目标账户',
      detail: holidayCycle
        ? '假期周期本笔为 0' + (goalWant > 0 ? '，目标账户欠 ' + money(goalWant) + '，顺延到下个发薪日' : '，没有进行中的大目标')
        : (activeGoal
          ? activeGoal.name + '还差 ' + money(activeGoal.remain) + '，本周期应拨 ' + money(activeGoal.perCycle)
          : '没有进行中的大目标'),
      amount: holidayCycle ? 0 : goalWant,
      shortfall: holidayCycle ? goalWant : 0,
      direction: '工行 → 目标账户', from: '工行', to: '目标账户',
      done: false
    });

    // 5 工行 → 攒着（假期周转）：余额已够覆盖下个假期周期缺口时自动跳过
    var gap = holidayGap(state);
    var nextHol = nextHolidayKey(state, newCycleKey);
    var skipTransfer = !holidayCycle && !!nextHol && holidayFund >= gap;
    var holidayWant = round2(perTransfer + nz(carry.holiday, 0));
    steps.push({
      id: 'icbc-holiday', order: 5,
      title: '工行 → 攒着（假期周转）',
      detail: holidayCycle
        ? '假期周期本笔为 0，周转欠 ' + money(holidayWant) + '，顺延到下个发薪日'
        : (skipTransfer
          ? '已跳过：攒着（假期周转）' + money(holidayFund) + ' 已够覆盖 ' + cycleLabel(nextHol) + '的缺口 ' + money(gap)
          : '拨 ' + money(holidayWant) + ' 进假期周转金，供 ' + (nextHol ? cycleLabel(nextHol) : '以后的') + '假期周期补缺口'),
      amount: holidayCycle ? 0 : (skipTransfer ? 0 : holidayWant),
      shortfall: holidayCycle ? holidayWant : 0,
      direction: '工行 → 攒着（假期周转）', from: '工行', to: '攒着（假期周转）',
      done: false
    });

    // 6 工行 → 定期（剩下的全部）
    var remainPool = round2(salary - steps[1].amount);
    steps.push({
      id: 'icbc-deposit', order: 6,
      title: '工行 → 定期',
      detail: holidayCycle
        ? '假期周期本笔为 0（定期是剩下的全部，没有欠额）'
        : '剩下全部转进定期，生成一张一年期存单',
      amount: holidayCycle ? 0 : Math.max(0, remainPool),
      direction: '工行 → 定期', from: '工行', to: '定期',
      done: false, shortfall: 0, isRemainder: true
    });

    // 工资不够时的优先级：应急金 → 目标 → 周转；定期没有欠额
    var shortfall = 0;
    var abcShort = 0;      // 农行拨不满的差额（不顺延，只是提示）
    if (!holidayCycle && remainPool < 0) {
      shortfall = round2(-remainPool);
      abcShort = shortfall;
      steps[1].amount = 0;
      steps[1].shortfall = 0;              // 农行不顺延
      steps[1].detail = '工资不够，本周期信封拨不满，差 ' + money(shortfall);
      /* 后面三笔全部为 0；只有应急金、目标、周转的欠额顺延，定期没有。 */
      steps[2].shortfall = steps[2].amount;                 // 应急金想拨多少就欠多少
      steps[2].amount = 0;
      steps[2].detail = '工资不够 ' + money(toBank) + '，本笔为 0，应急金欠 ' + money(steps[2].shortfall) + '，顺延到下个发薪日';
      steps[3].shortfall = steps[3].amount;                 // 同理
      steps[3].amount = 0;
      steps[3].detail = '工资不够 ' + money(toBank) + '，本笔为 0' +
        (steps[3].shortfall > 0 ? '，目标账户欠 ' + money(steps[3].shortfall) + '，顺延到下个发薪日' : '，没有进行中的大目标');
      steps[4].shortfall = steps[4].amount;                 // 周转同理
      steps[4].amount = 0;
      steps[4].detail = '工资不够 ' + money(toBank) + '，本笔为 0，周转欠 ' + money(steps[4].shortfall) + '，顺延到下个发薪日';
      steps[5].amount = 0;
      steps[5].shortfall = 0;            // 定期是「剩下的全部」，没有欠额
      steps[5].detail = '工资不够 ' + money(toBank) + '，本笔为 0（定期是剩下的全部，没有欠额）';
    } else if (!holidayCycle) {
      var pool = remainPool;
      var order = ['icbc-jiaohang', 'icbc-goal', 'icbc-holiday'];
      for (var oi = 0; oi < order.length; oi++) {
        var st = null;
        for (var si = 0; si < steps.length; si++) if (steps[si].id === order[oi]) st = steps[si];
        var want = st.amount;
        var give = round2(Math.max(0, Math.min(pool, want)));
        var lack = round2(want - give);
        st.amount = give;
        if (lack > 0) {
          st.shortfall = lack;
          st.detail += '；工资不够，差额 ' + money(lack) + ' 顺延到下个发薪日';
        }
        pool = round2(pool - give);
      }
      steps[5].amount = round2(Math.max(0, pool));
      steps[5].shortfall = 0;      // 定期是「剩下的全部」，没有欠额可言
    }

    // 对账（第 12 节，第五轮）：比较「农行 − 招行总欠款 + 余额宝」的合计
    var rec = reconcileTotal(state, { cycle: cycle, abcActual: abcActual, yuebaoActual: input.yuebaoActual, cmbDebt: cmbDebt });

    return {
      cycle: cycle,
      salary: salary,
      abcActual: abcActual,
      cmbDebt: cmbDebt,
      toBank: toBank,
      bufferTarget: bufferTarget,
      isHolidayCycle: holidayCycle,
      holidayTake: holidayTake,
      holidayFromFund: holidayFromFund,
      holidayFromYuebao: holidayFromYuebao,
      steps: steps,
      emergency: em,
      goal: activeGoal,
      abcTopUp: round2(Math.abs(diff)),
      abcTopUpDirection: diff >= 0 ? '余额宝 → 农行' : '农行 → 余额宝',
      yuebaoDelta: round2(-diff),
reconcile: {
      expected: rec.expectedAbc,
        expectedTotal: rec.expectedTotal,
        actual: rec.abcActual,
        actualTotal: rec.actualTotal,
        diff: rec.diff,
        matched: rec.balanced,
        hint: rec.ready
          ? (rec.balanced ? '' : '合计差 ' + money(rec.diff) + '，请把差额补记到具体信封')
          : '把农行和余额宝的实际余额都填上才能对账'
      },
reconcileTotal: rec,
      // 只有应急金、目标、周转的欠额顺延；农行拨不满和定期都不顺延（第 12 节）
      abcShortfall: abcShort,
      totalOut: round2(steps[1].amount + steps[2].amount + steps[3].amount + steps[4].amount + steps[5].amount),
      carriedOver: round2(steps[2].shortfall + steps[3].shortfall + steps[4].shortfall)
    };
  }

  /** 上一周期的复盘数据（第 14 节） */
  function buildReview(state, cycleKey) {
    var env = envelopeState(state, cycleKey);
    var list = env._entries;
    var byCat = {};
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.envelope === 'income') continue;
      var key = e.cat1 + ' · ' + e.catName;
      if (!byCat[key]) byCat[key] = { name: key, amount: 0, count: 0 };
      byCat[key].amount = round2(byCat[key].amount + nz(e.amount, 0));
      byCat[key].count++;
    }
    var cats = [];
    for (var k in byCat) if (Object.prototype.hasOwnProperty.call(byCat, k)) cats.push(byCat[k]);
    cats.sort(function (a, b) { return b.amount - a.amount; });

    /* 第 8 节「已买记录」/ 第 14 节：「本周期买了」只列实际转成支出的
   排表项（排定项和条件项都算），不列「可买」的。
   实际买入记录在 state.boughtLog 里（Store.removePlanItem 写）。*/
    var bought = [];
    var deferred = [];
    var fc = forecast(state, { cycle: deriveCycle(state), env: env, horizon: 6 });
    allocateConditionals(state, fc);
    var blog = state.boughtLog || [];
    for (var bi = 0; bi < blog.length; bi++) {
      if (blog[bi].cycleKey === cycleKey) bought.push(blog[bi].name);
    }
    // 排表里还挂着、但本周期过了预测周期仍排不进的，记为推迟
    for (var m = 0; m < fc.items.length; m++) {
      if (fc.items[m].affordable) continue;         // 可买的不算「本周期买了」
      if (fc.items[m].badge === '未估价') deferred.push(fc.items[m].name + '（未估价）');
      else deferred.push(fc.items[m].name);
    }

    var em = emergencyPlan(state);
    var goals = goalPlans(state);

var advice = [];
    var history = state.cycleHistory || [];
    var need = nz(state.settings.review.overspendCycles, 2);
    var rows = [
      { key: 'food', name: '吃饭', quota: env.food.quota, used: env.food.used },
      { key: 'sub', name: '固定订阅', quota: env.sub.quota, used: env.sub.used },
      { key: 'taxi', name: '机动·打车', quota: env.taxi.quotaAmount, used: env.taxi.used },
      { key: 'other', name: '机动·其他', quota: env.other.quota, used: env.other.used },
      { key: 'free', name: '自由支配', quota: env.free.quota, used: env.free.used }
    ];

    /* 第 14 节：某信封连续 2 个周期超支，或连续 2 个周期结余超过额度 30%，
       才建议调额度；只有一个周期的数据时不给建议。
       cycleHistory 存的是往期 buildReview 结果，envelopes 里带 quota / used。*/
    function envelopeOf(rec, key) {
      var list = (rec && rec.envelopes) || [];
      for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
      return null;
    }

    // 往期倒着看，找出连续同向的周期数（含本周期）
    function streakOf(key, dir) {
      // dir: 'over' 超支 / 'surplus' 大幅结余
      var n = 0;
      var cur = { quota: rows.filter(function (x) { return x.key === key; })[0].quota,
                  used:  rows.filter(function (x) { return x.key === key; })[0].used };
      function hit(r) {
        if (!r) return false;
        if (r.quota <= 0) return false;
        if (dir === 'over') return r.used > r.quota;
        return ((r.quota - r.used) / r.quota) * 100 >= nz(state.settings.review.bigSurplusPct, 30);
      }
      if (hit(cur)) n = 1;
      var k = cycleKey;
      for (var i = history.length - 1; i >= 0; i--) {
        if (history[i].cycleKey !== k) continue;
        if (hit(envelopeOf(history[i], key))) n++;
        k = addMonthsKey(k, -1);
      }
      return n;
    }

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var overN = streakOf(row.key, 'over');
      if (overN >= need) {
        advice.push(row.name + '连续 ' + overN + ' 个周期超支，建议调高额度');
      }
      var surplusN = streakOf(row.key, 'surplus');
      if (surplusN >= need) {
        advice.push(row.name + '连续 ' + surplusN + ' 个周期结余超过额度的 ' +
          nz(state.settings.review.bigSurplusPct, 30) + '%，可以调低');
      }
    }

    return {
      cycleKey: cycleKey,
      cycleLabel: cycleLabel(cycleKey),
      envelopes: rows,
      categories: cats,
      taxiCount: env.taxi.usedCount,
      takeoutCount: env.takeout.usedInQuota,
      totalSpent: sum(list, function (e) { return e.envelope === 'income' ? 0 : e.amount; }),
      totalIncome: sum(list, function (e) { return e.envelope === 'income' ? -e.amount : 0; }),
      incomeCategories: incomeCategories().map(function (cat) {
        return { id: cat.id, name: cat.name, amount: sum(list, function (e) {
          return e.envelope === 'income' && e.catId === cat.id ? -e.amount : 0;
        }) };
      }),
      bought: bought,
      boughtRecords: blog.filter(function (r) { return r.cycleKey === cycleKey; }),
      deferred: deferred,
      savings: { yuebao: env.yuebao, abc: env.abcBalance, deposit: sum(depositPlans(state), function (d) { return d.principal; }) },
      emergency: em,
      goals: goals,
      advice: advice
    };
  }

  /** 执行发薪日：返回新的 state（纯函数） */
  function applyPayday(state, plan, input) {
    input = input || {};
    var next = clone(state);
    var paydayDate = input.paydayDate || state.today;
    if (state.lastPayday === paydayDate && state.lastPaydayFlowAt) return next;
    var cycle = plan.cycle;
    if (isNum(input.yuebaoActual)) next.accounts.yuebao = round2(input.yuebaoActual);

    // 步骤 1：农行 ↔ 余额宝（普通周期）；假期周期从攒着（假期周转）取，不够的从余额宝补
    var step1 = plan.steps[0];
    if (plan.isHolidayCycle) {
      next.accounts.holiday = round2(nz(next.accounts.holiday, 0) - nz(step1.holidayFromFund, 0));
      if (nz(step1.holidayFromYuebao, 0) > 0) {
        next.accounts.yuebao = round2(nz(next.accounts.yuebao, 0) - nz(step1.holidayFromYuebao, 0));
      }
    } else {
      var topUp = plan.abcTopUp;
      if (plan.abcTopUpDirection === '余额宝 → 农行') next.accounts.yuebao = round2(nz(next.accounts.yuebao, 0) - topUp);
      else next.accounts.yuebao = round2(nz(next.accounts.yuebao, 0) + topUp);
    }

    // 工行转出
    var toBank = sum([plan.steps[1]], function (s) { return s.amount; });
    if (plan.isHolidayCycle) {
      // 假期周期：实发全部进农行，再加上从攒着（假期周转）/余额宝补进来的部分
      next.accounts.abc = round2(nz(plan.abcActual, nz(state.accounts.abc, 0)) + step1.amount + toBank);
    } else {
      next.accounts.abc = round2(bufferOf(next) + nz(plan.cmbDebt, 0) + toBank);
    }
    next.cycleAbcOpening = next.accounts.abc;
    next.accounts.icbc = round2(nz(next.accounts.icbc, 0) + nz(plan.salary, 0) - toBank
      - sum(plan.steps.slice(2), function (s) { return s.amount; }));

    // 应急金
    if (plan.steps[2].amount > 0) {
      next.emergency.balance = round2(nz(next.emergency.balance, 0) + plan.steps[2].amount);
    }

    // 大目标
    if (plan.steps[3].amount > 0 && plan.goal) {
      for (var g = 0; g < (next.goals || []).length; g++) {
        if (next.goals[g].id === plan.goal.id) {
          next.goals[g].saved = round2(nz(next.goals[g].saved, 0) + plan.steps[3].amount);
        }
      }
      next.accounts.goal = round2(nz(next.accounts.goal, 0) + plan.steps[3].amount);
    }

    // 假期周转金：工行 → 攒着（假期周转）
    if (plan.steps[4].amount > 0) {
      next.accounts.holiday = round2(nz(next.accounts.holiday, 0) + plan.steps[4].amount);
    }

    // 定期：勾掉就生成一张一年期存单
    if (plan.steps[5].amount > 0) {
      next.deposits = next.deposits || [];
      next.deposits.push(makeDeposit(next, plan.steps[5].amount, paydayDate));
      next.accounts.deposit = round2(nz(next.accounts.deposit, 0) + plan.steps[5].amount);
    }

    // 招行总欠款：对账时填的数，留作下期对账基数
    next.cmbDebt = round2(nz(input.cmbDebt, nz(state.cmbDebt, 0)));

    /* 第 12 节：对上（或补记完）后，农行和余额宝都以实际余额为准。
       先按转账清单算出结果，再用用户填的实际余额覆盖，保证下次对账基数正确。 */
    next.cycleCmbOpening = next.cmbDebt;
    next.paydayCarry = {
      emergency: nz(plan.steps[2].shortfall, 0),
      goal: nz(plan.steps[3].shortfall, 0),
      holiday: nz(plan.steps[4].shortfall, 0)
    };
    next.lastHolidayShortfall = plan.holidayFromYuebao > 0 ? {
      cycleKey: monthKey(paydayDate), amount: plan.holidayFromYuebao
    } : null;
    next.transfers = next.transfers || [];
    plan.steps.forEach(function (step) {
      if (step.id === 'holiday-abc') {
        [
          { suffix: 'fund', from: '攒着（假期周转）', amount: step.holidayFromFund },
          { suffix: 'yuebao', from: '余额宝', amount: step.holidayFromYuebao }
        ].forEach(function (part) {
          if (part.amount > 0) next.transfers.push({ id: 'tr-' + paydayDate + '-' + step.id + '-' + part.suffix,
            date: paydayDate, title: part.from + ' → 农行', from: part.from, to: '农行', amount: part.amount, detail: step.detail });
        });
      } else if (step.amount > 0) next.transfers.push({
        id: 'tr-' + paydayDate + '-' + step.id, date: paydayDate, title: step.title,
        from: step.from, to: step.to, amount: step.amount, detail: step.detail
      });
    });
    // 下一周期的余额宝期初，用来对账
    next.yuebaoOpening = round2(nz(next.accounts.yuebao, 0));

    // 记下本次发薪日期，开始新周期
    next.paydayRecords = (next.paydayRecords || []).concat([paydayDate]);
    next.paydayRecords.sort();

    // 复盘存档
    next.cycleHistory = next.cycleHistory || [];
    next.cycleHistory.push(buildReview(next, cycle.key));

    // 复盘存档后，未买且已过期的排定项顺延到新周期，继续在预测中预留。
    // 只调整付款周期；不生成支出/已买记录，不扣账户余额。
    var newCycleKey = monthKey(paydayDate);
    (next.planItems || []).forEach(function (it) {
      if (it.type === 'scheduled' && !it.removed && it.cycleKey && it.cycleKey < newCycleKey) {
        it.cycleKey = newCycleKey;
      }
    });
    next.lastPayday = paydayDate;
    // 记下「流程完成的时间点」：发薪日当天的支出以它为界分到上一/新周期（第 12 节）
    next.lastPaydayFlowAt = paydayDate + 'T' + (input.flowTime || nowHMOf(input)) + ':00';

    // 工资已在上面的工行余额计算中加过；这里只补一条收入流水，不再加余额。
    if (isNum(plan.salary) && plan.salary > 0) {
      next.entries = next.entries || [];
      next.entries.push({
        id: 'income-payday-' + paydayDate, date: paydayDate, time: nowHMOf(input),
        amount: -round2(plan.salary), catId: 'c-income-salary', catName: '工资', cat1: '收入',
        envelope: 'income', account: 'icbc', cycleKey: newCycleKey, reviewOnly: false,
        auto: true, autoPayday: true, note: ''
      });
    }

    return next;
  }

  /** 流程完成时刻：优先用调用方给的，否则取当前时间 */
  function nowHMOf(input) {
    if (input && input.flowTime) return input.flowTime;
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function bufferOf(state) {
    return nz(state.settings.plan.abcBuffer, 350);
  }

  /* ==================================================================
   * 14. 导出给随记（第 14 节）
   * ================================================================== */

  function exportPayload(state) {
    var cycle = deriveCycle(state);
    var plan = planView(state);
    return Object.assign({}, clone(state), {
      app: 'jizhang',
      version: 3,
      exportedAt: new Date().toISOString(),
      today: state.today,
      cycle: { key: cycle.key, label: cycle.label, start: cycle.start, bufferMode: cycle.bufferMode },
      accounts: state.accounts,
      settings: state.settings,
      categories: state.categories,
      entries: state.entries,
      planItems: state.planItems,
      calendar: state.calendar,
      trips: state.trips,
      events: state.events,
      goals: state.goals,
      deposits: state.deposits,
      emergency: state.emergency,
      paydayRecords: state.paydayRecords,
      cycleAbcOpening: state.cycleAbcOpening,
      yuebaoOpening: state.yuebaoOpening,
      lastPayday: state.lastPayday,
      lastPaydayFlowAt: state.lastPaydayFlowAt,
      boughtLog: state.boughtLog || [],
      cycleHistory: state.cycleHistory || [],
      carry: state.carry,
      plan: {
        freeBalance: plan.freeBalance,
        safeSpend: plan.safeSpend,
        minLow: plan.minLow,
        rows: plan.forecast.rows
      },
      alerts: alerts(state)
    });
  }

  /* ==================================================================
   * 15. 首页 / 日历用的组合数据
   * ================================================================== */

  function homeView(state) {
    var cycle = deriveCycle(state);
    var env = envelopeState(state, cycle);
    var meal = mealDaily(state, cycle, env);
    var plan = planView(state, { cycle: cycle, env: env });
    var tw = teachingWeek(state);
    var status = dayStatus(state, state.today);
    var statusText = { work: '班', rest: '休', night: '晚班', travel: '出行', unset: '未排' }[status] || '';
    var tw_status = state.today;
    var nextEvent = null;
    var evs = (state.events || []).slice().sort(function (a, b) {
      return (a.date + (a.time || '')) < (b.date + (b.time || '')) ? -1 : 1;
    });
    for (var i = 0; i < evs.length; i++) {
      if (evs[i].date + 'T' + (evs[i].time || '00:00') >= state.today + 'T00:00') { nextEvent = evs[i]; break; }
    }
    var goals = goalPlans(state);
    var activeGoal = null;
    for (var g = 0; g < goals.length; g++) if (!goals[g].done) { activeGoal = goals[g]; break; }

    return {
      cycle: cycle,
      env: env,
      meal: meal,
      plan: plan,
      alerts: alerts(state),
      teachingWeek: tw,
      dateText: mdLabel(state.today),
      weekdayText: weekdayCN(state.today),
      shiftText: status,        // 状态键（work/rest/night/travel/unset），界面自己映射成中文
      shiftTextCN: statusText,
      paydayPill: cycle.label + ' · ' + (cycle.bufferMode
        ? ('距最坏发薪 ' + cycle.daysToPayday + ' 天')
        : (cycle.daysToPayday + ' 天后发薪')),
      weekStatus: dayStatus,
      nextEvent: nextEvent,
      goal: activeGoal,
      emergency: emergencyPlan(state),
      bufferAdvice: bufferAdvice(state)
    };
  }

  function weekStrip(state, mondayStr) {
    var out = [];
    for (var i = 0; i < 7; i++) {
      var d = addDays(mondayStr, i);
      out.push({
        date: d,
        day: '一二三四五六日'.charAt(dowIndex(d)),
        label: (+d.slice(8, 10)),
        status: dayStatus(state, d),
        hasEvent: (state.events || []).some(function (e) { return e.date === d; }),
        isToday: d === state.today
      });
    }
    return out;
  }

  function monthGrid(state, year, month /* 1-12 */) {
    var first = year + '-' + pad2(month) + '-01';
    var lead = dowIndex(first);
    var total = daysInMonth(year, month);
    var cells = [];
    for (var i = 0; i < lead; i++) {
      cells.push({ date: '', status: 'none', out: true });
    }
    for (var d = 1; d <= total; d++) {
      var ds = year + '-' + pad2(month) + '-' + pad2(d);
      cells.push({
        date: ds,
        label: d,
        status: dayStatus(state, ds),
        hasEvent: (state.events || []).some(function (e) { return e.date === ds; }),
        isToday: ds === state.today
      });
    }
    while (cells.length % 7 !== 0) cells.push({ date: '', status: 'none', out: true });
    return cells;
  }

  function tripsCovering(state, dateStr) {
    var out = [];
    var trips = state.trips || [];
    for (var i = 0; i < trips.length; i++) {
      if (dateStr >= trips[i].start && dateStr <= trips[i].end) out.push(trips[i]);
    }
    return out;
  }

  /** 下一个事项（含出行） */
  function nextAgenda(state) {
    var list = (state.events || []).slice();
    var trips = (state.trips || []).slice();
    var all = list.map(function (e) {
      return { kind: 'event', date: e.date, time: e.time || '', title: e.title, remind: e.remind || [], id: e.id };
    }).concat(trips.map(function (t) {
      return { kind: 'trip', date: t.start, time: '', title: t.title, remind: [], id: t.id, end: t.end };
    }));
    all.sort(function (a, b) {
      return (a.date + (a.time || '00:00')) < (b.date + (b.time || '00:00')) ? -1 : 1;
    });
    for (var i = 0; i < all.length; i++) {
      if (all[i].date >= state.today) return all[i];
    }
    return all.length ? all[all.length - 1] : null;
  }

  /* ==================================================================
   * 16. 导出接口
   * ================================================================== */

  return {
    /* 工具 */
    pad2: pad2, round2: round2, num: num, money: money, int: int, nz: nz, clone: clone, sum: sum,
    /* 日期 */
    parseYmd: parseYmd, ymd: ymd, addDays: addDays, addYears: addYears, diffDays: diffDays,
    dowIndex: dowIndex, weekMonday: weekMonday, monthKey: monthKey, cycleLabel: cycleLabel,
    monthLabel: monthLabel, addMonthsKey: addMonthsKey, nextCycleKeys: nextCycleKeys,
    dayOfMonth: dayOfMonth, daysInMonth: daysInMonth, eachDate: eachDate, eachWeek: eachWeek,
    weekdayCN: weekdayCN, mdLabel: mdLabel, nextDateWithDayAfter: nextDateWithDayAfter,
    dayInMonthOfMonth: dayInMonthOfMonth, nextWorstPayday: nextWorstPayday,
    /* 周期 */
    autoLearnPayday: autoLearnPayday, deriveCycle: deriveCycle, cycleKeyForDate: cycleKeyForDate,
    teachingWeek: teachingWeek,
    /* 日历 */
    dayStatus: dayStatus, isTravelDay: isTravelDay, countNightShifts: countNightShifts,
    nextDayStatus: nextDayStatus, setDayStatus: setDayStatus, DAY_CYCLE: DAY_CYCLE,
    monthsBetweenKeys: monthsBetweenKeys, forecastCycleKeys: forecastCycleKeys,
    taxiQuota: taxiQuota, weekStrip: weekStrip, monthGrid: monthGrid, tripsCovering: tripsCovering,
    nextAgenda: nextAgenda,
    /* 信封 */
    envelopeState: envelopeState, mealDaily: mealDaily, isFromAbc: isFromAbc,
    entriesOfCycle: entriesOfCycle, occurrenceIndex: occurrenceIndex, findCategory: findCategory,
    countEntries: countEntries, hasCalendarEntry: hasCalendarEntry,
    categoryIdsByName: categoryIdsByName, categoryCounter: categoryCounter,
    defaultEnvelope: defaultEnvelope,
    /* 预测与排表 */
    forecast: forecast, allocateConditionals: allocateConditionals, planView: planView,
    sortConditional: sortConditional, affordableCycleOf: affordableCycleOf,
    forecastStartBalance: forecastStartBalance,
    threeEnvelopeLeft: threeEnvelopeLeft, sweepAtPayday: sweepAtPayday,
    /* 排表匹配检查 / 发薪日归属 */
    planMatchCheck: planMatchCheck, paydayAttribution: paydayAttribution,
    /* 匹配检查内部判定（测试用） */
    cnOnly: cnOnly, tokenize: tokenize, sameThingName: sameThingName, isGenericWord: isGenericWord,
    /* 买不买 */
    buyVerdict: buyVerdict,
    /* 预警 */
    alerts: alerts, bufferAdvice: bufferAdvice,
    /* 记一笔 */
    withEntry: withEntry, applyEntryToAccounts: applyEntryToAccounts, impactOfEntry: impactOfEntry,
    /* 目标 / 应急金 / 定期 */
    goalPlan: goalPlan, goalPlans: goalPlans, allocateBonus: allocateBonus,
    emergencyPlan: emergencyPlan, depositPlans: depositPlans, makeDeposit: makeDeposit,
    cycleDistance: cycleDistance,
    /* 发薪日 */
    expectedAbcBalance: expectedAbcBalance, paydayPlan: paydayPlan, applyPayday: applyPayday,
    expectedCangzheBalance: expectedCangzheBalance, reconcileTotal: reconcileTotal,
    cycleOfKey: cycleOfKey, roundDayHalfUp: roundDayHalfUp,
    buildReview: buildReview,
    /* 第五轮：账户 / 假期周期 / 订阅自动入账 */
    ACCOUNT_NAMES: ACCOUNT_NAMES, accountName: accountName, entryAccount: entryAccount,
    incomeCategories: incomeCategories, incomeCategory: incomeCategory, entryTotals: entryTotals,
    envelopeTotal: envelopeTotal, isHolidayCycle: isHolidayCycle, nextHolidayKey: nextHolidayKey,
    holidayGap: holidayGap, dueSubscriptions: dueSubscriptions,
    expectedYuebaoBalance: expectedYuebaoBalance,
    /* 导出 */
    exportPayload: exportPayload,
    /* 首页 */
    homeView: homeView
  };
})();

/* Node 下也能直接 require，方便跑无头验证（浏览器里这段会被跳过） */
if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
