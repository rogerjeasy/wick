/**
 * The television speaks her language (packages/contracts language.ts): the
 * asking.
 *
 * The organiser asks, from the family app, for the resident's television to
 * use another language. That changes nothing. It puts a question beside the
 * household and one card on her television — in both languages at once,
 * because she may read only one of them — and the only thing that changes
 * the language is her own press on that card, on her own television (the
 * edge). Nothing in this file, and nothing in this server, can do it: the
 * same reasoning as INV-9, where nothing on the family side writes
 * `status: 'allowed'`.
 *
 * So what is kept here is a question, and three things can happen to it:
 * it is asked (one conditional update, then one card), it is replaced by a
 * question for another language (the old card is taken back first), or the
 * organiser takes it back. Every write is conditional on the household
 * being as it was read, so her answer and the organiser's second thoughts
 * can cross without either undoing the other.
 *
 * And her no is an answer. It is kept beside the household by her press
 * (the edge), never from here, and it stands for a week: the same language
 * is not put to her again sooner (LANGUAGE_ASK_AGAIN_AFTER_MS). The
 * organiser is told so, with the day it can be asked again; a question
 * taken back is not a no, and starts no wait.
 *
 * What the language changes is only what her television shows her. Every
 * row keeps the English it was written in, and every family tool reads what
 * it read before (language.ts) — so there is nothing here for a tool to
 * know, and none is told.
 */
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_ASK_AGAIN_AFTER_MS,
  LANGUAGE_NAMES,
  isHouseholdLanguage,
  languageCardId,
  languageQuestion,
  type HouseholdLanguage,
  type QueuedCard,
} from '@wick/contracts';
import { CircleError, accessOf, cleanName, requireOrganiser } from './circle.js';
import type { AccountStore } from './store.js';
import type { AskedLanguage, Household } from './types.js';

export interface LanguageDeps {
  readonly store: AccountStore;
  /** services/agent/src/egress.ts's sendToDevice — the only path to the television (INV-2). */
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  /** egress.ts's takeBackFromDevices — how a card its sender withdrew leaves the television (INV-2). */
  readonly withdrawCard: (householdId: string, cardId: string) => Promise<void>;
  readonly now: () => number;
  /** The households' IANA time zone: a day is named as it is at the house. Absent, the deployment's default. */
  readonly timeZone?: string | undefined;
}

/** The same default as server.ts and the tools: one zone for the deployment. */
const DEFAULT_TIME_ZONE = 'Europe/London';

/** Who is asking: the person and the household their access token names (INV-8). Never anything from a request. */
export interface LanguageActor {
  readonly householdId: string;
  readonly userId: string;
}

export type LanguageRefusalCode = 'bad_language' | 'already_speaks' | 'declined_lately' | 'no_television' | 'changed' | 'not_for_a_neighbour' | 'not_allowed_yet';

/** A refusal a person can be told as it stands, with the status the route answers. */
export class LanguageRefusal extends Error {
  readonly status: number;
  readonly code: LanguageRefusalCode;
  constructor(status: number, code: LanguageRefusalCode, message: string) {
    super(message);
    this.name = 'LanguageRefusal';
    this.status = status;
    this.code = code;
  }
}

export interface LanguageView {
  /** The language her television speaks now. */
  readonly language: HouseholdLanguage;
  /** A question still open on her television. */
  readonly asked?: AskedLanguage;
  /** What can be asked for, each named in English and in itself. */
  readonly choices: readonly { readonly language: HouseholdLanguage; readonly name: string; readonly own: string }[];
  /** Her no, while it stands — told to the organiser who asked, and to nobody else. */
  readonly declined?: StandingNo;
}

/** A language she said no to within the week, when it can be asked for again, and the sentence that says so. */
export interface StandingNo {
  readonly language: HouseholdLanguage;
  readonly at: number;
  readonly askAgainAt: number;
  readonly say: string;
}

/** What an asking or a taking back answers: how it stands now, and one sentence to say. */
export interface LanguageAnswer {
  readonly view: LanguageView;
  readonly say: string;
}

const CHOICES: LanguageView['choices'] = LANGUAGES.map((language) => ({
  language,
  name: LANGUAGE_NAMES[language].inEnglish,
  own: LANGUAGE_NAMES[language].own,
}));

/** "English and Spanish": every language Wick has, as a refusal names them. */
const EVERY_LANGUAGE = CHOICES.map((choice) => choice.name).join(' and ');

const spokenBy = (household: Household): HouseholdLanguage => household.language ?? DEFAULT_LANGUAGE;

/** A question is open only while it asks for something her television does not already speak. */
const openQuestion = (household: Household): AskedLanguage | undefined =>
  household.languageAsked && household.languageAsked.language !== spokenBy(household) ? household.languageAsked : undefined;

/** `declined` is given only for the organiser (standingNo): nobody else is told what she said no to. */
export function languageView(household: Household, declined?: StandingNo): LanguageView {
  const asked = openQuestion(household);
  return { language: spokenBy(household), ...(asked ? { asked } : {}), choices: CHOICES, ...(declined ? { declined } : {}) };
}

/** A day as it is at the house, worded as the server words dates elsewhere (tools/watchSession.ts): "Tuesday 20 October". */
const dayInWords = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(at)).replace(',', '');
const weekdayOf = (at: number, timeZone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(new Date(at));

/**
 * Her no, while it stands: the week is counted to the moment, and the day
 * it ends is named as it is at the house. On that day itself, before the
 * hour, it is said to be later today — never a day that has already come.
 * Undefined once the week has passed, and for a no to the language her
 * television has since come to speak.
 */
export function standingNo(household: Household, now: number, timeZone: string = DEFAULT_TIME_ZONE): StandingNo | undefined {
  const no = household.languageDeclined;
  if (!no || no.language === spokenBy(household)) return undefined;
  const askAgainAt = no.at + LANGUAGE_ASK_AGAIN_AFTER_MS;
  if (now >= askAgainAt) return undefined;
  const again = dayInWords(askAgainAt, timeZone) === dayInWords(now, timeZone) ? 'later today' : `from ${dayInWords(askAgainAt, timeZone)}`;
  return {
    language: no.language,
    at: no.at,
    askAgainAt,
    say: `${household.residentName} said no to ${LANGUAGE_NAMES[no.language].inEnglish} on ${weekdayOf(no.at, timeZone)}. You can ask again ${again}.`,
  };
}

/** The name the card says: the organiser's first name, as their membership has it. The contract fits it to the card. */
const firstNameOf = (name: string): string => cleanName(name).split(' ')[0] ?? '';

/**
 * The card she answers. Every word is the contract's (languageQuestion),
 * used as it is: this is the one card that never goes through the
 * phrasebook, because it is how she comes to have one. Its id names the
 * language, so her press does, without the television holding anything.
 */
export function buildLanguageCard(household: Household, question: AskedLanguage): QueuedCard {
  const id = languageCardId(question.language);
  return {
    id,
    // Like every question put to her: it waits for a natural break, and never arrives in the middle of a programme (INV-5).
    urgency: 'DEFERRED',
    queuedAt: question.at,
    shownCount: 0,
    card: {
      type: 'LANGUAGE',
      id,
      householdId: household.householdId,
      correlationId: id,
      createdAt: question.at,
      language: question.language,
      ...languageQuestion(question.language, question.by),
    },
  };
}

/** The household as it is this moment: a question is decided on what her press left, not on a read a second old. */
async function householdNow(deps: Pick<LanguageDeps, 'store'>, actor: LanguageActor): Promise<Household> {
  const household = await deps.store.getHousehold(actor.householdId, { consistent: true });
  if (!household) throw new CircleError('not_a_member');
  return household;
}

/**
 * Which language her television speaks, a question still open on it, and
 * what can be asked for. For the organiser and the family she allows
 * (INV-9) — and for an organiser still waiting, who has to be able to see
 * whether their question took, as they see the television connect. Not for
 * a neighbour, who is asked two things and shown nothing.
 */
export async function readLanguage(deps: Pick<LanguageDeps, 'store' | 'now' | 'timeZone'>, actor: LanguageActor): Promise<LanguageView> {
  const [membership, household] = await Promise.all([
    deps.store.getMembership(actor.householdId, actor.userId),
    deps.store.getHousehold(actor.householdId, { consistent: true }),
  ]);
  // Said first, so a neighbour still waiting is not told that being allowed would change it.
  if (membership?.role === 'neighbour') {
    throw new LanguageRefusal(403, 'not_for_a_neighbour', 'The language of the television is not shown to a neighbour.');
  }
  const access = accessOf(membership, household);
  const organiserWaiting = membership?.role === 'organiser' && membership.status === 'pending';
  if (!access.ok && !(organiserWaiting && household)) throw new LanguageRefusal(403, 'not_allowed_yet', access.say);
  // Her no was an answer to the organiser's question, and is told to the organiser: the rest of the family see the language.
  return languageView(household!, membership?.role === 'organiser' ? standingNo(household!, deps.now(), deps.timeZone) : undefined);
}

/**
 * Ask her. The organiser's alone — allowed, or still waiting: a home whose
 * resident reads no English needs this before she can read the card that
 * would allow anyone.
 *
 * The question is written before the card is sent, under a condition, so
 * two requests are one question and her press always finds the question it
 * answers; and if the card cannot be sent the question is taken off again,
 * so nobody is told she was asked when she was not.
 */
export async function askForLanguage(deps: LanguageDeps, actor: LanguageActor, wanted: unknown): Promise<LanguageAnswer> {
  const membership = await requireOrganiser(deps, actor);
  if (!isHouseholdLanguage(wanted)) {
    throw new LanguageRefusal(400, 'bad_language', `Wick does not have that language yet. It has ${EVERY_LANGUAGE}.`);
  }
  const household = await householdNow(deps, actor);
  const resident = household.residentName;
  if (wanted === spokenBy(household)) {
    throw new LanguageRefusal(409, 'already_speaks', `${resident}’s television already speaks ${LANGUAGE_NAMES[wanted].inEnglish}.`);
  }
  // Her no is an answer, and it stands: the same language is not put to her again inside the week.
  const no = standingNo(household, deps.now(), deps.timeZone);
  if (no?.language === wanted) throw new LanguageRefusal(409, 'declined_lately', no.say);
  // Nothing could ask her: a question with no television to show it would wait for ever, and say it had been asked.
  if ((await deps.store.listTelevisions(actor.householdId)).length === 0) {
    throw new LanguageRefusal(409, 'no_television', `Connect ${resident}’s television first. She is asked on it, and there is nowhere to ask her yet.`);
  }

  // What is beside the household now, open or left over: the write replaces exactly that, or nothing.
  const before = household.languageAsked;
  if (before?.language === wanted) {
    return {
      view: languageView(household, no),
      say: `That question is still on ${resident}’s television. Nothing changes until she says yes.`,
    };
  }

  const question: AskedLanguage = { language: wanted, by: firstNameOf(membership.name), at: deps.now() };
  if (!(await deps.store.askLanguage(actor.householdId, question, before?.language))) {
    // Her answer — a no among them — or another request got there between the read and the write.
    throw new LanguageRefusal(409, 'changed', `Something changed on ${resident}’s television just then. Look again before asking.`);
  }

  try {
    // She never has two of these at once: the one this replaces leaves before the new one arrives.
    if (before) await deps.withdrawCard(actor.householdId, languageCardId(before.language));
    await deps.sendCard(buildLanguageCard(household, question));
  } catch (err) {
    // Undone only while the question is still this one.
    await deps.store
      .clearLanguageQuestion(actor.householdId, question)
      .catch((undo: unknown) => console.error(JSON.stringify({ level: 'error', msg: 'language_question_not_undone', err: undo instanceof Error ? undo.name : 'unknown' })));
    throw err;
  }

  return {
    view: languageView({ ...household, languageAsked: question }, no),
    say: `I have asked ${resident} on her television. Nothing changes until she says yes.`,
  };
}

/**
 * The organiser takes the question back. The card leaves her television
 * first and the question is closed after, so a failure between the two
 * leaves a question that can be taken back again — never a card on her
 * television that nothing is waiting for. Doing it twice does nothing the
 * second time.
 */
export async function takeBackLanguageQuestion(deps: LanguageDeps, actor: LanguageActor): Promise<LanguageAnswer> {
  await requireOrganiser(deps, actor);
  const household = await householdNow(deps, actor);
  const resident = household.residentName;
  const asked = household.languageAsked;
  // Whatever is answered here says her no too, while it stands: the organiser's card goes on showing it.
  const viewOf = (home: Household): LanguageView => languageView(home, standingNo(home, deps.now(), deps.timeZone));
  if (!asked) return { view: viewOf(household), say: `There is no question on ${resident}’s television to take back.` };

  await deps.withdrawCard(actor.householdId, languageCardId(asked.language));
  if (await deps.store.clearLanguageQuestion(actor.householdId, asked)) {
    const { languageAsked: _taken, ...rest } = household;
    return {
      view: viewOf(rest),
      say: `I have taken the question back. ${resident}’s television still speaks ${LANGUAGE_NAMES[spokenBy(rest)].inEnglish}.`,
    };
  }

  // No longer the question that was read. What stands now is read again, and said as it is.
  const now = await householdNow(deps, actor);
  const speaks = LANGUAGE_NAMES[spokenBy(now)].inEnglish;
  const saidNo = now.languageDeclined?.language === asked.language && now.languageDeclined.at >= asked.at;
  const say = openQuestion(now)
    ? `Another question is on ${resident}’s television now. It can be taken back as well.`
    : spokenBy(now) !== spokenBy(household) || saidNo
      ? // Only her press changes the language, or leaves a no: she answered a moment before, and that stands.
        `${resident} had already answered. Her television speaks ${speaks}.`
      : `There is no question on ${resident}’s television to take back.`;
  return { view: viewOf(now), say };
}
