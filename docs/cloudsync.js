// Keeps the scanner's watchlist identical to this page's.
//
// The problem it solves: the cards on this page live in localStorage, and the
// thing that sends Telegram is a GitHub Action that reads cloud/watchlist.json
// on main. Those are two different machines, so adding a coin here used to do
// nothing to your alerts — the scanner kept firing for whatever was last
// committed, and stayed silent on everything you had just added.
//
// So this commits the file. Every add, removal or settings change writes
// cloud/watchlist.json through the GitHub contents API, and the next scheduled
// scan (<=5 min) picks it up. Add a coin, get its alerts. Remove it, they stop.
// Empty list, silence.
//
// It needs a token, because writing to a repo requires one and a static page
// has nowhere else to keep it. Use a FINE-GRAINED token limited to this one
// repository with Contents: read and write — nothing else. It is stored in this
// browser's localStorage and sent only to api.github.com. Anyone with access to
// this browser profile can read it, so treat it as a key to this repo and
// nothing more; revoke it at github.com/settings/tokens if the device is lost.

const REPO = 'syedfaisalilyas/f1-signal-alarm';
const FILE = 'cloud/watchlist.json';
const API = `https://api.github.com/repos/${REPO}/contents/${FILE}`;
const TOKEN_KEY = 'f1githubtoken';

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
export const setToken = t => {
  try { t ? localStorage.setItem(TOKEN_KEY, t.trim()) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
};

// Listeners for the status line in the UI.
const listeners = new Set();
export const onStatus = fn => { listeners.add(fn); return () => listeners.delete(fn); };
let status = { state: 'idle', text: '', at: 0 };
export const getStatus = () => status;
function setStatus(state, text) {
  status = { state, text, at: Date.now() };
  for (const fn of listeners) { try { fn(status); } catch { /* a broken listener must not stop a sync */ } }
}

const headers = token => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
});

// btoa cannot take characters above U+00FF, and Binance lists perps named
// 龙虾USDT. Encode as UTF-8 bytes first.
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// A rapid series of clicks — adding six coins, clearing the board — should be
// one commit, not six. Coalesce and always send the newest state.
let timer = null;
let pending = null;
let inflight = false;

export function scheduleSync(getPayload, delay = 4000) {
  if (!getToken()) return;                     // not configured — stay quiet
  pending = getPayload;
  setStatus('pending', 'syncing to the scanner…');
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

// Used by the "sync now" button so the user never has to guess whether it went.
export async function syncNow(getPayload) {
  pending = getPayload;
  clearTimeout(timer);
  return run();
}

async function run() {
  if (inflight) { clearTimeout(timer); timer = setTimeout(run, 1500); return; }
  const token = getToken();
  if (!token) return setStatus('off', 'no GitHub token — alerts still use the last committed list');
  const build = pending;
  if (!build) return;
  pending = null;
  inflight = true;
  try {
    const payload = build();
    const body = JSON.stringify(payload, null, 2) + '\n';

    // The API needs the blob SHA it is replacing. A 404 means the file does not
    // exist yet, which is a create rather than an update.
    let sha;
    const cur = await fetch(`${API}?ref=main&t=${Date.now()}`, { headers: headers(token), cache: 'no-store' });
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
      // Nothing changed — skip the commit rather than pushing an identical file
      // every time a settings sheet is opened and closed.
      if (j.content && atob(j.content.replace(/\n/g, '')) === body) {
        return setStatus('ok', 'scanner already matches this list');
      }
    } else if (cur.status === 401) {
      return setStatus('error', 'token rejected — check it has Contents: write on this repo');
    } else if (cur.status !== 404) {
      return setStatus('error', `GitHub ${cur.status} reading the watchlist`);
    }

    const n = payload.watches.length;
    const res = await fetch(API, {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `watchlist: ${n} watch${n === 1 ? '' : 'es'} from the app`,
        content: b64(body),
        sha,
        branch: 'main'
      })
    });

    if (res.ok) {
      setStatus('ok', n
        ? `scanner set to ${n} watch${n === 1 ? '' : 'es'} — live within 5 min`
        : 'watchlist empty — the scanner will send nothing');
    } else {
      const t = await res.text();
      setStatus('error', res.status === 409
        ? 'someone edited the watchlist at the same time — try sync again'
        : `GitHub ${res.status}: ${t.slice(0, 120)}`);
    }
  } catch (e) {
    setStatus('error', e.message);
  } finally {
    inflight = false;
  }
}

// Does the committed file already match? Used on load so the status line tells
// the truth before anything is changed.
export async function checkSync(getPayload) {
  const token = getToken();
  if (!token) return setStatus('off', 'not syncing — add a GitHub token to control Telegram alerts from here');
  try {
    const res = await fetch(`${API}?ref=main&t=${Date.now()}`, { headers: headers(token), cache: 'no-store' });
    if (res.status === 401) return setStatus('error', 'token rejected — check it has Contents: write on this repo');
    if (!res.ok) return setStatus('error', `GitHub ${res.status} reading the watchlist`);
    const j = await res.json();
    const remote = JSON.parse(atob(j.content.replace(/\n/g, '')));
    const mine = getPayload();
    const ids = a => (a.watches || []).map(w => w.id).sort().join('|');
    if (ids(remote) === ids(mine)) {
      const n = mine.watches.length;
      setStatus('ok', n ? `scanner matches — ${n} watch${n === 1 ? '' : 'es'}` : 'watchlist empty — the scanner sends nothing');
    } else {
      setStatus('stale', `scanner is on a different list (${(remote.watches || []).length} vs ${mine.watches.length}) — press sync`);
    }
  } catch (e) {
    setStatus('error', e.message);
  }
}
