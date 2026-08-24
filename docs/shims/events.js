// Node's EventEmitter, in the ~20 lines feed.js actually uses.
export class EventEmitter {
  #handlers = new Map();

  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return this;
  }

  once(event, fn) {
    const wrap = (...args) => { this.off(event, wrap); fn(...args); };
    return this.on(event, wrap);
  }

  off(event, fn) {
    this.#handlers.get(event)?.delete(fn);
    return this;
  }

  removeAllListeners(event) {
    if (event) this.#handlers.delete(event); else this.#handlers.clear();
    return this;
  }

  emit(event, ...args) {
    const set = this.#handlers.get(event);
    if (!set?.size) return false;
    // Copied first so a handler removing itself mid-emit can't skip the next one.
    for (const fn of [...set]) fn(...args);
    return true;
  }
}
export default { EventEmitter };
