/**
 * The family app's service worker. It does one thing: turn a nudge from
 * Wick into a notification, so that "Ask Sarah to look" — and "Ask Sarah
 * to ring you" — reach Sarah when this page is closed.
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
  // The resident chose to tell the family something. What it is stays in Wick.
  told: 'There is something for you to read.',
  // The resident held the button on the remote and asked this person to ring. Not who, and never why.
  reach_ring: 'You have been asked to ring.',
  // The same button, and "Just say hello".
  reach_hello: 'Someone at home says hello.',
  // A visit the member arranged has an answer: the door rang around then, or nobody came. Which, and who, stays in Wick.
  errand_rang: 'There is news about a visit you arranged.',
  errand_no_show: 'There is news about a visit you arranged.',
  // She has read her week on her television, so the family may now (INV-7). Not what it says.
  week_ready: 'The week is ready for you to read.',
};
const OTHER = 'Something is waiting for you in Wick.';
/** Kinds that should stay on screen until someone looks: a person is waiting on the answer. A hello waits on nothing. */
const WAITS_FOR_YOU = ['door_look', 'reach_ring'];

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

/** This app's own pages that are open now. */
async function openPages() {
  const scope = self.registration.scope;
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return pages.filter((page) => page.url.startsWith(scope));
}

self.addEventListener('push', (event) => {
  const kind = kindOf(event);
  event.waitUntil(
    Promise.all([
      self.registration.showNotification('Wick', {
        body: kind ? WORDS[kind] : OTHER,
        // One notification per kind: a second nudge replaces the first, and says so.
        tag: `wick-${kind ?? 'other'}`,
        renotify: true,
        requireInteraction: kind !== undefined && WAITS_FOR_YOU.includes(kind),
      }),
      // A page that is already open looks at once (main.js). It is told the
      // kind and nothing else, like the worker itself.
      kind ? openPages().then((pages) => pages.forEach((page) => page.postMessage({ wick: 'nudge', kind }))) : undefined,
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      // Only ever this app: the address is the worker's own scope, never one that was sent.
      const [open] = await openPages();
      if (open) return open.focus();
      return self.clients.openWindow(self.registration.scope);
    })(),
  );
});
