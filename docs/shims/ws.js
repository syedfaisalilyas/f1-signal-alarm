// The 'ws' package, as far as src/feed.js is concerned.
//
// feed.js is written against Node's ws API (`ws.on('message', buf => …)`).
// Browsers ship WebSocket natively with an addEventListener API instead, so
// this maps one onto the other — letting feed.js run in the page unmodified
// rather than being reimplemented and drifting from the server's behaviour.

// Captured before engine.js swaps window.WebSocket for the app's own socket.
const Native = globalThis.__nativeWS || globalThis.WebSocket;

export default class NodeishWebSocket extends Native {
  on(event, handler) {
    if (event === 'message') {
      // Node hands the raw payload; the browser wraps it in a MessageEvent.
      this.addEventListener('message', e => handler(e.data));
    } else if (event === 'error') {
      this.addEventListener('error', e => handler(e));
    } else {
      this.addEventListener(event, () => handler());
    }
    return this;
  }
}
