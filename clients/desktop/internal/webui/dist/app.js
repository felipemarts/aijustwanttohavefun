'use strict';
// The launch token arrives in the URL fragment (never sent in a URL to a server). The page trades it for an
// HttpOnly session cookie with POST /core/session and drops it from the address bar; a reload keeps the cookie.
const $ = (id) => document.getElementById(id);
const launch = new URLSearchParams(location.hash.slice(1)).get('token');
const ready = (launch
  ? fetch('/core/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: launch }) })
  : Promise.resolve()
).finally(() => history.replaceState(null, '', location.pathname));

async function call(method, path, body) {
  await ready;
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || res.statusText);
  return data;
}

function text(el, s) { el.textContent = s; }

function renderChars(chars) {
  const box = $('chars');
  box.replaceChildren();
  for (const c of chars) {
    const div = document.createElement('div');
    div.className = 'char box';
    const head = document.createElement('div');
    if (c.sprite) { const img = document.createElement('img'); img.src = c.sprite; img.alt = ''; head.append(img, ' '); }
    const b = document.createElement('strong');
    text(b, `${c.name} (level ${c.level} ${c.class})`);
    head.append(b, ` ${c.status}: ${c.activity}`);
    const stats = document.createElement('div');
    text(stats, `HP ${c.hp.join('/')} MP ${c.mp.join('/')} AP ${c.ap.join('/')} XP ${c.xp.join('/')} gold ${c.gold} in ${c.room.name || '?'}${c.problem ? ' | ' + c.problem : ''}`);
    const row = document.createElement('div');
    row.className = 'row';
    const toggle = document.createElement('button');
    text(toggle, c.status === 'paused' ? 'Play' : 'Pause');
    toggle.onclick = () => call('POST', `/core/characters/${c.id}/control`, { run: c.status === 'paused' }).then(refresh, alert);
    row.append(toggle);
    if (c.claimPending) {
      const claim = document.createElement('button');
      text(claim, 'Claim it (opens the game site)');
      claim.onclick = () => call('GET', `/core/characters/${c.id}/claim`).then((r) => r.url && window.open(r.url, '_blank', 'noopener'), alert);
      row.append(claim);
    }
    const watch = document.createElement('a');
    watch.href = c.watchUrl; watch.target = '_blank'; watch.rel = 'noopener noreferrer';
    text(watch, 'Watch on the map');
    row.append(watch);
    div.append(head, stats, row);
    box.append(div);
  }
}

async function refresh() {
  try {
    const s = await call('GET', '/core/state');
    text($('state'), JSON.stringify(s, null, 2));
    const e = s.engine;
    let line = `${e.choice.kind}: ${e.status}`;
    if (e.builtin) line += ` | ${e.builtin.model} | ${(e.builtin.bytesDone / 1048576).toFixed(0)}/${(e.builtin.bytesTotal / 1048576).toFixed(0)} MB | licence: ${e.builtin.licenseName}`;
    if (e.tokensPerSecond) line += ` | ${e.tokensPerSecond} tokens/s`;
    if (e.message) line += ` | ${e.message}`;
    text($('engine'), line);
    renderChars(s.characters);
  } catch (err) {
    text($('state'), 'Error: ' + err.message + ' (open the link the program printed, or run `ajwf-player open`)');
  }
}

$('download').onclick = () => call('POST', '/core/engine/download').then(refresh, alert);
$('test').onclick = () => call('POST', '/core/engine/test').then((t) => alert(JSON.stringify(t, null, 2)), alert);
$('create').onsubmit = (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  call('POST', '/core/characters', { name: f.get('name'), class: f.get('class'), language: f.get('language'), persona: f.get('persona'), appearance: 'surprise_me' })
    .then(refresh, alert);
};

const lines = [];
ready.then(() => {
const es = new EventSource('/core/events');
es.onopen = () => ready.then(refresh);
es.onmessage = (m) => {
  const ev = JSON.parse(m.data);
  if (ev.type === 'log') lines.unshift(`[${new Date(ev.entry.ts).toLocaleTimeString()}] ${ev.entry.kind} ${ev.entry.action || ''} ${ev.entry.quote ? ev.entry.quote.from + ': "' + ev.entry.quote.text + '"' : ev.entry.text}`);
  else lines.unshift(`${ev.type}`);
  lines.length = Math.min(lines.length, 200);
  text($('events'), lines.join('\n'));
  if (ev.type !== 'chat') scheduleRefresh();
};
});
let pending = null;
function scheduleRefresh() { if (!pending) pending = setTimeout(() => { pending = null; ready.then(refresh); }, 500); }
ready.then(refresh);
