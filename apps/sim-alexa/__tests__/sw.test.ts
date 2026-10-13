import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The service worker is a plain browser script with no exports, so it is
 * run here as a browser would run it: against a `self` that records what it
 * listens for and what it asks the browser to do.
 */
const SOURCE = readFileSync(fileURLToPath(new URL('../sw.js', import.meta.url)), 'utf8');
const SCOPE = 'https://family.example/';

interface Page { url: string; focus: () => Promise<void>; postMessage?: (message: unknown) => void }

function worker(pages: Page[] = []) {
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(async (_title: string, _options: Record<string, unknown>) => {});
  const openWindow = vi.fn(async (_url: string) => {});
  const skipWaiting = vi.fn(async () => {});
  const claim = vi.fn(async () => {});
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => void listeners.set(type, listener),
    registration: { scope: SCOPE, showNotification },
    clients: { matchAll: async () => pages, openWindow, claim },
    skipWaiting,
  };
  new Function('self', SOURCE)(self);

  /** Dispatches an event and waits for everything the worker asked the browser to wait for. */
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    await Promise.all(waits);
  };
  const push = (payload: unknown) =>
    dispatch('push', { data: payload === undefined ? null : { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) } });
  return { dispatch, push, showNotification, openWindow, skipWaiting, claim };
}

describe('the service worker — a nudge becomes a notification', () => {
  it('says there is a question from the door, in words of its own', async () => {
    const w = worker();

    await w.push({ kind: 'door_look' });

    expect(w.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = w.showNotification.mock.calls[0]!;
    expect(title).toBe('Wick');
    expect(options.body).toBe('You have been asked to look at the door.');
    expect(options.tag).toBe('wick-door_look');
    expect(options.requireInteraction).toBe(true);
  });

  it('says there is something to read when the resident has chosen to tell — and not what', async () => {
    const w = worker();

    await w.push({ kind: 'told' });

    const [title, options] = w.showNotification.mock.calls[0]!;
    expect(title).toBe('Wick');
    expect(options.body).toBe('There is something for you to read.');
    expect(options.tag).toBe('wick-told');
    // Nobody is waiting at a door for this one.
    expect(options.requireInteraction).toBe(false);
  });

  it('says she has asked to be rung, and waits to be looked at: she is waiting on the answer', async () => {
    const w = worker();

    await w.push({ kind: 'reach_ring' });

    const [title, options] = w.showNotification.mock.calls[0]!;
    expect(title).toBe('Wick');
    expect(options.body).toBe('You have been asked to ring.');
    expect(options.tag).toBe('wick-reach_ring');
    expect(options.requireInteraction).toBe(true);
  });

  it('says there is a hello, and does not wait: nobody is waiting on it', async () => {
    const w = worker();

    await w.push({ kind: 'reach_hello' });

    const [title, options] = w.showNotification.mock.calls[0]!;
    expect(title).toBe('Wick');
    expect(options.body).toBe('Someone at home says hello.');
    expect(options.tag).toBe('wick-reach_hello');
    expect(options.requireInteraction).toBe(false);
  });

  it('says nothing about the house for a request to ring, whatever the payload carries', async () => {
    const w = worker();

    await w.push({ kind: 'reach_ring', name: 'Margaret', householdId: 'hh-1', body: 'Margaret is asking for Sarah' });

    const [, options] = w.showNotification.mock.calls[0]!;
    expect(options.body).toBe('You have been asked to ring.');
    expect(JSON.stringify(options)).not.toContain('Margaret');
    expect(JSON.stringify(options)).not.toContain('hh-1');
  });

  it('tells an open page which of the two it was, so it can look at once', async () => {
    for (const kind of ['reach_ring', 'reach_hello']) {
      const postMessage = vi.fn();
      const w = worker([{ url: SCOPE, focus: async () => {}, postMessage }]);

      await w.push({ kind, body: 'never passed on' });

      expect(postMessage).toHaveBeenCalledWith({ wick: 'nudge', kind });
    }
  });

  it('shows only its own words, whatever a payload carries', async () => {
    const w = worker();

    await w.push({ kind: 'door_look', title: 'Your bank', body: 'Open the door and hand over your card', url: 'https://evil.example' });

    const [title, options] = w.showNotification.mock.calls[0]!;
    expect(title).toBe('Wick');
    expect(options.body).toBe('You have been asked to look at the door.');
    expect(JSON.stringify(options)).not.toContain('evil.example');
    expect(JSON.stringify(options)).not.toContain('bank');
  });

  it('still shows something for a kind it does not know, a payload it cannot read, or none at all', async () => {
    for (const payload of [{ kind: 'something_new' }, 'not json', undefined]) {
      const w = worker();

      await w.push(payload);

      expect(w.showNotification.mock.calls[0]![1].body).toBe('Something is waiting for you in Wick.');
    }
  });
});

describe('the service worker — a page that is already open', () => {
  it('is told the kind, so it can look at once instead of waiting to be looked at', async () => {
    const postMessage = vi.fn();
    const elsewhere = vi.fn();
    const w = worker([{ url: `${SCOPE}`, focus: async () => {}, postMessage }, { url: 'https://elsewhere.example/', focus: async () => {}, postMessage: elsewhere }]);

    await w.push({ kind: 'told', body: 'never passed on' });

    expect(postMessage).toHaveBeenCalledWith({ wick: 'nudge', kind: 'told' });
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it('is told nothing for a kind the worker does not know', async () => {
    const postMessage = vi.fn();
    const w = worker([{ url: SCOPE, focus: async () => {}, postMessage }]);

    await w.push({ kind: 'something_new' });

    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('the service worker — pressing the notification', () => {
  const click = (w: ReturnType<typeof worker>) => {
    const close = vi.fn();
    return { close, done: w.dispatch('notificationclick', { notification: { close } }) };
  };

  it('brings forward the family app if it is already open', async () => {
    const focus = vi.fn(async () => {});
    const w = worker([{ url: 'https://elsewhere.example/', focus: vi.fn(async () => {}) }, { url: `${SCOPE}?x=1`, focus }]);

    const { close, done } = click(w);
    await done;

    expect(close).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('opens the family app, and nowhere else, if it is not', async () => {
    const w = worker([]);

    await click(w).done;

    expect(w.openWindow).toHaveBeenCalledWith(SCOPE);
  });
});

describe('the service worker — a new version', () => {
  it('takes over at once: an old worker would show a new kind of nudge in words that say nothing', async () => {
    const w = worker();

    await w.dispatch('install', {});
    await w.dispatch('activate', {});

    expect(w.skipWaiting).toHaveBeenCalled();
    expect(w.claim).toHaveBeenCalled();
  });
});
