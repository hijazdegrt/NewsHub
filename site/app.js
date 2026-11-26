/* Market hub front end. Reads data/news.json (written by fetcher/fetch.py) and renders the feed. */
(function () {
  'use strict';

  var DATA_URL = 'data/news.json';
  var PAGE = 60;
  var POLL_MS = 5 * 60 * 1000;

  var CATS = [
    { id: 'all', label: 'All' },
    { id: 'filings', label: 'Filings' },
    { id: 'regulators', label: 'RBI / SEBI' },
    { id: 'markets', label: 'Markets' },
    { id: 'global', label: 'Global' },
    { id: 'community', label: 'Reddit' },
    { id: 'video', label: 'Video' }
  ];
  var VIEWS = [
    { id: 'all', label: 'Everything' },
    { id: 'important', label: 'Important' },
    { id: 'watchlist', label: 'Watchlist' },
    { id: 'saved', label: 'Saved' }
  ];

  // ---------- small storage wrapper (private mode can throw)
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('mh.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('mh.' + k, JSON.stringify(v)); } catch (e) {} }
  };

  var state = {
    data: null,
    view: 'all',
    cat: 'all',
    q: '',
    routine: store.get('routine', false),
    shown: PAGE,
    saved: store.get('saved', {}),           // id -> item copy, so saved stories outlive the 7-day window
    read: new Set(store.get('read', [])),
    prevVisit: store.get('lastVisit', null), // ISO time of the previous visit
    focus: -1,
    list: []
  };

  var $ = function (s) { return document.querySelector(s); };
  var feedEl = $('#feed');

  // ---------- helpers
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : '#'; }

  var istTime = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  var istDay = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
  var istKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });

  function ago(iso) {
    if (!iso) return '';
    var d = new Date(iso), s = (Date.now() - d) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 6 * 3600) return Math.floor(s / 3600) + 'h';
    var today = istKey.format(new Date()), day = istKey.format(d);
    if (day === today) return istTime.format(d);
    var y = new Date(Date.now() - 864e5);
    if (day === istKey.format(y)) return 'Yesterday ' + istTime.format(d);
    return istDay.format(d) + ', ' + istTime.format(d);
  }
  function fmtNum(n) {
    if (n == null) return '–';
    return n >= 1000 ? n.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  // ---------- filtering
  function matches(it, q) {
    if (!q) return true;
    var hay = (it.title + ' ' + (it.summary || '') + ' ' + it.source + ' ' + (it.tags || []).join(' ') + ' ' + (it.stocks || []).join(' ')).toLowerCase();
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }

  function baseList() {
    if (state.view === 'saved') {
      return Object.keys(state.saved).map(function (k) { return state.saved[k]; })
        .sort(function (a, b) { return a.time < b.time ? 1 : -1; });
    }
    return state.data ? state.data.items : [];
  }

  function viewFilter(it) {
    if (state.view === 'important') return it.priority >= 1;
    if (state.view === 'watchlist') return it.stocks && it.stocks.length > 0;
    return true;
  }

  function compute() {
    var q = state.q.trim().toLowerCase();
    var showRoutine = state.routine || state.view === 'saved';
    state.list = baseList().filter(function (it) {
      return (showRoutine || !it.routine) && viewFilter(it) &&
        (state.cat === 'all' || it.category === state.cat) && matches(it, q);
    });
  }

  function counts() {
    var c = {}, src = baseList(), showRoutine = state.routine || state.view === 'saved';
    src.forEach(function (it) {
      if ((!showRoutine && it.routine) || !viewFilter(it)) return;
      c[it.category] = (c[it.category] || 0) + 1;
      c.all = (c.all || 0) + 1;
    });
    return c;
  }

  // ---------- rendering
  function itemHtml(it, i) {
    var saved = !!state.saved[it.id];
    var tags = (it.stocks || []).map(function (s) { return '<span class="tag watch">' + esc(s) + '</span>'; })
      .concat((it.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }));
    if (it.routine) tags.push('<span class="tag">Routine</span>');
    if (it.also && it.also.length) tags.push('<button type="button" class="tag also" data-also="' + i + '">+' + it.also.length + ' more source' + (it.also.length > 1 ? 's' : '') + '</button>');
    return '<article class="item' + (state.read.has(it.id) ? ' read' : '') + '" data-p="' + (it.priority || 0) + '" data-i="' + i + '" tabindex="-1">' +
      '<div class="meta"><span class="src">' + esc(it.source) + '</span><span aria-hidden="true">·</span>' +
      '<time datetime="' + esc(it.time) + '" title="' + esc(it.time ? new Date(it.time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : '') + '">' + esc(ago(it.time)) + '</time></div>' +
      '<a class="title" href="' + esc(safeUrl(it.link)) + '" target="_blank" rel="noopener noreferrer" data-open="' + i + '">' + esc(it.title) + '</a>' +
      (it.summary ? '<p class="sum">' + esc(it.summary) + '</p>' : '') +
      '<div class="tags">' + tags.join('') + '</div>' +
      '<button type="button" class="icon-btn save" data-save="' + i + '" aria-pressed="' + saved + '" aria-label="' + (saved ? 'Remove from saved' : 'Save story') + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg></button>' +
      '</article>';
  }

  function emptyHtml() {
    if (!state.data) return '<div class="empty"><strong>No news yet</strong>The first update hasn\'t run. Check back in a few minutes.</div>';
    if (state.view === 'saved') return '<div class="empty"><strong>Save stories to read later</strong>Tap the bookmark on any story and it stays here, even after it leaves the feed.</div>';
    if (state.view === 'watchlist' && !(state.data.watchlist || []).length) return '<div class="empty"><strong>Add your stocks</strong>Edit config/watchlist.yaml in the repository to list the companies you follow.</div>';
    if (state.q) return '<div class="empty"><strong>Nothing matches "' + esc(state.q) + '"</strong>Try fewer words, or switch to All.</div>';
    return '<div class="empty"><strong>Nothing here right now</strong>Try another category or turn on routine filings.</div>';
  }

  function renderFeed() {
    compute();
    var list = state.list, n = Math.min(state.shown, list.length), out = [], dividerDone = false;
    var markDivider = state.prevVisit && state.view !== 'saved' && !state.q;
    for (var i = 0; i < n; i++) {
      var it = list[i];
      if (markDivider && !dividerDone && i > 0 && (it.first_seen || it.time) <= state.prevVisit) {
        out.push('<div class="divider">Seen before this</div>');
        dividerDone = true;
      }
      if (markDivider && i === 0 && (it.first_seen || it.time) <= state.prevVisit) dividerDone = true;
      out.push(itemHtml(it, i));
    }
    feedEl.innerHTML = n ? out.join('') : emptyHtml();
    $('#more').hidden = list.length <= n;
    $('#more').textContent = 'Show more (' + (list.length - n) + ' left)';
    state.focus = -1;
  }

  function renderNav() {
    var c = counts();
    $('#views').innerHTML = VIEWS.map(function (v) {
      var n = v.id === 'saved' ? Object.keys(state.saved).length : '';
      return '<li><a href="#" data-view="' + v.id + '"' + (state.view === v.id ? ' aria-current="page"' : '') + '>' + esc(v.label) + '<span class="count">' + n + '</span></a></li>';
    }).join('');
    $('#cats').innerHTML = CATS.map(function (k) {
      return '<li><a href="#" data-cat="' + k.id + '"' + (state.cat === k.id ? ' aria-current="page"' : '') + '>' + esc(k.label) + '<span class="count">' + (c[k.id] || 0) + '</span></a></li>';
    }).join('');
    $('#chips').innerHTML = CATS.map(function (k) {
      return '<button type="button" class="chip" role="tab" data-cat="' + k.id + '" aria-selected="' + (state.cat === k.id) + '">' + esc(k.label) + (c[k.id] ? ' ' + c[k.id] : '') + '</button>';
    }).join('');
    document.querySelectorAll('.bottomnav [data-view]').forEach(function (b) {
      if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  function renderSide() {
    var d = state.data;
    if (!d) return;
    var snap = d.snapshot || [];
    function chg(s) { return s.change_pct == null ? '' : '<span class="' + (s.change_pct >= 0 ? 'up' : 'down') + '">' + (s.change_pct >= 0 ? '+' : '') + s.change_pct.toFixed(2) + '%</span>'; }
    $('#snapshot').innerHTML = snap.map(function (s) { return '<span>' + esc(s.label) + ' <b>' + fmtNum(s.price) + '</b> ' + chg(s) + '</span>'; }).join('');
    $('#snapshot-rail').innerHTML = snap.map(function (s) {
      return '<div class="snap-row"><span class="lbl">' + esc(s.label) + '</span><span>' + fmtNum(s.price) + ' ' + chg(s) + '</span></div>';
    }).join('') || '<p class="muted tiny">Not available right now.</p>';
    var links = (d.links || []).map(function (l) { return '<a href="' + esc(safeUrl(l.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(l.label) + '</a>'; }).join('');
    document.querySelectorAll('[data-links]').forEach(function (el) { el.innerHTML = links; });
    updatedLabel();
  }

  function updatedLabel() {
    if (!state.data) return;
    var t = state.data.generated_at, mins = (Date.now() - new Date(t)) / 60000;
    var el = $('#updated');
    el.textContent = 'Updated ' + (mins < 1 ? 'just now' : ago(t) + (mins < 360 ? ' ago' : ''));
    el.title = new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
  }

  function renderSources() {
    var d = state.data;
    if (!d) return;
    $('#sources-when').textContent = 'Checked ' + ago(d.generated_at) + '. Sources marked "may fail" often block automated readers.';
    $('#sources-body').innerHTML = (d.sources || []).map(function (s) {
      var status = s.ok ? '<span class="badge" data-variant="success">OK</span>' :
        (s.optional ? '<span class="badge outline">May fail: ' + esc(s.error || '') + '</span>' : '<span class="badge" data-variant="danger">' + esc(s.error || 'Failed') + '</span>');
      return '<tr><td>' + esc(s.name) + '</td><td>' + (s.count || 0) + '</td><td>' + status + '</td></tr>';
    }).join('');
  }

  function render() { renderNav(); renderFeed(); }

  // ---------- data
  var loading = false;
  function load(userAsked) {
    if (loading) return;
    loading = true;
    $('#refresh').classList.add('spin');
    var prevGen = state.data && state.data.generated_at;
    var prevIds = state.data ? new Set(state.data.items.map(function (i) { return i.id; })) : null;
    fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        state.data = d;
        renderSide();
        renderSources();
        if (prevIds && d.generated_at !== prevGen) {
          var fresh = d.items.filter(function (i) { return !prevIds.has(i.id) && !i.routine; }).length;
          if (fresh && window.ot) ot.toast(fresh + ' new ' + (fresh === 1 ? 'story' : 'stories') + ' added to the top.', 'Feed updated', { placement: 'bottom-center' });
          else if (userAsked && window.ot) ot.toast('No new stories since the last update.', '', { placement: 'bottom-center' });
        } else if (userAsked && window.ot) {
          ot.toast('Already up to date. The hub refreshes every 15 min in market hours.', '', { placement: 'bottom-center' });
        }
        render();
      })
      .catch(function () {
        if (!state.data) feedEl.innerHTML = '<div class="empty"><strong>Couldn\'t load the news</strong>You might be offline. Pull down or press refresh to try again.</div>';
        else if (window.ot) ot.toast('Couldn\'t reach the server. Showing the last loaded news.', '', { variant: 'warning', placement: 'bottom-center' });
      })
      .then(function () { loading = false; $('#refresh').classList.remove('spin'); });
  }

  // ---------- actions
  function setView(v) { state.view = v; state.cat = 'all'; state.shown = PAGE; render(); scrollTop(); closeSidebar(); }
  function setCat(c) { state.cat = c; state.shown = PAGE; render(); scrollTop(); closeSidebar(); }
  function scrollTop() { var m = document.querySelector('main'); if (m) m.scrollTop = 0; }
  function closeSidebar() { document.body.removeAttribute('data-sidebar-open'); }

  function toggleSave(i) {
    var it = state.list[i];
    if (!it) return;
    if (state.saved[it.id]) delete state.saved[it.id];
    else state.saved[it.id] = it;
    store.set('saved', state.saved);
    if (state.view === 'saved') render();
    else {
      var btn = feedEl.querySelector('[data-save="' + i + '"]');
      var on = !!state.saved[it.id];
      btn.setAttribute('aria-pressed', on);
      btn.setAttribute('aria-label', on ? 'Remove from saved' : 'Save story');
      renderNav();
    }
  }

  function markRead(i) {
    var it = state.list[i];
    if (!it) return;
    state.read.add(it.id);
    var arr = Array.from(state.read);
    store.set('read', arr.slice(-3000));
    var el = feedEl.querySelector('[data-i="' + i + '"]');
    if (el) el.classList.add('read');
  }

  function showAlso(i, btn) {
    var it = state.list[i];
    if (!it || !it.also) return;
    var box = document.createElement('div');
    box.className = 'also-list';
    box.innerHTML = it.also.map(function (a) { return '<a href="' + esc(safeUrl(a.link)) + '" target="_blank" rel="noopener noreferrer">' + esc(a.source) + '</a>'; }).join('');
    btn.closest('.item').appendChild(box);
    btn.remove();
  }

  function moveFocus(d) {
    var items = feedEl.querySelectorAll('.item');
    if (!items.length) return;
    var cur = feedEl.querySelector('.item.focus');
    var idx = cur ? Array.prototype.indexOf.call(items, cur) : -1;
    idx = Math.max(0, Math.min(items.length - 1, idx + d));
    if (cur) cur.classList.remove('focus');
    items[idx].classList.add('focus');
    items[idx].scrollIntoView({ block: 'nearest' });
    state.focus = +items[idx].dataset.i;
  }

  // ---------- events
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-view],[data-cat],[data-save],[data-open],[data-also]');
    if (!t) return;
    if (t.dataset.view) { e.preventDefault(); setView(t.dataset.view); }
    else if (t.dataset.cat) { e.preventDefault(); setCat(t.dataset.cat); }
    else if (t.dataset.save) toggleSave(+t.dataset.save);
    else if (t.dataset.also) showAlso(+t.dataset.also, t);
    else if (t.dataset.open) markRead(+t.dataset.open);
  });

  $('#more').addEventListener('click', function () { state.shown += PAGE; renderFeed(); });

  var qTimer;
  $('#q').addEventListener('input', function (e) {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { state.q = e.target.value; state.shown = PAGE; render(); }, 150);
  });
  $('#q').addEventListener('focus', function () { document.body.classList.add('search-open'); });
  $('#q').addEventListener('blur', function () { document.body.classList.remove('search-open'); });

  var routineEl = $('#routine');
  routineEl.checked = state.routine;
  routineEl.addEventListener('change', function () { state.routine = routineEl.checked; store.set('routine', state.routine); state.shown = PAGE; render(); });

  $('#refresh').addEventListener('click', function () { load(true); });

  $('#theme').addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.style.colorScheme = next;
    try { localStorage.setItem('mh.theme', next); } catch (e) {}
  });

  $('#sources-open').addEventListener('click', function (e) { e.preventDefault(); renderSources(); $('#sources-dlg').showModal(); });

  document.addEventListener('keydown', function (e) {
    if (e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === 'Escape' && e.target.id === 'q') { e.target.value = ''; state.q = ''; e.target.blur(); render(); }
      return;
    }
    if (e.key === 'j') moveFocus(1);
    else if (e.key === 'k') moveFocus(-1);
    else if ((e.key === 'o' || e.key === 'Enter') && state.focus >= 0) {
      var a = feedEl.querySelector('[data-open="' + state.focus + '"]');
      if (a) { markRead(state.focus); window.open(a.href, '_blank', 'noopener'); }
    } else if (e.key === 's' && state.focus >= 0) toggleSave(state.focus);
    else if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
    else return;
  });

  // Remember this visit for the "Seen before this" divider (saved when leaving the page).
  function saveVisit() { if (state.data) store.set('lastVisit', state.data.generated_at); }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveVisit();
    else { state.prevVisit = store.get('lastVisit', state.prevVisit); load(false); }
  });
  window.addEventListener('pagehide', saveVisit);

  setInterval(function () { if (document.visibilityState === 'visible') load(false); }, POLL_MS);
  setInterval(function () { updatedLabel(); }, 60000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  renderNav();
  load(false);
})();
