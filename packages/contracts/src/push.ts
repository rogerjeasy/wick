/**
 * A nudge to a family member's own browser — Web Push — so that "Ask Sarah
 * to look" reaches Sarah when the family app is not open.
 *
 * What is sent is a kind and nothing else: no name, no household, no
 * picture, no sentence. The browser's service worker turns the kind into
 * words of its own (apps/sim-alexa/sw.js), and the facts are fetched by the
 * app afterwards, over the same gated tools as ever (INV-9). So neither a
 * push service nor a lock screen is ever told anything about the house.
 *
 * A subscription is one row per browser: `USER#<userId>` / `PUSH#<hash of
 * the endpoint>`, written by the Wick server (accounts/push.ts) and read by
 * the agent plane's egress.ts when there is someone to nudge.
 */
export const PUSH_SK_PREFIX = 'PUSH#';

/** Everything a nudge can be about. */
export const PUSH_KINDS = {
  /** The resident pressed "Ask … to look" on a door card. */
  doorLook: 'door_look',
  /** The resident pressed "Tell …" on a Tell card: there is something they chose to share. */
  told: 'told',
  /** The resident held the button and asked this person to ring (reach.ts). */
  reachRing: 'reach_ring',
  /** The resident held the button and chose "Just say hello". */
  reachHello: 'reach_hello',
  /** The door rang around when a visit the member arranged was expected (errand.ts). */
  errandRang: 'errand_rang',
  /** The window of a visit the member arranged passed with no ring. */
  errandNoShow: 'errand_no_show',
  /** The week (and its one suggestion) can be read: she has seen it first (INV-7). */
  weekReady: 'week_ready',
} as const;
export type PushKind = (typeof PUSH_KINDS)[keyof typeof PUSH_KINDS];

export const isPushKind = (kind: unknown): kind is PushKind =>
  typeof kind === 'string' && (Object.values(PUSH_KINDS) as string[]).includes(kind);

/** The browsers' own push services: a name, or any host under a suffix. */
const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com'];
const PUSH_SERVICE_SUFFIXES = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

/**
 * Whether an address is one of the browsers' push services, over https, on
 * the usual port and with no credentials in it.
 *
 * The address of a subscription comes from a browser, and Wick's own
 * functions later make a request to it from inside AWS. Unchecked, that is
 * a way to have them call anything at all. It is checked where it is
 * stored, and again where it is used.
 */
export function isPushServiceUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.includes(host) || PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
