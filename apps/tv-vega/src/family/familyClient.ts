/**
 * Everything a family member's own television says to the Wick server, and
 * everything it hears back (packages/contracts/src/familyTelevision.ts).
 * Pure and RN-import-free, like live/liveClient.ts.
 *
 *   GET  <server>/tv/home    what this one member may see, and what is waiting for them
 *   POST <server>/tv/press   { cardId, action } — their press on one of those cards
 *
 * Both carry `Authorization: Bearer <the device token>` and nothing else
 * that says who is asking: the household and the member are the ones in
 * that token (INV-8), and the server checks the circle again on every call
 * (INV-9). The television renders and never decides.
 *
 * It holds nothing but that one device-bound token (INV-1). When the server
 * no longer takes it (401) the television asks once for a fresh one, the
 * way it does at launch (`renew`, pairing/PairingFlow.ts) — a refreshed
 * token lasts an hour, and this television may be on screen for longer. It
 * hands over the token that was just refused: the pairing service mints a
 * family television's token only for one that shows the token it held, and
 * where the disk keeps nothing this is the only copy. If there is none to
 * be had because it is no longer connected, or the fresh one is refused
 * too, it is signed out — and that is final: nothing asks a third time.
 *
 * Every other failure is only a look that failed: nothing here throws.
 */
import type { CardAction, FamilyTvCard, FamilyTvHome, FamilyTvPress } from '@wick/contracts';

/** Under the eight seconds between looks (FAMILY_TV_LOOK_EVERY_MS): a look that hangs is over before the next is due. */
export const FAMILY_REQUEST_TIMEOUT_MS = 6000;

/**
 * Shown when the server refuses this member (403) without the sentence it
 * is meant to send. The home goes from the screen all the same.
 */
export const NOT_ALLOWED_FALLBACK = 'There is nothing Wick can show on this television just now.';

export type HomeAnswer =
  | { readonly kind: 'home'; readonly home: FamilyTvHome }
  /** The resident has not allowed this member, or no longer does. The sentence is shown as it stands. */
  | { readonly kind: 'notAllowed'; readonly say: string }
  /** This television is no longer connected. */
  | { readonly kind: 'signedOut' }
  | { readonly kind: 'failed' };

export type PressAnswer =
  /** The server's answer, done or not: one sentence to show. */
  | { readonly kind: 'said'; readonly done: boolean; readonly say: string }
  | { readonly kind: 'notAllowed'; readonly say: string }
  | { readonly kind: 'signedOut' }
  | { readonly kind: 'failed' };

/** What asking for a fresh token came to (PairingFlow.renew, narrowed to a family television's). */
export type Renewed = { readonly jwt: string } | 'not_connected' | 'try_later';

export interface FamilyClient {
  home(): Promise<HomeAnswer>;
  press(press: FamilyTvPress): Promise<PressAnswer>;
}

export interface FamilyClientArgs {
  /** The Wick server's origin (config.ts `wickServerUrl`). */
  readonly serverUrl: string;
  /** The device token this television was paired with. */
  readonly jwt: string;
  /** Given the token that was just refused, which is the proof a fresh one is minted on. */
  readonly renew: (heldJwt: string) => Promise<Renewed>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

type Heard = { readonly status: number; readonly body: unknown } | 'nothing';

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const ACTION_KINDS: readonly CardAction['kind'][] = ['primary', 'secondary', 'dismiss'];
const MAX_ACTIONS = 3;

function readAction(value: unknown): CardAction | undefined {
  if (!record(value) || !text(value.id) || !text(value.label)) return undefined;
  const kind = ACTION_KINDS.find((k) => k === value.kind) ?? 'secondary';
  return { id: value.id, label: value.label, kind };
}

function readCard(value: unknown): FamilyTvCard | undefined {
  if (!record(value) || !text(value.id) || !text(value.kind) || !text(value.headline)) return undefined;
  if (!Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS) return undefined;
  const actions = value.actions.map(readAction);
  if (actions.some((a) => a === undefined)) return undefined;
  return {
    id: value.id,
    kind: value.kind as FamilyTvCard['kind'],
    headline: value.headline,
    ...(text(value.detail) ? { detail: value.detail } : {}),
    ...(text(value.pictureUrl) ? { pictureUrl: value.pictureUrl } : {}),
    actions: actions as CardAction[],
  };
}

/**
 * The home the server wrote, with only what the contract names — or
 * undefined when it is not one. A card that is not whole, or that has more
 * than three actions, is left out: the screen's floor throws on a fourth
 * button (vega-calm-ui), and a television that stops is worse than a card
 * not shown.
 */
export function readHome(body: unknown): FamilyTvHome | undefined {
  if (!record(body) || !text(body.residentName) || !text(body.memberName) || !Array.isArray(body.cards)) return undefined;
  const light = record(body.light) && text(body.light.line) && typeof body.light.lit === 'boolean' ? { lit: body.light.lit, line: body.light.line } : undefined;
  return {
    residentName: body.residentName,
    memberName: body.memberName,
    ...(light ? { light } : {}),
    cards: body.cards.map(readCard).filter((card): card is FamilyTvCard => card !== undefined),
    ...(body.simulated === true ? { simulated: true as const } : {}),
  };
}

const notAllowed = (body: unknown): { readonly kind: 'notAllowed'; readonly say: string } => ({
  kind: 'notAllowed',
  say: record(body) && text(body.say) ? body.say : NOT_ALLOWED_FALLBACK,
});

export function createFamilyClient(args: FamilyClientArgs): FamilyClient {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? FAMILY_REQUEST_TIMEOUT_MS;
  let jwt = args.jwt;
  /** One request for a fresh token at a time: the server allows a television one in thirty seconds. */
  let renewing: Promise<Renewed> | undefined;

  /** One request, over when it answers or when its time is up — whichever comes first. */
  async function ask(path: string, method: 'GET' | 'POST', withJwt: string, body?: unknown): Promise<Heard> {
    // React Native has AbortController on both televisions; the timer below holds even where it is missing.
    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooLong = new Promise<'nothing'>((resolve) => {
      timer = setTimeout(() => {
        controller?.abort();
        resolve('nothing');
      }, timeoutMs);
    });
    const heard = (async (): Promise<Heard> => {
      try {
        const res = await fetchImpl(`${args.serverUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${withJwt}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(controller ? { signal: controller.signal } : {}),
        });
        return { status: res.status, body: await res.json().catch(() => undefined) };
      } catch {
        return 'nothing';
      }
    })();
    try {
      return await Promise.race([heard, tooLong]);
    } finally {
      clearTimeout(timer);
    }
  }

  function renewOnce(heldJwt: string): Promise<Renewed> {
    renewing ??= args
      .renew(heldJwt)
      .catch((): Renewed => 'try_later')
      .finally(() => {
        renewing = undefined;
      });
    return renewing;
  }

  /** Asks; and when the token is refused, asks once more with a fresh one. */
  async function asked(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Heard | 'signedOut'> {
    const used = jwt;
    const first = await ask(path, method, used, body);
    if (first === 'nothing' || first.status !== 401) return first;

    // Another request may have brought a fresh token while this one was out.
    if (jwt === used) {
      const renewed = await renewOnce(used);
      if (renewed === 'not_connected') return 'signedOut';
      if (renewed === 'try_later') return 'nothing';
      jwt = renewed.jwt;
    }
    const second = await ask(path, method, jwt, body);
    return second !== 'nothing' && second.status === 401 ? 'signedOut' : second;
  }

  return {
    async home(): Promise<HomeAnswer> {
      const heard = await asked('/tv/home', 'GET');
      if (heard === 'signedOut') return { kind: 'signedOut' };
      if (heard === 'nothing') return { kind: 'failed' };
      if (heard.status === 403) return notAllowed(heard.body);
      const home = heard.status === 200 ? readHome(heard.body) : undefined;
      return home ? { kind: 'home', home } : { kind: 'failed' };
    },

    async press(press: FamilyTvPress): Promise<PressAnswer> {
      const heard = await asked('/tv/press', 'POST', { cardId: press.cardId, action: press.action });
      if (heard === 'signedOut') return { kind: 'signedOut' };
      if (heard === 'nothing') return { kind: 'failed' };
      if (heard.status === 403) return notAllowed(heard.body);
      const body = heard.body;
      if (heard.status === 200 && record(body) && text(body.say)) return { kind: 'said', done: body.done === true, say: body.say };
      return { kind: 'failed' };
    },
  };
}
