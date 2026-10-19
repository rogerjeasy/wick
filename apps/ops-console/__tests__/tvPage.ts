/**
 * A page for tv.html's three scripts to run in, under node:vm: just enough of
 * a document — elements that remember what is put on them, a selector
 * matcher for the few selectors the scripts use, focus, clicks that are
 * caught on their way down, the keyboard, a <video>, both storages — with
 * the clock, the timers, the network and the card channel all the test's.
 * Nothing happens until the test says time has passed, and nothing is
 * answered until it answers. How it looks is checked in a real browser.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const read = (file: string): string => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
export const ENGINE_SOURCE = read('tv-engine.generated.js');
export const CORE_SOURCE = read('tv-core.js');
export const TV_SOURCE = read('tv.js');
export const CATALOG = JSON.parse(read('tv-catalog.json')) as { programmes: Array<{ id: string; title: string; durationMs: number; creditsPositionMs: number; calmPointsMs: number[] }> };

type Listener = { fn: (event: FakeEvent) => void; capture: boolean };
export interface FakeEvent {
  type: string;
  target: El | null;
  key?: string;
  repeat?: boolean;
  defaultPrevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
  stopPropagation(): void;
}

function event(type: string, target: El | null, extra: Record<string, unknown> = {}): FakeEvent {
  return {
    type,
    target,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...extra,
  };
}

/** One simple selector: a tag, classes, attributes, and :not() of the same. */
function matchesSimple(node: El, simple: string): boolean {
  let rest = simple;
  const nots: string[] = [];
  rest = rest.replace(/:not\(([^)]*)\)/g, (_m, inner: string) => {
    nots.push(inner);
    return '';
  });
  const attrs: Array<[string, string | undefined]> = [];
  rest = rest.replace(/\[([\w-]+)(?:="([^"]*)")?\]/g, (_m, name: string, value: string | undefined) => {
    attrs.push([name, value]);
    return '';
  });
  const classes = [...rest.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
  const tag = /^[a-z]+/i.exec(rest)?.[0];
  if (tag && node.tagName !== tag.toLowerCase()) return false;
  if (!classes.every((c) => node.classList.contains(c))) return false;
  if (!attrs.every(([name, value]) => (value === undefined ? node.hasAttr(name) : node.attr(name) === value))) return false;
  return nots.every((inner) => !matchesSimple(node, inner));
}

function matches(node: El, selector: string): boolean {
  return selector.split(',').some((alternative) => {
    const parts = alternative.trim().split(/\s+/);
    if (!matchesSimple(node, parts.at(-1)!)) return false;
    let at = node.parent;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (at && !matchesSimple(at, parts[i]!)) at = at.parent;
      if (!at) return false;
      at = at.parent;
    }
    return true;
  });
}

export class El {
  tagName: string;
  className = '';
  children: El[] = [];
  parent: El | null = null;
  #text = '';
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  style: Record<string, unknown> & { setProperty(name: string, value: string): void };
  hidden = false;
  disabled = false;
  tabIndex = -1;
  [key: string]: unknown;

  constructor(
    tagName: string,
    readonly page: FakePage,
  ) {
    this.tagName = tagName.toLowerCase();
    this.style = {
      setProperty: (name: string, value: string) => {
        this.style[name] = value;
      },
    };
  }

  get textContent(): string {
    return this.#text + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this.#text = String(value);
    this.children = [];
  }

  /** Its own words, and nothing of its children's. */
  get ownText(): string {
    return this.#text;
  }

  get classList() {
    const names = () => this.className.split(' ').filter(Boolean);
    return {
      contains: (name: string) => names().includes(name),
      add: (...add: string[]) => {
        this.className = [...new Set([...names(), ...add])].join(' ');
      },
      remove: (...remove: string[]) => {
        this.className = names().filter((n) => !remove.includes(n)).join(' ');
      },
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !names().includes(name);
        if (on) this.classList.add(name);
        else this.classList.remove(name);
        return on;
      },
    };
  }

  hasAttr(name: string): boolean {
    if (name === 'hidden') return this.hidden;
    if (name === 'disabled') return this.disabled;
    if (name.startsWith('data-')) return this.dataset[toCamel(name.slice(5))] !== undefined;
    return name in this.attributes;
  }

  attr(name: string): string | undefined {
    if (name.startsWith('data-')) return this.dataset[toCamel(name.slice(5))];
    return this.attributes[name];
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
    delete this[name];
  }

  appendChild(child: El): El {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children: El[]): void {
    for (const child of children) this.appendChild(child);
  }

  insertBefore(child: El, before: El | null): El {
    child.remove();
    child.parent = this;
    const at = before ? this.children.indexOf(before) : -1;
    if (at < 0) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }

  removeChild(child: El): El {
    this.children.splice(this.children.indexOf(child), 1);
    child.parent = null;
    return child;
  }

  remove(): void {
    if (this.parent) this.parent.removeChild(this);
  }

  replaceChildren(...next: El[]): void {
    for (const child of [...this.children]) this.removeChild(child);
    this.#text = '';
    for (const child of next) this.appendChild(child);
  }

  get firstChild(): El | null {
    return this.children[0] ?? null;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  /** This node and each of its ancestors, the node first. */
  lineage(): El[] {
    const line: El[] = [];
    for (let at: El | null = this.parent; at; at = at.parent) line.push(at);
    return [this as El, ...line];
  }

  get isConnected(): boolean {
    return this.lineage().at(-1) === this.page.body;
  }

  contains(node: unknown): boolean {
    let at = node as El | null;
    while (at) {
      if (at === this) return true;
      at = at.parent;
    }
    return false;
  }

  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }

  querySelectorAll(selector: string): El[] {
    return this.all().filter((node) => matches(node, selector));
  }

  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): El | null {
    return this.lineage().find((node) => matches(node, selector)) ?? null;
  }

  addEventListener(type: string, fn: (event: FakeEvent) => void, capture?: boolean | { capture?: boolean }): void {
    (this.listeners[type] ??= []).push({ fn, capture: capture === true || (typeof capture === 'object' && capture.capture === true) });
  }

  removeEventListener(type: string, fn: (event: FakeEvent) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l.fn !== fn);
  }

  /** Down from the top to the target, capturing; then at the target; then up again. */
  dispatch(e: FakeEvent): void {
    const path = this.lineage().reverse();
    for (const node of path.slice(0, -1)) {
      for (const l of node.listeners[e.type] ?? []) if (l.capture && !e.stopped) l.fn(e);
      if (e.stopped) return;
    }
    for (const l of this.listeners[e.type] ?? []) if (!e.stopped) l.fn(e);
    const handler = this[`on${e.type}`];
    if (!e.stopped && typeof handler === 'function') (handler as (e: FakeEvent) => void).call(this, e);
    for (const node of path.slice(0, -1).reverse()) {
      for (const l of node.listeners[e.type] ?? []) if (!l.capture && !e.stopped) l.fn(e);
    }
  }

  click(): void {
    this.dispatch(event('click', this));
  }

  focus(): void {
    this.page.document.activeElement = this;
    this.dispatch(event('focusin', this));
  }

  blur(): void {
    if (this.page.document.activeElement === this) this.page.document.activeElement = this.page.body;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number } {
    const box = this.page.layout(this);
    return { ...box, right: box.left + box.width, bottom: box.top + box.height };
  }

  getClientRects(): unknown[] {
    return [this.getBoundingClientRect()];
  }

  get clientWidth(): number {
    return 960;
  }

  get scrollHeight(): number {
    return 0;
  }

  get clientHeight(): number {
    return 0;
  }
}

const toCamel = (name: string): string => name.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());

/** A <video>: paused until played, at the place the test puts it. */
export class FakeVideo extends El {
  paused = true;
  ended = false;
  currentTime = 0;
  duration = Number.NaN;
  readyState = 4;
  volume = 1;
  controls = true;
  playsInline = false;
  src = '';
  plays = 0;

  play(): Promise<void> {
    this.plays += 1;
    if (this.paused) {
      this.paused = false;
      this.dispatch(event('play', this));
      this.dispatch(event('playing', this));
    }
    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatch(event('pause', this));
  }

  load(): void {}
}

export interface FakePage {
  document: {
    activeElement: El | null;
    hidden: boolean;
    head: El;
    body: El;
    getElementById(id: string): El;
    createElement(tag: string): El;
    createElementNS(namespace: string, tag: string): El;
    addEventListener(type: string, fn: (event: FakeEvent) => void): void;
    removeEventListener(type: string, fn: (event: FakeEvent) => void): void;
  };
  body: El;
  layout: (node: El) => { left: number; top: number; width: number; height: number };
}

/**
 * Where things are, roughly as the home screen and a card lay them out on a
 * 960 by 540 screen — enough for the arrows to have somewhere to go.
 */
function homeLayout(node: El): { left: number; top: number; width: number; height: number } {
  const key = node.dataset.key ?? '';
  if (key === 'light') return { left: 780, top: 32, width: 130, height: 50 };
  if (key.startsWith('programme:')) {
    const i = node.parent ? node.parent.children.indexOf(node) : 0;
    return { left: 48 + i * 296, top: 110, width: 272, height: 330 };
  }
  if (key === 'waiting') return { left: 48, top: 470, width: 500, height: 50 };
  if (key === 'mantel') return { left: 600, top: 470, width: 150, height: 50 };
  if (key === 'easier') return { left: 770, top: 470, width: 140, height: 50 };
  if (node.tagName === 'button' && node.parent) {
    // A card's buttons, in a row.
    const i = node.parent.children.indexOf(node);
    return { left: 80 + i * 260, top: 420, width: 240, height: 80 };
  }
  return { left: 0, top: 0, width: 0, height: 0 };
}

export interface Asked {
  url: string;
  method: string;
  body: unknown;
  answer(status: number, body?: unknown): void;
}

export interface TvOptions {
  /** What the tab's sessionStorage holds when the page loads: the television it remembers being. */
  readonly remembered?: Record<string, string>;
  /** What the device's localStorage holds when the page loads. */
  readonly stored?: Record<string, string>;
  /** A browser that refuses the page its localStorage. */
  readonly noLocalStorage?: boolean;
}

/** A resident's television the tab remembers, so the page goes straight to its card channel. */
export const REMEMBERED = { wick_virtual_television: JSON.stringify({ kind: 'resident', jwt: 'a.b.c', deviceId: 'ops-console-test', proof: 'p'.repeat(64) }) };

export function tvPage(opts: TvOptions = {}) {
  const page = { layout: homeLayout } as unknown as FakePage;
  const docListeners: Record<string, Array<(event: FakeEvent) => void>> = {};
  const byId = new Map<string, El>();
  const make = (tag: string): El => (tag.toLowerCase() === 'video' ? new FakeVideo(tag, page) : new El(tag, page));
  page.body = make('body');
  page.document = {
    activeElement: page.body,
    hidden: false,
    head: make('head'),
    body: page.body,
    getElementById: (id: string) => {
      let node = byId.get(id);
      if (!node) {
        node = make(id === 'tv-keys' ? 'aside' : id.endsWith('close') ? 'button' : 'div');
        byId.set(id, node);
        if (id === 'tv-keys') node.hidden = true;
        // The screen and the legend are on the page; anything else the scripts ask for is a stray.
        if (id === 'tv-screen' || id === 'tv-keys') page.body.appendChild(node);
      }
      return node;
    },
    createElement: make,
    // The pairing screen's QR code is an SVG (tv-core.js qrFigure): its elements are nodes like any other here.
    createElementNS: (_namespace, tag) => make(tag),
    addEventListener: (type, fn) => {
      (docListeners[type] ??= []).push(fn);
    },
    removeEventListener: (type, fn) => {
      docListeners[type] = (docListeners[type] ?? []).filter((l) => l !== fn);
    },
  };
  const screen = page.document.getElementById('tv-screen');
  screen.className = 'tv-screen';
  page.document.getElementById('tv-keys');

  const clock = { now: 1_800_000_000_000 };
  const timers: Array<{ fn: () => void; due: number; every: number | null; cleared: boolean }> = [];
  const stop = (id: number) => {
    if (timers[id]) timers[id].cleared = true;
  };
  const asked: Asked[] = [];
  const tab = new Map(Object.entries(opts.remembered ?? {}));
  const device = new Map(Object.entries(opts.stored ?? {}));
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    sent: Array<Record<string, unknown>> = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (() => void) | null;
    onerror?: () => void;
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send(data: string) {
      const frame = JSON.parse(data) as Record<string, unknown>;
      // The edge answers a ping at once (edge-device route.mjs), and the channel's heartbeat counts on it. Not a thing the page sent.
      if (frame.t === 'ping') {
        timers.push({ fn: () => this.onmessage?.({ data: JSON.stringify({ kind: 'control', control: { t: 'pong' } }) }), due: clock.now, every: null, cleared: false });
        return;
      }
      this.sent.push(frame);
    }
    close() {}
  }
  const sounds: Array<{ src: string; played: number }> = [];
  class FakeAudio {
    played = 0;
    onplaying?: () => void;
    onended?: () => void;
    onerror?: () => void;
    constructor(readonly src: string) {
      sounds.push(this);
    }
    play() {
      this.played += 1;
      return Promise.resolve();
    }
    pause() {}
  }
  const localStorage = opts.noLocalStorage
    ? undefined
    : { getItem: (k: string) => device.get(k) ?? null, setItem: (k: string, v: string) => void device.set(k, v), removeItem: (k: string) => void device.delete(k) };

  const context = vm.createContext({
    document: page.document,
    window: { addEventListener() {} },
    getComputedStyle: () => ({}),
    console,
    URL,
    AbortController,
    crypto: globalThis.crypto,
    WebSocket: FakeSocket,
    Audio: FakeAudio,
    Date: class extends Date {
      static override now() {
        return clock.now;
      }
    },
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, due: clock.now + (ms ?? 0), every: null, cleared: false }) - 1,
    clearTimeout: stop,
    setInterval: (fn: () => void, ms: number) => timers.push({ fn, due: clock.now + ms, every: ms, cleared: false }) - 1,
    clearInterval: stop,
    sessionStorage: { getItem: (k: string) => tab.get(k) ?? null, setItem: (k: string, v: string) => void tab.set(k, v), removeItem: (k: string) => void tab.delete(k) },
    ...(localStorage ? { localStorage } : {}),
    fetch: (url: string, init: { method?: string; body?: string } = {}) =>
      new Promise((resolve) => {
        asked.push({
          url,
          method: init.method ?? 'GET',
          body: init.body === undefined ? undefined : JSON.parse(init.body),
          answer: (status, body) => resolve({ status, ok: status >= 200 && status < 300, json: async () => body }),
        });
      }),
  });
  if (opts.noLocalStorage) {
    Object.defineProperty(context, 'localStorage', {
      get() {
        throw new Error('SecurityError: the browser refuses this page its storage');
      },
    });
  }
  vm.runInContext(ENGINE_SOURCE, context, { filename: 'tv-engine.generated.js' });
  vm.runInContext(CORE_SOURCE, context, { filename: 'tv-core.js' });
  vm.runInContext(TV_SOURCE, context, { filename: 'tv.js' });

  const socket = () => sockets.at(-1)!;
  const receive = (message: unknown) => socket().onmessage!({ data: JSON.stringify(message) });
  const run = (expression: string): unknown => vm.runInContext(expression, context);
  const key = (type: 'keydown' | 'keyup', name: string, repeat = false) => {
    const e = event(type, page.document.activeElement, { key: name, repeat });
    for (const fn of docListeners[type] ?? []) fn(e);
    return e;
  };
  const advance = (ms: number) => {
    const until = clock.now + ms;
    for (;;) {
      const next = timers.filter((t) => !t.cleared && t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      clock.now = Math.max(clock.now, next.due);
      if (next.every === null) next.cleared = true;
      else next.due += next.every;
      next.fn();
    }
    clock.now = until;
  };
  const buttons = () => screen.querySelectorAll('button').filter((b) => !b.hidden && !b.closest('[hidden]'));

  return {
    page,
    screen,
    keysPanel: page.document.getElementById('tv-keys'),
    asked,
    tab,
    device,
    sounds,
    sockets,
    socket,
    run,
    /** Lets every promise that can settle, settle. */
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)),
    advance,
    /** The card channel opens (the remembered television is connected). */
    open: () => socket().onopen!(),
    card: (queued: unknown) => receive({ kind: 'card', card: queued }),
    control: (control: unknown) => receive({ kind: 'control', control }),
    home: (home: Record<string, unknown>) => receive({ kind: 'control', control: { t: 'home', home, whole: true } }),
    /** What was sent on the card channel since it opened, without the times. */
    sent: () => socket().sent.map(({ at: _at, ...e }) => e),
    sentOf: (t: string) => socket().sent.filter((e) => e.t === t).map(({ at: _at, ...e }) => e),
    /** A key pressed and let go at once. */
    press: (name: string) => {
      key('keydown', name);
      key('keyup', name);
    },
    keyDown: (name: string, repeat = false) => key('keydown', name, repeat),
    keyUp: (name: string) => key('keyup', name),
    says: () => screen.all().map((n) => n.ownText).filter(Boolean),
    buttons: () => buttons().map((b) => b.textContent),
    focused: () => page.document.activeElement,
    video: () => screen.querySelector('video') as FakeVideo | null,
    /** The catalogue of films arrives, as the server would answer tv-catalog.json. */
    catalogue: async () => {
      const ask = asked.find((a) => a.url === 'tv-catalog.json')!;
      ask.answer(200, CATALOG);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

export const queued = (card: Record<string, unknown>, urgency = 'DEFERRED', over: Record<string, unknown> = {}) => ({
  id: card.id,
  urgency,
  queuedAt: 1,
  shownCount: 0,
  ...over,
  card: { householdId: 'hh-1', correlationId: 'c', createdAt: 1, actions: [], ...card },
});

export const NOTE = queued({ id: 'note-1', type: 'MESSAGE', fromName: 'Sarah', transcript: 'Did the parcel arrive?', suggestedReplies: ['Yes, it did.', 'Not yet.', 'Not right now.'] });
export const DOOR = (id = 'door-1') =>
  queued({ id, type: 'DOOR', line: "Someone's at the front door.", standIn: true, actions: [{ id: 'dismiss', label: 'Not now', kind: 'dismiss' }] }, 'DOOR', { expiresAt: 1_800_000_000_000 + 5 * 60_000 });
