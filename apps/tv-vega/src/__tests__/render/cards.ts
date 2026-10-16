/**
 * One card of every kind the television draws, as the server writes it —
 * for render tests only.
 *
 * Where the contract has the builder the server uses (the Reach offer, the
 * visit, the question about her language, a picture's words) the card is
 * made with it; the rest carry, word for word, what their producers write
 * (services/agent, services/mcp-server, services/edge-device), so the
 * sizes, lengths and button counts the tests see are the real ones.
 *
 * Each also comes in Spanish the way her television receives it: through
 * the phrasebook (`cardIn`), with the free text — a note, the door's
 * description, the week's paragraph — in the hand-written Spanish a
 * translator would hand back.
 */
import {
  CIRCLE_ACTIONS,
  DOOR_ACTIONS,
  LANGUAGE_ACTIONS,
  LIGHT_ACTIONS,
  MANTEL_FULL_NOTICE,
  PHOTO_ACTIONS,
  REACH_ACTIONS,
  SHARING_ACTIONS,
  TELL_ACTIONS,
  VISIT_ACTIONS,
  WATCH_ACTIONS,
  WEEK_ACTIONS,
  buildReachAskCard,
  buildVisitCard,
  cardIn,
  languageQuestion,
  photoCardWords,
  type Card,
  type FreeText,
  type PhotoCard,
} from '@wick/contracts';

const HOUSEHOLD = 'hh_test';
/** Tuesday 13 October 2026, 9:02 in London. */
const NOW = Date.UTC(2026, 9, 13, 8, 2);
const base = (id: string) => ({ id, householdId: HOUSEHOLD, correlationId: id, createdAt: NOW });

export interface CardCase {
  /** What a test calls it. */
  readonly name: string;
  readonly card: Card;
  /** The same card as her television receives it in Spanish. */
  readonly spanish: Card;
  /** Words that are on the Spanish card and not on the English one: the server's, or the television's own. */
  readonly spanishWords: string;
  /** A press the test makes, and the id it must send back. */
  readonly press: { readonly label: string; readonly id: string };
}

const inSpanish = (card: Card, free?: FreeText): Card => cardIn('es', card, free);

const doorPhaseOne: Card = {
  type: 'DOOR',
  ...base('door-evt-1'),
  line: "Someone's at the front door.",
  actions: [
    { id: DOOR_ACTIONS.watchLive, label: 'Watch live', kind: 'primary' },
    { id: DOOR_ACTIONS.hallwayChime, label: 'Ring the hallway chime', kind: 'secondary' },
    { id: DOOR_ACTIONS.dismiss, label: 'Not now', kind: 'dismiss' },
  ],
};

const doorWhole: Card = {
  ...doorPhaseOne,
  id: 'door-evt-2',
  imageRef: 'https://frames.example.com/door-evt-2.jpg',
  description: 'A woman in a blue coat holding a bag of shopping.',
  actions: [
    { id: DOOR_ACTIONS.watchLive, label: 'Watch live', kind: 'primary' },
    { id: DOOR_ACTIONS.askFamily, label: 'Ask Sarah to look', kind: 'secondary' },
    { id: DOOR_ACTIONS.dismiss, label: 'Not now', kind: 'dismiss' },
  ],
};

const doorExpected: Card = {
  ...doorPhaseOne,
  id: 'door-evt-3',
  match: { personId: 'p_maria', name: 'Maria', basis: 'schedule', expectedToday: true, confidence: 0.8 },
  notice: 'The hallway chime rang.',
  actions: [
    { id: DOOR_ACTIONS.watchLive, label: 'Watch live', kind: 'primary' },
    { id: DOOR_ACTIONS.dismiss, label: 'Not now', kind: 'dismiss' },
  ],
};

/** A visitor the family arranged (contracts errand.ts): the door says who it looks like, and who arranged it. */
const doorArranged: Card = {
  ...doorPhaseOne,
  id: 'door-evt-4',
  match: { personId: 'errand:err_AAAAAAAAAAAAAAAAAAAA', name: 'the plumber', basis: 'schedule', expectedToday: true, confidence: 0.5 },
  notice: 'Sarah arranged this visit.',
  actions: [
    { id: DOOR_ACTIONS.watchLive, label: 'Watch live', kind: 'primary' },
    { id: DOOR_ACTIONS.dismiss, label: 'Not now', kind: 'dismiss' },
  ],
};

const note: Card = {
  type: 'MESSAGE',
  ...base('note-1'),
  fromName: 'Sarah',
  transcript: 'I will pop round on Saturday with the grandchildren. Shall I bring lunch?',
  suggestedReplies: ['Yes, please do.', 'Another day would be better.', 'No, thank you.'],
  actions: [],
};

const week: Card = {
  type: 'WEEK',
  ...base('week-2026-W41'),
  isoWeek: '2026-W41',
  text: 'Maria came on Tuesday and Thursday mornings, as usual. Sarah sent two notes. You watched Sintel on Sunday evening.',
  actions: [
    { id: WEEK_ACTIONS.seen, label: 'OK', kind: 'primary' },
    { id: WEEK_ACTIONS.sharing, label: 'What Sarah sees', kind: 'secondary' },
  ],
};

const sharing: Card = {
  type: 'SHARING',
  ...base('sharing'),
  factClass: 'DOOR_EVENT',
  page: 0,
  pages: 4,
  headline: 'When someone comes to your front door.',
  detail: '1 of 4. Sarah can see this. Never shared, whatever you choose: your health, money, relationships, where you go, or your words.',
  actions: [
    { id: SHARING_ACTIONS.toggle, label: 'Keep this private', kind: 'primary' },
    { id: SHARING_ACTIONS.next, label: 'Next', kind: 'secondary' },
    { id: SHARING_ACTIONS.done, label: 'Done', kind: 'secondary' },
  ],
};

const circle: Card = {
  type: 'CIRCLE',
  ...base('circle-u_tom'),
  personName: 'Tom Hughes',
  role: 'family',
  headline: 'Tom Hughes would like to join your family circle.',
  detail: 'If you allow it, Tom can send you notes here and see what you choose to share. You can change what is shared at any time.',
  actions: [
    { id: CIRCLE_ACTIONS.allow, label: 'Allow Tom', kind: 'primary' },
    { id: CIRCLE_ACTIONS.decline, label: 'No, thank you', kind: 'secondary' },
  ],
};

const tell: Card = {
  type: 'TELL',
  ...base('tell-d_1'),
  headline: 'Shall I tell Sarah?',
  detail: 'There was no visit on Tuesday.',
  actions: [
    { id: TELL_ACTIONS.tell, label: 'Tell Sarah', kind: 'primary' },
    { id: TELL_ACTIONS.keep, label: 'Keep it to myself', kind: 'dismiss' },
  ],
};

const watch: Card = {
  type: 'WATCH',
  ...base('watch-ready-s_1'),
  sessionId: 's_1',
  withName: 'Sarah',
  programmeId: 'sintel',
  followedUntil: NOW + 30 * 60 * 1000,
  headline: 'Sarah is ready to watch Sintel with you.',
  detail: 'From when you start it, Sarah sees the film as you play it: where you pause, it pauses for Sarah too.',
  actions: [
    { id: WATCH_ACTIONS.start, label: 'Start the film', kind: 'primary' },
    { id: WATCH_ACTIONS.notNow, label: 'Not now', kind: 'dismiss' },
  ],
};

const light: Card = {
  type: 'LIGHT',
  ...base('light'),
  headline: 'Your light is on.',
  detail: 'Sarah can see that your day has begun, and nothing more: not when, and not what you watch.',
  actions: [
    { id: LIGHT_ACTIONS.ok, label: 'Leave it on', kind: 'primary' },
    { id: LIGHT_ACTIONS.putOut, label: 'Put it out for today', kind: 'secondary' },
  ],
};

const reach = buildReachAskCard({ householdId: HOUSEHOLD, reachId: 'r_1', first: { userId: 'u_sarah', name: 'Sarah Hughes', role: 'organiser' }, now: NOW }).card;

const visit = buildVisitCard({ householdId: HOUSEHOLD, personId: 'p_maria', name: 'Maria', arrivedAt: NOW, leftAt: NOW + 73 * 60 * 1000 }, 'Europe/London', NOW).card;

const language: Card = { type: 'LANGUAGE', ...base('language-es'), language: 'es', ...languageQuestion('es', 'Sarah') };

const photo: PhotoCard = {
  type: 'PHOTO',
  ...base('photo-ph_1'),
  photoId: 'ph_1',
  fromName: 'Sarah',
  photoUrl: 'https://pictures.example.com/ph_1.jpg',
  ...photoCardWords('Sarah'),
};

// Sent again after "Keep it" found the mantelpiece full — and, a day later, its address has run out (none is stored).
const { photoUrl: _address, ...photoWithoutAddress } = photo;
const photoFull: Card = {
  ...photoWithoutAddress,
  id: 'photo-ph_2',
  photoId: 'ph_2',
  notice: MANTEL_FULL_NOTICE,
};

/** Every kind of card, and the shapes of the door's and the picture's that draw differently. */
export const CARD_CASES: readonly CardCase[] = [
  {
    name: 'DOOR, before the picture',
    card: doorPhaseOne,
    spanish: inSpanish(doorPhaseOne),
    spanishWords: 'Hay alguien en la puerta de entrada.',
    press: { label: 'Not now', id: DOOR_ACTIONS.dismiss },
  },
  {
    name: 'DOOR, with picture and description',
    card: doorWhole,
    spanish: inSpanish(doorWhole, { description: 'Una mujer con un abrigo azul y una bolsa de la compra.' }),
    spanishWords: 'Una mujer con un abrigo azul',
    press: { label: 'Ask Sarah to look', id: DOOR_ACTIONS.askFamily },
  },
  {
    name: 'DOOR, expected visitor and a notice',
    card: doorExpected,
    spanish: inSpanish(doorExpected),
    // The television's own sentence around the name (words/words.ts).
    spanishWords: 'Parece ser Maria — se esperaba su visita ahora.',
    press: { label: 'Watch live', id: DOOR_ACTIONS.watchLive },
  },
  {
    name: 'DOOR, a visitor the family arranged',
    card: doorArranged,
    spanish: inSpanish(doorArranged),
    // The phrasebook's sentence (agent door/index.ts arrangedThisVisit); the visitor stays in the member's words.
    spanishWords: 'Sarah organizó esta visita.',
    press: { label: 'Not now', id: DOOR_ACTIONS.dismiss },
  },
  {
    name: 'MESSAGE',
    card: note,
    spanish: inSpanish(note, { transcript: 'Pasaré el sábado con los nietos. ¿Llevo la comida?' }),
    // The television's own headline.
    spanishWords: 'Un mensaje de Sarah.',
    press: { label: 'Another day would be better.', id: 'reply_1' },
  },
  {
    name: 'WEEK',
    card: week,
    spanish: inSpanish(week, { text: 'Maria vino el martes y el jueves por la mañana, como siempre.' }),
    spanishWords: 'Su semana.',
    press: { label: 'What Sarah sees', id: WEEK_ACTIONS.sharing },
  },
  { name: 'SHARING', card: sharing, spanish: inSpanish(sharing), spanishWords: 'Cuando alguien viene a su puerta de entrada.', press: { label: 'Next', id: SHARING_ACTIONS.next } },
  { name: 'CIRCLE', card: circle, spanish: inSpanish(circle), spanishWords: 'Tom Hughes desea unirse a su círculo familiar.', press: { label: 'Allow Tom', id: CIRCLE_ACTIONS.allow } },
  { name: 'TELL', card: tell, spanish: inSpanish(tell), spanishWords: '¿Se lo digo a Sarah?', press: { label: 'Keep it to myself', id: TELL_ACTIONS.keep } },
  { name: 'WATCH', card: watch, spanish: inSpanish(watch), spanishWords: 'Sarah ya puede ver Sintel con usted.', press: { label: 'Start the film', id: WATCH_ACTIONS.start } },
  { name: 'LIGHT', card: light, spanish: inSpanish(light), spanishWords: 'Su luz está encendida.', press: { label: 'Put it out for today', id: LIGHT_ACTIONS.putOut } },
  { name: 'REACH', card: reach, spanish: inSpanish(reach), spanishWords: '¿Pedir a Sarah que le llame?', press: { label: 'Just say hello', id: REACH_ACTIONS.hello } },
  { name: 'VISIT', card: visit, spanish: inSpanish(visit), spanishWords: '¿Es correcto?', press: { label: 'No, that’s not right', id: VISIT_ACTIONS.wrong } },
  // Asked in both languages at once: the same card whichever language the television is in.
  { name: 'LANGUAGE', card: language, spanish: language, spanishWords: '¿Quiere que Wick le hable en español?', press: { label: 'Sí, en español', id: LANGUAGE_ACTIONS.yes } },
  { name: 'PHOTO', card: photo, spanish: inSpanish(photo), spanishWords: 'Una foto de parte de Sarah.', press: { label: 'Keep it', id: PHOTO_ACTIONS.keep } },
  {
    name: 'PHOTO, mantelpiece full and no address',
    card: photoFull,
    spanish: inSpanish(photoFull),
    // The server's notice, and the television's own sentence in the picture's place.
    spanishWords: 'La foto no se puede mostrar ahora.',
    press: { label: 'Thank you', id: PHOTO_ACTIONS.thanks },
  },
];
