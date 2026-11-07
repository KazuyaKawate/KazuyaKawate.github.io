(function (global) {
  'use strict';

  /* ============================================================
     Core: 日時・繰り返しの純粋ロジック（テスト可能に分離）
     reminder = {
       id, title, date: 'YYYY-MM-DD' (初回日), time: 'HH:MM',
       repeat: 'none' | 'daily' | 'weekly', weekdays: [0..6] (weekly用)
     }
     completions = { [reminderId]: { 'YYYY-MM-DD': true } }
     ============================================================ */
  function pad(n) { return String(n).padStart(2, '0'); }

  function toDateStr(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseDateStr(s) {
    var p = s.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function occurrenceDateTime(dateStr, time) {
    var d = parseDateStr(dateStr);
    var t = (time || '09:00').split(':');
    d.setHours(Number(t[0]), Number(t[1]), 0, 0);
    return d;
  }

  function occursOn(r, dateStr) {
    if (dateStr < r.date) return false;
    if (r.repeat === 'none') return dateStr === r.date;
    if (r.repeat === 'daily') return true;
    if (r.repeat === 'weekly') {
      var dow = parseDateStr(dateStr).getDay();
      return Array.isArray(r.weekdays) && r.weekdays.indexOf(dow) !== -1;
    }
    return false;
  }

  // fromStr 以降で未完了の直近の発生日を返す（最大370日先まで探索、なければ null）
  function nextPendingDate(r, completions, fromStr) {
    var done = (completions && completions[r.id]) || {};
    var d = parseDateStr(fromStr);
    for (var i = 0; i < 370; i++) {
      var s = toDateStr(d);
      if (occursOn(r, s) && !done[s]) return s;
      d.setDate(d.getDate() + 1);
    }
    return null;
  }

  // 今日リスト: 今日の発生分 + 過ぎても未完了の「くりかえさない」分（持ち越し）
  // 戻り値: [{reminder, dateStr(発生日), overdue, carried}]
  function buildTodayList(reminders, completions, now) {
    now = now || new Date();
    var tStr = toDateStr(now);
    var items = [];
    reminders.forEach(function (r) {
      var done = (completions && completions[r.id]) || {};
      if (r.repeat === 'none') {
        if (r.date <= tStr && !done[r.date]) {
          items.push(makeItem(r, r.date, now, tStr));
        }
      } else {
        if (occursOn(r, tStr) && !done[tStr]) {
          items.push(makeItem(r, tStr, now, tStr));
        }
      }
    });
    items.sort(function (a, b) {
      var ka = a.dateStr + ' ' + a.reminder.time;
      var kb = b.dateStr + ' ' + b.reminder.time;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return items;
  }

  function makeItem(r, dateStr, now, tStr) {
    return {
      reminder: r,
      dateStr: dateStr,
      overdue: occurrenceDateTime(dateStr, r.time) <= now,
      carried: dateStr < tStr
    };
  }

  // 朝のまとめ: 件数と「次に来る予定」
  function morningSummary(reminders, completions, now) {
    now = now || new Date();
    var items = buildTodayList(reminders, completions, now);
    var next = null;
    for (var i = 0; i < items.length; i++) {
      if (occurrenceDateTime(items[i].dateStr, items[i].reminder.time) > now) {
        next = items[i];
        break;
      }
    }
    if (!next && items.length > 0) next = items[0]; // 全部過ぎていたら先頭を「まずこれ」
    return { count: items.length, next: next, items: items };
  }

  var Core = {
    pad: pad,
    toDateStr: toDateStr,
    parseDateStr: parseDateStr,
    occurrenceDateTime: occurrenceDateTime,
    occursOn: occursOn,
    nextPendingDate: nextPendingDate,
    buildTodayList: buildTodayList,
    morningSummary: morningSummary
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Core;
  }
  global.ReminderCore = Core;

  /* ============================================================
     UI（ブラウザ環境でのみ動作）
     ============================================================ */
  if (typeof document === 'undefined') return;

  var STORAGE_KEY = 'mieruka-reminder-v1';
  var INTRO_KEY = 'mieruka-reminder-intro-seen';

  var PRAISE = [
    'やったね！ えらい！',
    'ひとつ片づいた。すごい！',
    'その調子！ よくできました',
    'できた！ 自分をほめてあげて',
    'ナイス！ ひとつ前進'
  ];

  var TEMPLATE_TIME = {
    '薬': '08:00',
    'お迎え': '17:00',
    'ゴミ出し': '07:30',
    '提出物': '09:00',
    '買い物': '10:00'
  };

  var state = load();
  var editingId = null;

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.reminders)) {
          return { reminders: parsed.reminders, completions: parsed.completions || {} };
        }
      }
    } catch (e) { /* 壊れていたら初期化 */ }
    return { reminders: [], completions: {} };
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- 画面切り替え ---------- */
  var tabs = document.querySelectorAll('.tab');
  function showView(name) {
    tabs.forEach(function (t) {
      t.classList.toggle('is-active', t.getAttribute('data-view') === name);
    });
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('is-active', v.id === 'view-' + name);
    });
    if (name === 'today') renderToday();
    if (name === 'list') renderList();
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { showView(t.getAttribute('data-view')); });
  });

  /* ---------- 今日画面 ---------- */
  var summaryEl = document.getElementById('morning-summary');
  var todayListEl = document.getElementById('today-list');
  var todayEmptyEl = document.getElementById('today-empty');
  var praiseEl = document.getElementById('praise');
  var praiseTimer = null;

  function showPraise() {
    praiseEl.textContent = PRAISE[Math.floor(Math.random() * PRAISE.length)];
    praiseEl.hidden = false;
    if (praiseTimer) clearTimeout(praiseTimer);
    praiseTimer = setTimeout(function () { praiseEl.hidden = true; }, 4000);
  }

  function repeatLabel(r) {
    if (r.repeat === 'daily') return '毎日';
    if (r.repeat === 'weekly') {
      var names = ['日', '月', '火', '水', '木', '金', '土'];
      return '毎週 ' + (r.weekdays || []).map(function (d) { return names[d]; }).join('・');
    }
    return '';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderToday() {
    var now = new Date();
    var summary = Core.morningSummary(state.reminders, state.completions, now);

    summaryEl.textContent = '';
    var dateLine = el('p', 'summary-date',
      (now.getMonth() + 1) + '月' + now.getDate() + '日（' + '日月火水木金土'[now.getDay()] + '）の朝のまとめ');
    summaryEl.appendChild(dateLine);
    if (summary.count === 0) {
      summaryEl.appendChild(el('p', 'summary-count', '今日の予定は 0件'));
      summaryEl.appendChild(el('p', 'summary-first', 'あとは ゆっくりどうぞ。'));
    } else {
      summaryEl.appendChild(el('p', 'summary-count', '今日の予定は ' + summary.count + '件'));
      var first = el('p', 'summary-first');
      first.appendChild(document.createTextNode(
        summary.next.overdue ? 'まず ' : '最初の予定は '));
      var strong = el('strong', null,
        summary.next.reminder.title + '（' + summary.next.reminder.time + '）');
      first.appendChild(strong);
      first.appendChild(document.createTextNode('です'));
      summaryEl.appendChild(first);
    }

    todayListEl.textContent = '';
    summary.items.forEach(function (item) {
      todayListEl.appendChild(buildTaskCard(item));
    });
    todayEmptyEl.hidden = summary.items.length !== 0;
  }

  function buildTaskCard(item) {
    var r = item.reminder;
    var li = el('li', 'task' + (item.overdue ? ' is-overdue' : ''));
    if (item.overdue) {
      li.appendChild(el('span', 'overdue-badge',
        item.carried ? '日にちが過ぎています' : '時間を過ぎています'));
    }
    var main = el('div', 'task-main');
    main.appendChild(el('span', 'task-time', r.time));
    main.appendChild(el('span', 'task-title', r.title));
    li.appendChild(main);

    var metaText = repeatLabel(r);
    if (item.carried) {
      var d = Core.parseDateStr(item.dateStr);
      metaText = (d.getMonth() + 1) + '月' + d.getDate() + '日の分' +
        (metaText ? ' / ' + metaText : '');
    }
    if (metaText) li.appendChild(el('div', 'task-meta', metaText));

    var actions = el('div', 'task-actions');
    var doneBtn = el('button', 'btn btn-done', 'やった！');
    doneBtn.type = 'button';
    doneBtn.addEventListener('click', function () {
      completeReminder(r.id, item.dateStr);
    });
    actions.appendChild(doneBtn);
    li.appendChild(actions);
    return li;
  }

  function completeReminder(id, dateStr) {
    if (!state.completions[id]) state.completions[id] = {};
    state.completions[id][dateStr] = true;
    save();
    renderToday();
    showPraise();
  }

  /* ---------- 使い方（初回） ---------- */
  var introEl = document.getElementById('intro');
  if (!localStorage.getItem(INTRO_KEY)) introEl.hidden = false;
  document.getElementById('intro-close').addEventListener('click', function () {
    introEl.hidden = true;
    localStorage.setItem(INTRO_KEY, '1');
  });

  /* ---------- フォーム ---------- */
  var form = document.getElementById('reminder-form');
  var fTitle = document.getElementById('f-title');
  var fDate = document.getElementById('f-date');
  var fTime = document.getElementById('f-time');
  var fRepeat = document.getElementById('f-repeat');
  var weekdayBox = document.getElementById('weekday-box');
  var formTitle = document.getElementById('form-title');
  var formSubmit = document.getElementById('form-submit');
  var formCancel = document.getElementById('form-cancel');

  function resetForm() {
    editingId = null;
    form.reset();
    fDate.value = Core.toDateStr(new Date());
    fTime.value = '09:00';
    weekdayBox.hidden = true;
    formTitle.textContent = 'リマインダーを置く';
    formSubmit.textContent = 'ここに置く';
    formCancel.hidden = true;
  }

  fRepeat.addEventListener('change', function () {
    weekdayBox.hidden = fRepeat.value !== 'weekly';
    if (fRepeat.value === 'weekly') syncWeekdayDefault();
  });

  function syncWeekdayDefault() {
    var boxes = weekdayBox.querySelectorAll('input[type="checkbox"]');
    var anyChecked = Array.prototype.some.call(boxes, function (b) { return b.checked; });
    if (!anyChecked && fDate.value) {
      var dow = Core.parseDateStr(fDate.value).getDay();
      boxes.forEach(function (b) { b.checked = Number(b.value) === dow; });
    }
  }
  fDate.addEventListener('change', function () {
    if (fRepeat.value === 'weekly') {
      var boxes = weekdayBox.querySelectorAll('input[type="checkbox"]');
      boxes.forEach(function (b) { b.checked = false; });
      syncWeekdayDefault();
    }
  });

  document.querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var name = chip.getAttribute('data-template');
      if (!editingId) resetForm();
      fTitle.value = name === '薬' ? '薬を飲む' : name;
      if (TEMPLATE_TIME[name]) fTime.value = TEMPLATE_TIME[name];
      if (name === '薬') { fRepeat.value = 'daily'; weekdayBox.hidden = true; }
      fTitle.focus();
    });
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var title = fTitle.value.trim();
    if (!title) { fTitle.focus(); return; }
    var weekdays = [];
    weekdayBox.querySelectorAll('input[type="checkbox"]').forEach(function (b) {
      if (b.checked) weekdays.push(Number(b.value));
    });
    if (fRepeat.value === 'weekly' && weekdays.length === 0) {
      syncWeekdayDefault();
      weekdayBox.querySelectorAll('input[type="checkbox"]').forEach(function (b) {
        if (b.checked) weekdays.push(Number(b.value));
      });
    }
    var data = {
      title: title,
      date: fDate.value,
      time: fTime.value || '09:00',
      repeat: fRepeat.value,
      weekdays: weekdays.sort()
    };
    if (editingId) {
      state.reminders = state.reminders.map(function (r) {
        return r.id === editingId ? Object.assign({}, r, data) : r;
      });
    } else {
      data.id = uid();
      state.reminders.push(data);
    }
    save();
    resetForm();
    showView('today');
  });

  formCancel.addEventListener('click', function () {
    resetForm();
    showView('list');
  });

  function startEdit(id) {
    var r = state.reminders.find(function (x) { return x.id === id; });
    if (!r) return;
    editingId = id;
    fTitle.value = r.title;
    fDate.value = r.date;
    fTime.value = r.time;
    fRepeat.value = r.repeat;
    weekdayBox.hidden = r.repeat !== 'weekly';
    weekdayBox.querySelectorAll('input[type="checkbox"]').forEach(function (b) {
      b.checked = (r.weekdays || []).indexOf(Number(b.value)) !== -1;
    });
    formTitle.textContent = 'リマインダーを直す';
    formSubmit.textContent = '直して置く';
    formCancel.hidden = false;
    showView('add');
  }

  /* ---------- 一覧画面 ---------- */
  var allListEl = document.getElementById('all-list');
  var allEmptyEl = document.getElementById('all-empty');

  function renderList() {
    var now = new Date();
    var tStr = Core.toDateStr(now);
    allListEl.textContent = '';
    var sorted = state.reminders.slice().sort(function (a, b) {
      return (a.date + a.time) < (b.date + b.time) ? -1 : 1;
    });
    sorted.forEach(function (r) {
      var li = el('li', 'task');
      var main = el('div', 'task-main');
      main.appendChild(el('span', 'task-time', r.time));
      main.appendChild(el('span', 'task-title', r.title));
      li.appendChild(main);

      var next = Core.nextPendingDate(r, state.completions, tStr);
      var meta = '';
      if (r.repeat === 'none') {
        var done = state.completions[r.id] && state.completions[r.id][r.date];
        meta = r.date.replace(/-/g, '/') + (done ? '（済み）' : '');
      } else {
        meta = repeatLabel(r) + (next ? ' / 次は ' + next.replace(/-/g, '/') : ' / 次の予定なし');
      }
      li.appendChild(el('div', 'task-meta', meta));

      var actions = el('div', 'task-actions');
      var editBtn = el('button', 'btn btn-edit', '編集');
      editBtn.type = 'button';
      editBtn.addEventListener('click', function () { startEdit(r.id); });
      var delBtn = el('button', 'btn btn-delete', '削除');
      delBtn.type = 'button';
      delBtn.addEventListener('click', function () {
        if (confirm('「' + r.title + '」を削除しますか？')) {
          state.reminders = state.reminders.filter(function (x) { return x.id !== r.id; });
          delete state.completions[r.id];
          save();
          renderList();
        }
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      li.appendChild(actions);
      allListEl.appendChild(li);
    });
    allEmptyEl.hidden = sorted.length !== 0;
  }

  /* ---------- 初期化 ---------- */
  resetForm();
  renderToday();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 未対応環境では無視 */ });
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
