/**
 * The family app's service worker. It does one thing: turn a nudge from
 * Wick into a notification, so that "Ask Sarah to look" reaches Sarah when
 * this page is closed.
 *
 * A nudge carries a kind and nothing else (packages/contracts push.ts). The
 * words below are this file's own: nothing a payload carries is ever shown
 * or opened, so whatever reached a push service, a lock screen says only
 * that there is something to look at. The picture and the sentence are read
 * by the page afterwards, over the same tools as always, as the person who
 * is signed in.
 *
 * Plain script, no imports: it is published as it is (infra/sim-alexa.tf).
 */
const WORDS = {
  door_look: 'You have been asked to look at the door.',
};
const OTHER = 'Something is waiting for you in Wick.';
/** Kinds that should stay on screen until someone looks: a person is waiting on the answer. */
const WAITS_FOR_YOU = ['door_look'];

// A new version of this file takes over at once, from every open page. Left
// to wait for the old one's pages to close, it could be days before a new
// kind of nudge was shown in its own words.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function kindOf(event) {
  try {
    const kind = event.data ? event.data.json().kind : undefined;
    return typeof kind === 'string' && Object.hasOwn(WORDS, kind) ? kind : undefined;
  } catch {
    return undefined;
  }
}

self.addEventListener('push', (event) => {
  const kind = kindOf(event);
  event.waitUntil(
    self.registration.showNotification('Wick', {
      body: kind ? WORDS[kind] : OTHER,
      // One notification per kind: a second nudge replaces the first, and says so.
      tag: `wick-${kind ?? 'other'}`,
      renotify: true,
      requireInteraction: kind !== undefined && WAITS_FOR_YOU.includes(kind),
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      // Only ever this app: the address is the worker's own scope, never one that was sent.
      const scope = self.registration.scope;
      const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = pages.find((page) => page.url.startsWith(scope));
      if (open) return open.focus();
      return self.clients.openWindow(scope);
    })(),
  );
});
