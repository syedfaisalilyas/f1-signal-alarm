#!/usr/bin/env node
// Assemble docs/ — the serverless build of the app that GitHub Pages serves.
//
// It is the same UI: public/ and src/ are copied verbatim, and the only edits
// are absolute paths (`/app.js`) becoming relative, because Pages serves the
// site from /f1-signal-alarm/ rather than the domain root. Everything that
// would otherwise need the server is supplied by docs/engine.js.
//
// Run `npm run build:web` after touching public/ or src/, then commit docs/.

import fs from 'fs';
import path from 'path';

const root = process.cwd();
const out = path.join(root, 'docs');
const copied = [];

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied.push(path.relative(root, to));
}

// The UI, as-is.
for (const f of ['app.js', 'styles.css', 'sw.js', 'manifest.json', 'icon.png']) {
  copy(path.join(root, 'public', f), path.join(out, f));
}

// The engine modules. store.js (fs) and env.js (process) stay behind; engine.js
// covers persistence with localStorage instead.
const modules = [
  'feed.js', 'providers.js', 'geofeed.js', 'strategy.js', 'indicators.js',
  'volumeprofile.js', 'calibrate.js', 'volatility.js', 'screener.js',
  'leverage.js', 'notify.js', 'trend.js', 'history.js'
];
for (const m of modules) copy(path.join(root, 'src', m), path.join(out, 'src', m));

// Pages serves from a subpath, so absolute service-worker registration breaks.
const appPath = path.join(out, 'app.js');
fs.writeFileSync(appPath, fs.readFileSync(appPath, 'utf8').replaceAll("register('/sw.js')", "register('sw.js')"));

// index.html: same markup, plus the bootstrap the page needs before app.js runs.
const head = `
<link rel="icon" href="icon.png">
<script>
  // Modules written for Node read process.env; the app socket needs the real
  // WebSocket kept aside before engine.js replaces the global.
  window.process = { env: {} };
  window.__nativeWS = window.WebSocket;
</script>
<script type="importmap">
{ "imports": { "events": "./shims/events.js", "ws": "./shims/ws.js", "web-push": "./shims/web-push.js" } }
</script>
<script type="module" src="engine.js"></script>
`;

const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8')
  .replace('href="/manifest.json"', 'href="manifest.json"')
  .replace('href="/styles.css"', 'href="styles.css"')
  .replace('<script src="/app.js"></script>', '<script src="app.js" defer></script>')
  .replace('</head>', `${head}</head>`);

fs.writeFileSync(path.join(out, 'index.html'), html);
copied.push('docs/index.html');

console.log('built docs/:');
for (const f of copied) console.log('  ' + f);
