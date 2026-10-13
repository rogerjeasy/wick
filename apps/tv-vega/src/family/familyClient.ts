/**
 * Everything a family member's own television says to the Wick server, and
 * everything it hears back (packages/contracts/src/familyTelevision.ts).
 * Pure and RN-import-free, like live/liveClient.ts.
 *
 *   GET  <server>/tv/home     what this one member may see, and what is waiting for them
 *   POST <server>/tv/press    { cardId, action } — their press on one of those cards
 *   GET  <server>/tv/seat     the seat beside her film, while this member is sat at it
 *   GET  <server>/tv/waiting  a sentence for each thing that waits — asked by the
 *                             background service while the app is off the screen
 *
 * All carry `Authorization: Bearer <the device token>` and nothing else
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
import { FAMILY_TV_WAVE_CARD, type CardAction, type FamilyTvCard, type FamilyTvHome, type FamilyTvPress, type FamilyTvSeat, type FamilyTvWaiting, type FamilyTvWave } from '@wick/contracts';

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

export type SeatAnswer =
  /** The seat as it stands — or none: there is no film, or it is over, or it is not this member's to sit at. */
  | { readonly kind: 'seat'; readonly seat?: FamilyTvSeat }
  | { readonly kind: 'notAllowed'; readonly say: string }
  | { readonly kind: 'signedOut' }
  | { readonly kind: 'failed' };

export type WaitingAnswer =
  | { readonly kind: 'waiting'; readonly waiting: FamilyTvWaiting['waiting'] }
  /** The token is refused and a fresh one cannot be had: whoever asks stops asking. */
  | { readonly kind: 'signedOut' }
  | { readonly kind: 'failed' };

export interface FamilyClient {
  home(): Promise<HomeAnswer>;
  press(press: FamilyTvPress): Promise<PressAnswer>;
  seat(): Promise<SeatAnswer>;
  waiting(): Promise<WaitingAnswer>;
  /**
   * A fresh token now, before the one in hand is refused — for a token that
   * cannot be brought back once it has run out (the background service's).
   * 'signedOut': there is none to be had, for good. 'later': it could not be asked.
   */
  renewNow(): Promise<'renewed' | 'signedOut' | 'later'>;
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
/** More pages than this is not something to read with a remote: the card is left out. */
export const MAX_PAGES = 12;

function readAction(value: unknown): CardAction | undefined {
  if (!record(value) || !text(value.id) || !text(value.label)) return undefined;
  const kind = ACTION_KINDS.find((k) => k === value.kind) ?? 'secondary';
  return { id: value.id, label: value.label, kind };
}

/** A list of at most three whole actions, or undefined. */
function readActions(value: unknown): CardAction[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) return undefined;
  const actions = value.map(readAction);
  return actions.some((a) => a === undefined) ? undefined : (actions as CardAction[]);
}

/**
 * Something to read, a page at a time: every page words, and not too many.
 * 'none' for a card that brings none; undefined when what it brought is not
 * that — and then the card is not shown, rather than shown with half of it.
 */
function readPages(value: unknown): readonly string[] | 'none' | undefined {
  if (value === undefined || value === null) return 'none';
  if (!Array.isArray(value) || value.length > MAX_PAGES || !value.every(text)) return undefined;
  return value.length === 0 ? 'none' : (value as string[]);
}

function readCard(value: unknown): FamilyTvCard | undefined {
  if (!record(value) || !text(value.id) || !text(value.kind) || !text(value.headline)) return undefined;
  const actions = readActions(value.actions);
  const pages = readPages(value.pages);
  if (!actions || !pages) return undefined;
  return {
    id: value.id,
    kind: value.kind as FamilyTvCard['kind'],
    headline: value.headline,
    ...(text(value.detail) ? { detail: value.detail } : {}),
    ...(text(value.pictureUrl) ? { pictureUrl: value.pictureUrl } : {}),
    ...(pages === 'none' ? {} : { pages }),
    actions,
  };
}

/**
 * The wave: its words, and — only while one can be sent — the one card it is
 * pressed on. Any other card named there is not taken: a press on the wave
 * must never be able to answer something else.
 */
function readWave(value: unknown): FamilyTvWave | undefined {
  if (!record(value) || !text(value.label)) return undefined;
  return {
    label: value.label,
    ...(value.cardId === FAMILY_TV_WAVE_CARD ? { cardId: FAMILY_TV_WAVE_CARD } : {}),
    ...(text(value.line) ? { line: value.line } : {}),
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
  const wave = readWave(body.wave);
  return {
    residentName: body.residentName,
    memberName: body.memberName,
    ...(light ? { light } : {}),
    cards: body.cards.map(readCard).filter((card): card is FamilyTvCard => card !== undefined),
    ...(wave ? { wave } : {}),
    ...(body.simulated === true ? { simulated: true as const } : {}),
  };
}

const SEAT_STATES: readonly FamilyTvSeat['state'][] = ['waiting', 'watching', 'asked', 'over'];
const PLAYBACK_STATES: readonly NonNullable<FamilyTvSeat['playback']>['state'][] = ['PLAYING', 'PAUSED', 'STOPPED', 'WAITING'];
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The seat beside her film, with only what the contract names — or
 * undefined when it is not one. A film is played only from an https
 * address (this player drops anything else without a word, FL-016), and
 * followed only by a place in it that can be read; without either, the seat
 * still says its sentence.
 */
export function readSeat(value: unknown): FamilyTvSeat | undefined {
  if (!record(value) || !text(value.cardId) || !text(value.film) || !text(value.line)) return undefined;
  const state = SEAT_STATES.find((s) => s === value.state);
  if (!state) return undefined;
  const { stream, playback } = value;
  const playbackState = record(playback) ? PLAYBACK_STATES.find((s) => s === playback.state) : undefined;
  const answers = readActions(value.answers);
  return {
    cardId: value.cardId,
    film: value.film,
    state,
    line: value.line,
    ...(record(stream) && text(stream.url) && /^https:\/\/[^\s"'<>]+$/.test(stream.url)
      ? { stream: { url: stream.url, durationMs: number(stream.durationMs) ? stream.durationMs : 0, attribution: text(stream.attribution) ? stream.attribution : '' } }
      : {}),
    ...(record(playback) && playbackState && number(playback.positionMs) && number(playback.ageMs)
      ? { playback: { state: playbackState, positionMs: playback.positionMs, ageMs: playback.ageMs } }
      : {}),
    ...(text(value.question) ? { question: value.question } : {}),
    ...(answers && answers.length > 0 ? { answers } : {}),
    ...(text(value.yourAnswer) ? { yourAnswer: value.yourAnswer } : {}),
    ...(text(value.theirAnswer) ? { theirAnswer: value.theirAnswer } : {}),
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

  /**
   * One renewal at a time, and never for longer than any other request
   * here: the pairing service is asked with no time limit of its own, and
   * a request that never answered would hold up every ask after it. Out of
   * time is only "not now".
   */
  function renewOnce(heldJwt: string): Promise<Renewed> {
    if (renewing) return renewing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooLong = new Promise<Renewed>((resolve) => {
      timer = setTimeout(() => resolve('try_later'), timeoutMs);
    });
    const renewed = (async (): Promise<Renewed> => {
      try {
        return await args.renew(heldJwt);
      } catch {
        return 'try_later';
      }
    })();
    renewing = Promise.race([renewed, tooLong]).finally(() => {
      clearTimeout(timer);
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

    async seat(): Promise<SeatAnswer> {
      const heard = await asked('/tv/seat', 'GET');
      if (heard === 'signedOut') return { kind: 'signedOut' };
      if (heard === 'nothing') return { kind: 'failed' };
      if (heard.status === 403) return notAllowed(heard.body);
      const body = heard.body;
      if (heard.status !== 200 || !record(body)) return { kind: 'failed' };
      if (body.seat === undefined || body.seat === null) return { kind: 'seat' };
      const seat = readSeat(body.seat);
      return seat ? { kind: 'seat', seat } : { kind: 'failed' };
    },

    async renewNow(): Promise<'renewed' | 'signedOut' | 'later'> {
      const renewed = await renewOnce(jwt);
      if (renewed === 'not_connected') return 'signedOut';
      if (renewed === 'try_later') return 'later';
      jwt = renewed.jwt;
      return 'renewed';
    },

    async waiting(): Promise<WaitingAnswer> {
      const heard = await asked('/tv/waiting', 'GET');
      if (heard === 'signedOut') return { kind: 'signedOut' };
      const body = heard === 'nothing' ? undefined : heard.body;
      if (heard === 'nothing' || heard.status !== 200 || !record(body) || !Array.isArray(body.waiting)) return { kind: 'failed' };
      return {
        kind: 'waiting',
        waiting: body.waiting.flatMap((one: unknown) => (record(one) && text(one.id) && text(one.line) ? [{ id: one.id, line: one.line }] : [])),
      };
    },
  };
}
