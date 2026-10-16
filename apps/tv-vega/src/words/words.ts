/**
 * The television's own words, in each language a household can choose
 * (packages/contracts/src/language.ts).
 *
 * Nearly everything on a card is written by the server and arrives already
 * in her language. What is here is the rest: the sentences this app says by
 * itself — the home screen, what is waiting, the film's notices, the door
 * camera, the names a screen reader is given. A sentence added to a screen
 * goes here, in every language, or it stays English when she has chosen
 * another: words/__tests__/hardcoded.test.ts fails on one written straight
 * into a component, and words.test.ts on a key one language has and another
 * has not.
 *
 * English is word for word what the television said before there was a
 * table. Spanish is written by hand, like the phrasebook: neutral, plain,
 * to usted, with no sentence that would have to agree with a name's gender,
 * and no longer than the place it goes — the home screen gives each of
 * these one line. "Wick" and a film's title are never translated.
 *
 * A value is named in braces — `{name}`, `{title}`, `{seconds}` — and the
 * accessor will not compile without each one a sentence names.
 *
 * Three places do not read this table, each for its own reason:
 *   - the pairing screen reads it in English always: there is no household
 *     yet to have a language (pairing/PairingScreen.tsx);
 *   - a family member's own television (family/) stays English;
 *   - the toast the Vega background service posts (notify/doorToast.ts):
 *     that process is never told the home's language. (Fire OS's door
 *     notification does read it: its service shares the app's storage —
 *     the `doorAlert.` sentences below.)
 *
 * Pure, and imports nothing of the platform.
 */
import { DEFAULT_LANGUAGE, type HouseholdLanguage, type Programme } from '@wick/contracts';

const en = {
  // The home screen (home/HomeScreen.tsx).
  'home.question': 'What would you like to watch?',
  'home.open': 'Open',
  /** Spoken by the screen reader on the light's button. `light` is one of the two below. */
  'home.lightLabel': 'Your light in the window. {light}. Press OK to see who can see it.',
  /** Spoken on the row that says something is waiting. `line` is one of the waiting lines. */
  'home.waitingLabel': '{line} Press OK to open it.',
  // The two words on the light's button (home/light.ts).
  'home.lightOn': 'Light on',
  'home.lightOut': 'Light out',

  // What is waiting, in one line (home/waiting.ts).
  'waiting.note': 'A note from {name} is waiting.',
  'waiting.week': 'Your week is ready to read.',
  'waiting.circle': '{name} would like to join your family circle.',
  'waiting.sharing': 'What your family can see is ready to look at.',
  'waiting.question': 'Wick has a question for you.',
  'waiting.something': 'Something is waiting for you.',

  // Cards: the few words that are not the server's.
  'week.headline': 'Your week.',
  'message.headline': 'A message from {name}.',
  'message.photoLabel': "{name}'s photo",
  'door.pictureLabel': 'Picture from the front door camera',
  'door.looksLikeExpected': 'This looks like {name} — expected around now.',
  'door.looksLike': 'This looks like {name}.',

  // The pairing screen. Shown in English always — see the header.
  'pairing.title': 'Set up Wick',
  'pairing.instructions': 'Enter this code in the Wick family app. There you say whose television this is.',
  'pairing.gettingCode': 'Getting a code…',
  /** Under "Getting a code…" while the pairing service cannot be reached (pairing/connect.ts). The family screen's own words, word for word. */
  'pairing.stillTrying': 'Wick cannot reach the home just now.',

  // A programme, playing (watch/WatchScreen.tsx).
  'watch.failed': '{title} will not play just now. Press Back.',
  'watch.starting': 'Starting {title}…',
  'watch.paused': 'Paused — {title}',
  'watch.companion': '{name} is watching with you.',

  // The door camera, live (live/LiveView.tsx, live/liveClient.ts).
  'live.opening': 'Opening the front door camera…',
  'live.caption': 'Live from the front door · {seconds} seconds left',
  'live.back': 'Back',
  'live.cameraUnavailable': "The doorbell camera isn't answering right now.",
  'live.cameraUnsupported': "This doorbell's camera can't be shown on the television yet.",
  'live.cardTooOld': "That visit was a while ago, so there's nothing live to show.",
  'live.noSuchCard': "There's no live picture for that visit.",
  'live.unauthorized': 'The television needs to be paired again before it can show the camera.',
  'live.ended': 'Live view has ended.',

  // Under a film's title on the home screen.
  'programme.minutes': '{count} minutes',

  // The mantelpiece (packages/contracts mantel.ts). The picture card's
  // headline, its two buttons and its notice are the server's; these are the
  // television's own.
  /** The pill on the home screen that opens it. */
  'home.mantel': 'Mantelpiece',
  /** Spoken on that pill. */
  'home.mantelLabel': 'Your mantelpiece. Press OK to see the pictures you have kept.',
  'waiting.photo': 'A picture from {name} is waiting.',
  /** In the picture's place when it has no address, or its address no longer answers. */
  'photo.unavailable': 'The picture cannot be shown just now.',
  /** Spoken for the picture itself. */
  'photo.pictureLabel': 'A picture from {name}',
  /** The one quiet line under a picture on the mantelpiece: "From Sarah · 2 of 5". */
  'mantel.from': 'From {name}',
  'mantel.place': '{place} of {count}',
  /** Spoken for the picture in view on the mantelpiece. */
  'mantel.viewLabel': 'A picture from {name}, {place} of {count}. Left and right move between pictures. Press OK to leave it or take it down.',
  /** The choice OK opens. "Leave it" comes first and holds the focus. */
  'mantel.choice': 'A picture from {name}.',
  'mantel.choiceDetail': 'Nobody is told if you take it down.',
  'mantel.leave': 'Leave it',
  'mantel.takeDown': 'Take it down',

  // Read to me (packages/contracts speech.ts). What the screen reader says for the mark of the Play key that
  // stands on every card (read/ReadHint.tsx): the sentence itself is not written on a card, because no card
  // has a line to spare for it at 32pt.
  'read.hint': 'Press Play to hear this.',

  // The door, outside Wick, on Fire OS (apps/tv-fireos/src/door). Word for word what the Vega toast says
  // (notify/doorToast.ts), which stays English: there the service is never told the language. On Fire OS it
  // shares the app's storage, and reads the language the app keeps there.
  /** The one button on the notification. */
  'doorAlert.open': 'Open Wick',
  /** Under the title, until the door agent has said who is there. */
  'doorAlert.who': 'Open Wick to see who it is.',
  /** The quiet notification Android asks for while the door is listened for behind another app. */
  'doorAlert.listening': 'Wick will tell you when someone is at the door.',

  // Easier to see (seeing/seeing.ts): the pill on the home screen, and the card it opens. Each button says
  // how its setting stands, as a whole sentence for each — never "on" put after a word.
  'seeing.entry': 'Easier to see',
  'seeing.entryLabel': 'Easier to see. Press OK for larger text or higher contrast.',
  'seeing.headline': 'Easier to see',
  'seeing.detail': 'This changes only this television.',
  'seeing.largerOn': 'Larger text: on',
  'seeing.largerOff': 'Larger text: off',
  'seeing.contrastOn': 'Higher contrast: on',
  'seeing.contrastOff': 'Higher contrast: off',
  'seeing.back': 'Back',
} as const;

export type WordKey = keyof typeof en;

const es: Readonly<Record<WordKey, string>> = {
  'home.question': '¿Qué le gustaría ver?',
  'home.open': 'Abrir',
  'home.lightLabel': 'Su luz en la ventana. {light}. Presione OK para ver quién puede verla.',
  'home.waitingLabel': '{line} Presione OK para abrir.',
  'home.lightOn': 'Luz encendida',
  'home.lightOut': 'Luz apagada',

  'waiting.note': 'Hay una nota de {name} esperando.',
  'waiting.week': 'Su semana está lista para leer.',
  'waiting.circle': '{name} quiere unirse a su círculo familiar.',
  'waiting.sharing': 'Ya puede revisar lo que ve su familia.',
  'waiting.question': 'Wick tiene una pregunta para usted.',
  'waiting.something': 'Algo le está esperando.',

  'week.headline': 'Su semana.',
  'message.headline': 'Un mensaje de {name}.',
  'message.photoLabel': 'Foto de {name}',
  'door.pictureLabel': 'Imagen de la cámara de la puerta',
  // "Su visita", so the sentence need not agree with whoever is named.
  'door.looksLikeExpected': 'Parece ser {name} — se esperaba su visita ahora.',
  'door.looksLike': 'Parece ser {name}.',

  'pairing.title': 'Configurar Wick',
  'pairing.instructions': 'Escriba este código en la app familiar de Wick. Allí se indica de quién es este televisor.',
  'pairing.gettingCode': 'Pidiendo un código…',
  'pairing.stillTrying': 'Wick no puede comunicarse con la casa ahora.',

  'watch.failed': '{title} no se puede ver ahora. Presione Atrás.',
  'watch.starting': 'Iniciando {title}…',
  'watch.paused': 'En pausa — {title}',
  'watch.companion': '{name} ve la película con usted.',

  'live.opening': 'Abriendo la cámara de la puerta…',
  // The number last, so the sentence is right for one second as for forty.
  'live.caption': 'La puerta en vivo · segundos restantes: {seconds}',
  'live.back': 'Atrás',
  'live.cameraUnavailable': 'La cámara del timbre no responde ahora.',
  'live.cameraUnsupported': 'La cámara de este timbre aún no se puede ver en el televisor.',
  'live.cardTooOld': 'Esa visita fue hace un rato; ya no hay nada en vivo que mostrar.',
  'live.noSuchCard': 'No hay imagen en vivo de esa visita.',
  'live.unauthorized': 'Hay que volver a vincular el televisor para ver la cámara.',
  'live.ended': 'La vista en vivo terminó.',

  'programme.minutes': '{count} minutos',

  // "Repisa": the shelf where the family's pictures stand. "Foto", as she would say it.
  'home.mantel': 'Repisa',
  'home.mantelLabel': 'Su repisa. Presione OK para ver las fotos que guardó.',
  'waiting.photo': 'Hay una foto de {name} esperando.',
  'photo.unavailable': 'La foto no se puede mostrar ahora.',
  'photo.pictureLabel': 'Una foto de {name}',
  'mantel.from': 'De {name}',
  'mantel.place': '{place} de {count}',
  'mantel.viewLabel': 'Una foto de {name}, {place} de {count}. Izquierda y derecha cambian de foto. Presione OK para dejarla o quitarla.',
  'mantel.choice': 'Una foto de {name}.',
  // "La", for la foto: nothing here has to agree with whoever sent it.
  'mantel.choiceDetail': 'Nadie se entera si la quita.',
  'mantel.leave': 'Dejarla',
  'mantel.takeDown': 'Quitarla',

  // "Play": the key carries a mark and no word, and Play is what it is called.
  'read.hint': 'Presione Play para oír esto.',

  'doorAlert.open': 'Abrir Wick',
  'doorAlert.who': 'Abra Wick para ver quién es.',
  'doorAlert.listening': 'Wick le avisará cuando alguien llame a la puerta.',

  // "Sí" and "no" after the colon, so nothing has to agree with "letra" or "contraste".
  'seeing.entry': 'Más fácil de ver',
  'seeing.entryLabel': 'Más fácil de ver. Presione OK para letra más grande o más contraste.',
  'seeing.headline': 'Más fácil de ver',
  'seeing.detail': 'Esto cambia solo este televisor.',
  'seeing.largerOn': 'Letra más grande: sí',
  'seeing.largerOff': 'Letra más grande: no',
  'seeing.contrastOn': 'Más contraste: sí',
  'seeing.contrastOff': 'Más contraste: no',
  'seeing.back': 'Atrás',
};

/** Every language's table. A language added to the contract does not compile until it has one. */
export const WORDS: Readonly<Record<HouseholdLanguage, Readonly<Record<WordKey, string>>>> = { en, es };

/** The values a sentence names: `'A note from {name} is waiting.'` names `name`. */
type Named<Sentence extends string> = Sentence extends `${string}{${infer Name}}${infer Rest}` ? Name | Named<Rest> : never;
type Values<Key extends WordKey> = [Named<(typeof en)[Key]>] extends [never]
  ? []
  : [values: Readonly<Record<Named<(typeof en)[Key]>, string | number>>];

/** A sentence that names nothing: said as it stands. */
export type PlainWordKey = { [Key in WordKey]: Values<Key> extends [] ? Key : never }[WordKey];

/** Says one of the television's own sentences, with what it names put in. */
export type Say = <Key extends WordKey>(key: Key, ...values: Values<Key>) => string;

const sayIn = (table: Readonly<Record<WordKey, string>>): Say =>
  ((key: WordKey, values?: Readonly<Record<string, string | number>>) =>
    // Each place is filled once, from the sentence as written: a name that itself looks like a place is left as it is.
    table[key].replace(/\{(\w+)\}/g, (place: string, name: string) => (values && name in values ? String(values[name]) : place))) as Say;

const SAY: Readonly<Record<HouseholdLanguage, Say>> = { en: sayIn(en), es: sayIn(es) };

/**
 * The television's words in one language: `words(language)('home.question')`,
 * `words(language)('waiting.note', { name })`. English when none is given,
 * and for anything that is not a language Wick has — a television must
 * never go wordless over a value it did not expect.
 */
export function words(language: HouseholdLanguage | undefined = DEFAULT_LANGUAGE): Say {
  return Object.prototype.hasOwnProperty.call(SAY, language) ? SAY[language] : SAY[DEFAULT_LANGUAGE];
}

/**
 * The line under a film's title. In English it is the catalogue's own line,
 * as it always was; in another language it is said from the minutes the
 * film runs, which is what that line says (words.test.ts holds the two to
 * agree).
 */
export function programmeLine(programme: Pick<Programme, 'line' | 'durationMs'>, language: HouseholdLanguage | undefined = DEFAULT_LANGUAGE): string {
  if (language === DEFAULT_LANGUAGE || !Object.prototype.hasOwnProperty.call(SAY, language)) return programme.line;
  return words(language)('programme.minutes', { count: Math.round(programme.durationMs / 60_000) });
}
