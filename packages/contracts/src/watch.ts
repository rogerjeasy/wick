/**
 * Watch together — a seat beside the resident.
 *
 * Someone in the family circle asks to watch one of Wick's films with the
 * resident at a day and a time. The resident says yes or no with one button.
 * At that time the family member takes their seat in the family app; the
 * resident presses "Start the film", and from that press the family
 * member's player follows the television's: it plays where she plays and
 * stops where she stops. She holds the remote. Nobody else can pause her
 * film, and there is no camera and no microphone anywhere in it. When the
 * credits begin each of them is asked one question, answered with a button.
 *
 * One row per invitation: `HH#<household>` / `WATCH#<sessionId>`, written
 * by the family's tools (services/mcp-server/src/tools/watchTogether.ts)
 * and by the television's presses and its player
 * (services/edge-device/lambda/watch-together.mjs).
 *
 * THE RULE (AGENTS.md, "Where a film has got to"). What the resident is
 * watching is hers. Where a film has got to leaves the television only:
 *
 *   - after her own press on "Start the film", on a card that says who will
 *     see it — the press is the consent, as it is for the family circle;
 *   - for the one film named in the invitation she accepted, never for
 *     anything else she plays;
 *   - for that one showing: until she leaves the film, and never past the
 *     invitation's own window (watchWindow);
 *   - and it is read back only to the one person who invited her.
 *
 * Each half is enforced where it can be: the television sends nothing
 * without the press (apps/tv-vega/src/watch/togetherReporter.ts), the edge
 * keeps nothing that does not match the row (watch-together.mjs), and the
 * tools answer nobody but the inviter (watchTogether.ts).
 */

export const WATCH_SK_PREFIX = 'WATCH#';

/** A session's id, as it appears in a sort key, a card id and a tool argument. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isWatchSessionId = (value: unknown): value is string => typeof value === 'string' && SESSION_ID.test(value);

/**
 * The four cards one session can put on the television, in the order they
 * come: the invitation; "… is ready to watch with you" when the family
 * member has sat down; the question at the credits; and what the family
 * member answered.
 */
export const WATCH_CARD_KINDS = ['invite', 'ready', 'question', 'answer'] as const;
export type WatchCardKind = (typeof WATCH_CARD_KINDS)[number];

/** Deterministic, like the Week card's: the press names the session without the television holding anything about it. */
export const watchCardId = (kind: WatchCardKind, sessionId: string): string => `watch-${kind}-${sessionId}`;

export function watchCardOf(cardId: string): { readonly kind: WatchCardKind; readonly sessionId: string } | undefined {
  const match = /^watch-([a-z]+)-(.+)$/.exec(cardId);
  if (!match) return undefined;
  const kind = WATCH_CARD_KINDS.find((k) => k === match[1]);
  return kind && isWatchSessionId(match[2]) ? { kind, sessionId: match[2] } : undefined;
}

/** What can be pressed on those cards. The question's buttons are the keys of WATCH_ANSWERS. */
export const WATCH_ACTIONS = {
  accept: 'accept',
  decline: 'decline',
  /** Opens the film, and from here the family member's player follows it. */
  start: 'start',
  notNow: 'not_now',
  ok: 'ok',
} as const;

/**
 * What either of them can answer when the film is over. Wick's own
 * sentences, chosen and never written, for the reason a note's replies are
 * (services/mcp-server/src/tools/send_note_to_tv.ts): what is pressed is
 * shown to the other person as what was said.
 */
export const WATCH_QUESTION = 'What did you think of it?';
export const WATCH_ANSWERS = {
  loved_it: 'I loved it.',
  all_right: 'It was all right.',
  not_for_me: 'Not really for me.',
} as const;
export type WatchAnswer = keyof typeof WATCH_ANSWERS;

export const isWatchAnswer = (key: unknown): key is WatchAnswer => typeof key === 'string' && Object.hasOwn(WATCH_ANSWERS, key);

/** The seat can be taken this long before the time asked for: people sit down early. */
export const WATCH_OPENS_BEFORE_MS = 30 * 60 * 1000;
/** And the session is over this long after it, whatever happened: long enough to start an hour late and still see the end. */
export const WATCH_OPEN_FOR_MS = 3 * 60 * 60 * 1000;

/** When a session asked for at `startsAt` can be sat down to, and when it is over. */
export const watchWindow = (startsAt: number): { readonly opensAt: number; readonly closesAt: number } => ({
  opensAt: startsAt - WATCH_OPENS_BEFORE_MS,
  closesAt: startsAt + WATCH_OPEN_FOR_MS,
});

/**
 * How often the television says where the film is while it plays
 * (togetherReporter.ts), and how long without a word before the family
 * member's player stops and waits rather than run on alone.
 */
export const WATCH_HEARTBEAT_MS = 5_000;
export const WATCH_SILENT_AFTER_MS = 20_000;
