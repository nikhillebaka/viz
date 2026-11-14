/* The app state container: one frozen plain object, shallow-merged patches, synchronous
 * notification with the set of keys that changed. */

/**
 * @param {object} initial
 * @returns {{ get(): object, set(patch: object | ((s: object) => object)): boolean,
 *             on(fn: (s: object, prev: object, changed: Set<string>) => void): () => void,
 *             select(keys: string[], fn: (s: object, prev: object) => void): () => void }}
 */
export function createStore(initial = {}) {
  let state = Object.freeze({ ...initial });
  const fns = new Set();
  // A set() from inside a listener applies at once (get() is fresh) and is announced after the current
  // round, so every listener sees each change exactly once and in order.
  let notifying = false, pendingPrev = null, pendingKeys = null;

  function notify(s, prev, changed) {
    for (const fn of [...fns]) if (fns.has(fn)) fn(s, prev, changed);
  }

  return {
    /** @returns {object} the current state (frozen; never mutate) */
    get: () => state,

    /**
     * Shallow-merge a patch (or the patch a function returns). Keys whose value is identical
     * (Object.is) don't count as changes; when nothing changed this is a no-op.
     * @returns {boolean} whether anything changed
     */
    set(patch) {
      const p = typeof patch === "function" ? patch(state) : patch;
      if (!p) return false;
      const changed = new Set();
      for (const k of Object.keys(p)) if (!Object.is(state[k], p[k])) changed.add(k);
      if (!changed.size) return false;
      const prev = state;
      state = Object.freeze({ ...state, ...p });
      if (notifying) {
        pendingPrev ??= prev;
        pendingKeys ??= new Set();
        changed.forEach((k) => pendingKeys.add(k));
        return true;
      }
      notifying = true;
      try {
        notify(state, prev, changed);
        while (pendingKeys) {
          const pp = pendingPrev, pk = pendingKeys;
          pendingPrev = pendingKeys = null;
          notify(state, pp, pk);
        }
      } finally {
        notifying = false; pendingPrev = pendingKeys = null;
      }
      return true;
    },

    /** @returns {() => void} unsubscribes */
    on(fn) { fns.add(fn); return () => fns.delete(fn); },

    /** fn runs only when one of `keys` changed. @returns {() => void} unsubscribes */
    select(keys, fn) {
      return this.on((s, prev, changed) => { if (keys.some((k) => changed.has(k))) fn(s, prev); });
    },
  };
}
