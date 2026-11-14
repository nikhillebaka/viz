// A minimal Chrome DevTools Protocol client and a Page helper for the e2e checks.
// Node built-ins only (global WebSocket, node:fs, node:path).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rejects with `message` if `promise` has not settled within `ms`. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Connects to a browser-level DevTools WebSocket.
 * @param {string} wsUrl ws://127.0.0.1:<port>/devtools/browser/<id>
 * @returns {Promise<{send: Function, on: Function, off: Function, close: Function}>}
 *   send(method, params?, sessionId?, { timeout = 30000 }?) resolves with the result or rejects with
 *   the protocol error; on(event, fn) calls fn(params, sessionId) for every matching event.
 */
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await withTimeout(new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`could not connect to ${wsUrl}`)), { once: true });
  }), 10000, `timed out connecting to ${wsUrl}`);

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  let closed = false;

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of listeners.get(msg.method) || []) {
      try { fn(msg.params, msg.sessionId); } catch (e) { console.error(e); }
    }
  });
  ws.addEventListener("close", () => {
    closed = true;
    for (const p of pending.values()) p.reject(new Error(`${p.method}: connection closed`));
    pending.clear();
  });

  return {
    send(method, params = {}, sessionId, { timeout = 30000 } = {}) {
      if (closed) return Promise.reject(new Error(`${method}: connection closed`));
      const id = nextId++;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
      ws.send(JSON.stringify(msg));
      return withTimeout(p, timeout, `${method}: no answer within ${timeout} ms`).finally(() => pending.delete(id));
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    off(event, fn) { listeners.get(event)?.delete(fn); },
    close() { if (!closed) ws.close(); },
    get closed() { return closed; },
  };
}

const MOD_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
/** ["Shift", "Meta"] → CDP modifier bitmask. */
function modBits(modifiers = []) {
  let bits = 0;
  for (const m of modifiers) {
    if (!(m in MOD_BITS)) throw new Error(`unknown modifier "${m}" (use Shift, Control, Alt, Meta)`);
    bits |= MOD_BITS[m];
  }
  return bits;
}

const BUTTON_BITS = { left: 1, right: 2, middle: 4 };

const NAMED_KEYS = {
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};

const PUNCT = {
  "=": ["Equal", 187], "+": ["Equal", 187], "-": ["Minus", 189], "_": ["Minus", 189],
  "/": ["Slash", 191], "?": ["Slash", 191], ".": ["Period", 190], ",": ["Comma", 188],
  ";": ["Semicolon", 186], "'": ["Quote", 222], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], "`": ["Backquote", 192],
};

/** Key name or single character → { key, code, keyCode, text? }. */
function keyDef(name) {
  if (NAMED_KEYS[name]) return { key: name, ...NAMED_KEYS[name] };
  if ([...name].length !== 1) throw new Error(`unknown key "${name}"`);
  const ch = name;
  if (/[a-z]/i.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  if (/[0-9]/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  if (PUNCT[ch]) return { key: ch, code: PUNCT[ch][0], keyCode: PUNCT[ch][1], text: ch };
  return { key: ch, code: "", keyCode: 0, text: ch };
}

/** Serialises a page function call: fn and JSON args → an expression. */
function expression(fn, args) {
  if (typeof fn === "string") {
    if (args.length) throw new Error("eval(string) takes no arguments");
    return fn;
  }
  return `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`;
}

/**
 * One page (target) attached through a flat session.
 * Collects uncaught exceptions and console.error messages into `errors`.
 */
export class Page {
  /**
   * Opens a new blank target and attaches to it.
   * @param {object} client from connect()
   * @param {{ base: string, width?: number, height?: number, deviceScaleFactor?: number }} opts
   * @returns {Promise<Page>}
   */
  static async open(client, { base, width = 1440, height = 900, deviceScaleFactor = 2 }) {
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(client, sessionId, targetId, base);
    page.deviceScaleFactor = deviceScaleFactor;
    await Promise.all([
      page.send("Page.enable"),
      page.send("Runtime.enable"),
      page.send("Network.enable"),
      page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false }),
    ]);
    await page.send("Page.bringToFront").catch(() => {});
    return page;
  }

  constructor(client, sessionId, targetId, base) {
    this.client = client;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.base = base;
    /** Uncaught exceptions and console.error messages, as strings, in order. */
    this.errors = [];
    /** Uncaught exceptions only (the runner fails a check that ends with any). */
    this.exceptions = [];
    this.errorsAllowed = false;
    /** Emulated device scale factor; wheel deltas are scaled by it (Chrome divides them by it). */
    this.deviceScaleFactor = 1;
    this._media = {};
    this._mouse = { x: 0, y: 0, buttons: 0 };
    this._status = new Map(); // loaderId → HTTP status of the document
    this._off = [
      client.on("Runtime.exceptionThrown", (p, sid) => {
        if (sid !== sessionId) return;
        const d = p.exceptionDetails;
        const msg = `Uncaught ${d.exception?.description || d.text}`;
        this.exceptions.push(msg);
        this.errors.push(msg);
      }),
      client.on("Runtime.consoleAPICalled", (p, sid) => {
        if (sid !== sessionId || (p.type !== "error" && p.type !== "assert")) return;
        const text = p.args.map((a) => a.value ?? a.description ?? a.unserializableValue ?? a.type).join(" ");
        this.errors.push(`console.${p.type}: ${text}`);
      }),
      client.on("Network.responseReceived", (p, sid) => {
        if (sid === sessionId && p.type === "Document") this._status.set(p.loaderId, p.response.status);
      }),
    ];
    this.mouse = {
      move: (x, y, o) => this._move(x, y, o),
      down: (x, y, o) => this._button("mousePressed", x, y, o),
      up: (x, y, o) => this._button("mouseReleased", x, y, o),
      click: (x, y, o) => this._click(x, y, o),
      drag: (x0, y0, x1, y1, o) => this._drag(x0, y0, x1, y1, o),
      wheel: (x, y, o) => this._wheel(x, y, o),
    };
    this.key = {
      press: (k, o) => this._press(k, o),
      type: (text) => this._type(text),
    };
  }

  /** Sends a protocol command on this page's session. */
  send(method, params = {}, opts) {
    return this.client.send(method, params, this.sessionId, opts);
  }

  /** Stops the runner from failing this check over uncaught page exceptions. */
  allowErrors() { this.errorsAllowed = true; }

  /**
   * Navigates and waits.
   * @param {string} pathOrUrl relative paths resolve against the base URL
   * @param {{ waitUntil?: "load" | "domcontentloaded" | "none", timeout?: number }} [opts]
   * @returns {Promise<{ status: number | null, url: string }>}
   */
  async goto(pathOrUrl, { waitUntil = "load", timeout = 30000 } = {}) {
    const url = new URL(pathOrUrl, this.base).href;
    const event = { load: "Page.loadEventFired", domcontentloaded: "Page.domContentEventFired" }[waitUntil];
    let off;
    const fired = event ? new Promise((resolve) => { off = this.client.on(event, (_, sid) => sid === this.sessionId && resolve()); }) : null;
    try {
      const nav = await this.send("Page.navigate", { url });
      if (nav.errorText) throw new Error(`goto ${url}: ${nav.errorText}`);
      if (fired && nav.loaderId) await withTimeout(fired, timeout, `goto ${url}: no ${waitUntil} within ${timeout} ms`);
      return { status: this._status.get(nav.loaderId) ?? null, url };
    } finally {
      off?.();
    }
  }

  /** Reloads and waits for load. */
  async reload({ timeout = 30000 } = {}) {
    let off;
    const fired = new Promise((resolve) => { off = this.client.on("Page.loadEventFired", (_, sid) => sid === this.sessionId && resolve()); });
    try {
      await this.send("Page.reload");
      await withTimeout(fired, timeout, `reload: no load within ${timeout} ms`);
    } finally {
      off();
    }
  }

  /**
   * Runs code in the page and returns its JSON-serialisable value (promises are awaited).
   * @param {Function | string} fn a function (serialised; closures are not carried) or an expression
   * @param {...any} args JSON arguments for fn
   */
  async eval(fn, ...args) {
    const res = await this.send("Runtime.evaluate", {
      expression: expression(fn, args),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, { timeout: 60000 });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const err = new Error(`in page: ${d.exception?.description || d.exception?.value || d.text}`);
      throw err;
    }
    return res.result.value;
  }

  /**
   * Polls eval until it returns something truthy, and returns it. Errors while polling count as falsy.
   * @param {Function | string} fn
   * @param {{ timeout?: number, interval?: number, message?: string, args?: any[] }} [opts]
   */
  async waitFor(fn, { timeout = 5000, interval = 16, message, args = [] } = {}) {
    const end = Date.now() + timeout;
    let lastErr;
    for (;;) {
      try {
        const v = await this.eval(fn, ...args);
        if (v) return v;
        lastErr = undefined;
      } catch (e) { lastErr = e; }
      if (Date.now() >= end) {
        const what = message || `waitFor timed out after ${timeout} ms: ${typeof fn === "string" ? fn : fn.toString().slice(0, 120)}`;
        throw new Error(lastErr ? `${what} (last error: ${lastErr.message})` : what);
      }
      await sleep(interval);
    }
  }

  /** Resolves after n animation frames in the page (falls back to 100 ms per frame if rAF stalls). */
  frames(n = 1) {
    return this.eval((n) => new Promise((resolve) => {
      const fallback = setTimeout(resolve, n * 100);
      const step = (k) => (k <= 0 ? (clearTimeout(fallback), resolve()) : requestAnimationFrame(() => step(k - 1)));
      step(n);
    }), n);
  }

  sleep(ms) { return sleep(ms); }

  /**
   * Resolves once no Web Animations are running and `window.__viz.idle()` (if the app provides it)
   * has been true on consecutive samples spanning `quiet` ms. Rejects after `timeout`.
   */
  async settle({ quiet = 150, timeout = 4000 } = {}) {
    const end = Date.now() + timeout;
    const every = Math.max(16, Math.floor(quiet / 2));
    let since = null;
    let samples = 0;
    for (;;) {
      let idle = false;
      try {
        idle = await this.eval(() => {
          const v = window.__viz;
          const hook = v && typeof v.idle === "function" ? !!v.idle() : true;
          return document.getAnimations().length === 0 && hook;
        });
      } catch { idle = false; }
      const now = Date.now();
      if (idle) {
        if (since === null) { since = now; samples = 0; }
        samples++;
        if (samples >= 2 && now - since >= quiet) return;
      } else {
        since = null;
      }
      if (now >= end) throw new Error(`settle: page still busy after ${timeout} ms`);
      await sleep(every);
    }
  }

  // ---- input ----

  async _move(x, y, { steps = 1, modifiers } = {}) {
    const { x: x0, y: y0 } = this._mouse;
    for (let i = 1; i <= steps; i++) {
      const px = x0 + ((x - x0) * i) / steps;
      const py = y0 + ((y - y0) * i) / steps;
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: px, y: py, modifiers: modBits(modifiers),
        buttons: this._mouse.buttons, button: this._mouse.buttons ? this._pressedButton : "none",
      });
      this._mouse.x = px; this._mouse.y = py;
      if (i < steps) await sleep(16);
    }
  }

  async _button(type, x, y, { button = "left", modifiers, clickCount = 1 } = {}) {
    if (x !== this._mouse.x || y !== this._mouse.y) await this._move(x, y, { modifiers });
    if (type === "mousePressed") { this._mouse.buttons |= BUTTON_BITS[button]; this._pressedButton = button; }
    else this._mouse.buttons &= ~BUTTON_BITS[button];
    await this.send("Input.dispatchMouseEvent", {
      type, x, y, button, clickCount, modifiers: modBits(modifiers), buttons: this._mouse.buttons,
    });
  }

  async _click(x, y, { count = 1, button = "left", modifiers } = {}) {
    for (let c = 1; c <= count; c++) {
      await this._button("mousePressed", x, y, { button, modifiers, clickCount: c });
      await this._button("mouseReleased", x, y, { button, modifiers, clickCount: c });
    }
  }

  async _drag(x0, y0, x1, y1, { steps = 10, modifiers, hold = 0, button = "left" } = {}) {
    await this._move(x0, y0, { modifiers });
    await this._button("mousePressed", x0, y0, { button, modifiers });
    if (hold) await sleep(hold);
    for (let i = 1; i <= steps; i++) {
      await sleep(16);
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * i) / steps;
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x, y, modifiers: modBits(modifiers), buttons: this._mouse.buttons, button,
      });
      this._mouse.x = x; this._mouse.y = y;
    }
    await this._button("mouseReleased", x1, y1, { button, modifiers });
  }

  async _wheel(x, y, { dx = 0, dy = 0, modifiers } = {}) {
    if (x !== this._mouse.x || y !== this._mouse.y) await this._move(x, y, { modifiers });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: dx * this.deviceScaleFactor, deltaY: dy * this.deviceScaleFactor, modifiers: modBits(modifiers), buttons: this._mouse.buttons,
    });
  }

  async _press(name, { modifiers = [] } = {}) {
    const d = keyDef(name);
    const bits = modBits(modifiers);
    // A command chord (Control/Meta/Alt) produces no text, like a real keyboard.
    const text = d.text && !(bits & (MOD_BITS.Control | MOD_BITS.Meta | MOD_BITS.Alt)) ? d.text : undefined;
    const base = { key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, modifiers: bits };
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text, unmodifiedText: text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async _type(text) {
    for (const ch of text) {
      let def;
      try { def = keyDef(ch); } catch { def = null; }
      if (def && def.code) await this._press(ch, { modifiers: /[A-Z]/.test(ch) ? ["Shift"] : [] });
      else await this.send("Input.insertText", { text: ch });
    }
  }

  /**
   * Pinch-zooms around (x, y) by scaleFactor (>1 zooms in). Uses Input.synthesizePinchGesture,
   * falling back to ctrl+wheel steps (how Chrome delivers a trackpad pinch) if it is unavailable.
   * @returns {Promise<"gesture" | "wheel">} which path was used
   */
  async pinch(x, y, scaleFactor) {
    try {
      await this.send("Input.synthesizePinchGesture", { x, y, scaleFactor, gestureSourceType: "mouse" }, { timeout: 5000 });
      return "gesture";
    } catch {
      const steps = 10;
      const total = -Math.log(scaleFactor) * 100; // Chrome: scale ≈ exp(-deltaY / 100)
      for (let i = 0; i < steps; i++) {
        await this._wheel(x, y, { dy: total / steps, modifiers: ["Control"] });
        await sleep(16);
      }
      return "wheel";
    }
  }

  // ---- DOM queries ----

  /** getBoundingClientRect of the first match plus its centre, or null. */
  rect(selector) {
    return this.eval((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }, selector);
  }

  /** textContent of the first match (trimmed), or null. */
  text(selector) {
    return this.eval((s) => { const el = document.querySelector(s); return el ? el.textContent.trim() : null; }, selector);
  }

  exists(selector) { return this.eval((s) => !!document.querySelector(s), selector); }

  count(selector) { return this.eval((s) => document.querySelectorAll(s).length, selector); }

  /** Writes a PNG of the viewport to `file`. */
  async screenshot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  /**
   * Emulates media features; omitted keys keep their current emulation.
   * @param {{ reducedMotion?: boolean, colorScheme?: "light" | "dark" }} opts
   */
  async emulate({ reducedMotion, colorScheme } = {}) {
    if (reducedMotion !== undefined) this._media["prefers-reduced-motion"] = reducedMotion ? "reduce" : "no-preference";
    if (colorScheme !== undefined) this._media["prefers-color-scheme"] = colorScheme;
    await this.send("Emulation.setEmulatedMedia", {
      features: Object.entries(this._media).map(([name, value]) => ({ name, value })),
    });
  }

  /** Detaches listeners and closes the target. */
  async close() {
    for (const off of this._off) off();
    await this.client.send("Target.closeTarget", { targetId: this.targetId }, undefined, { timeout: 5000 }).catch(() => {});
  }
}
