import { describe, expect, it } from 'vitest';
import { LANGUAGES, type HouseholdLanguage } from '@wick/contracts';
import { CATALOG } from '../../catalog/catalog.js';
import { WORDS, programmeLine, words, type WordKey } from '../words.js';

/** The values a sentence takes, by name: `{name}`, `{title}`. */
const named = (sentence: string): string[] => [...sentence.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
const keys = Object.keys(WORDS.en) as WordKey[];

/** The mantelpiece's words: new with it, so pinned here and not among the sentences older than the table. */
const MANTEL_WORDS = {
  // home/HomeScreen.tsx: the pill that opens it, and what the screen reader says of it.
  'home.mantel': 'Mantelpiece',
  'home.mantelLabel': 'Your mantelpiece. Press OK to see the pictures you have kept.',
  // home/waiting.ts
  'waiting.photo': 'A picture from {name} is waiting.',
  // cards/PhotoCard.tsx, mantel/Picture.tsx
  'photo.unavailable': 'The picture cannot be shown just now.',
  'photo.pictureLabel': 'A picture from {name}',
  // mantel/MantelScreen.tsx, mantel/IdleScreen.tsx
  'mantel.from': 'From {name}',
  'mantel.place': '{place} of {count}',
  'mantel.viewLabel': 'A picture from {name}, {place} of {count}. Left and right move between pictures. Press OK to leave it or take it down.',
  'mantel.choice': 'A picture from {name}.',
  'mantel.choiceDetail': 'Nobody is told if you take it down.',
  'mantel.leave': 'Leave it',
  'mantel.takeDown': 'Take it down',
} as const;

/** "Read to me": one sentence, said by the screen reader for the mark of the Play key on a card (read/ReadHint.tsx). */
const READ_WORDS = {
  'read.hint': 'Press Play to hear this.',
} as const;

/**
 * The door, outside Wick, on Fire OS (apps/tv-fireos/src/door): the button on the notification, the line under
 * its title before the door agent has said who is there, and the quiet notification that says Wick is listening.
 */
const DOOR_ALERT_WORDS = {
  'doorAlert.open': 'Open Wick',
  'doorAlert.who': 'Open Wick to see who it is.',
  'doorAlert.listening': 'Wick will tell you when someone is at the door.',
} as const;

describe('the words table — English, exactly as the television said it before there was a table', () => {
  it('says every sentence as it was written in the component it came from', () => {
    expect(WORDS.en).toEqual({
      // home/HomeScreen.tsx
      'home.question': 'What would you like to watch?',
      'home.open': 'Open',
      'home.lightLabel': 'Your light in the window. {light}. Press OK to see who can see it.',
      'home.waitingLabel': '{line} Press OK to open it.',
      // home/light.ts
      'home.lightOn': 'Light on',
      'home.lightOut': 'Light out',
      // home/waiting.ts
      'waiting.note': 'A note from {name} is waiting.',
      'waiting.week': 'Your week is ready to read.',
      'waiting.circle': '{name} would like to join your family circle.',
      'waiting.sharing': 'What your family can see is ready to look at.',
      'waiting.question': 'Wick has a question for you.',
      'waiting.something': 'Something is waiting for you.',
      // cards/WeekCard.tsx, cards/MessageCard.tsx, cards/DoorCard.tsx, cards/doorDetail.ts
      'week.headline': 'Your week.',
      'message.headline': 'A message from {name}.',
      'message.photoLabel': "{name}'s photo",
      'door.pictureLabel': 'Picture from the front door camera',
      'door.looksLikeExpected': 'This looks like {name} — expected around now.',
      'door.looksLike': 'This looks like {name}.',
      // pairing/PairingScreen.tsx
      'pairing.title': 'Set up Wick',
      'pairing.instructions': 'Enter this code in the Wick family app. There you say whose television this is.',
      'pairing.gettingCode': 'Getting a code…',
      // pairing/connect.ts
      'pairing.stillTrying': 'Wick cannot reach the home just now.',
      // watch/WatchScreen.tsx
      'watch.failed': '{title} will not play just now. Press Back.',
      'watch.starting': 'Starting {title}…',
      'watch.paused': 'Paused — {title}',
      'watch.companion': '{name} is watching with you.',
      // live/LiveView.tsx, live/liveClient.ts
      'live.opening': 'Opening the front door camera…',
      'live.caption': 'Live from the front door · {seconds} seconds left',
      'live.back': 'Back',
      'live.cameraUnavailable': "The doorbell camera isn't answering right now.",
      'live.cameraUnsupported': "This doorbell's camera can't be shown on the television yet.",
      'live.cardTooOld': "That visit was a while ago, so there's nothing live to show.",
      'live.noSuchCard': "There's no live picture for that visit.",
      'live.unauthorized': 'The television needs to be paired again before it can show the camera.',
      'live.ended': 'Live view has ended.',
      // A programme's line on the home screen (packages/contracts programmes.ts: "10 minutes").
      'programme.minutes': '{count} minutes',
      ...MANTEL_WORDS,
      ...READ_WORDS,
      ...DOOR_ALERT_WORDS,
    });
  });

  it('says what the door outside Wick added on Fire OS, and nothing else', () => {
    expect(Object.keys(WORDS.en).filter((key) => key.startsWith('doorAlert.'))).toEqual(Object.keys(DOOR_ALERT_WORDS));
  });

  it('says what "Read to me" added (packages/contracts speech.ts), and nothing else', () => {
    expect(Object.keys(WORDS.en).filter((key) => key.startsWith('read.'))).toEqual(Object.keys(READ_WORDS));
  });

  it('says what the mantelpiece added (packages/contracts mantel.ts), and nothing else', () => {
    expect(Object.keys(WORDS.en).filter((key) => /^(photo|mantel)\.|^home\.mantel|^waiting\.photo$/.test(key)).sort()).toEqual(Object.keys(MANTEL_WORDS).sort());
  });

  it('says a programme’s line exactly as the catalogue has it', () => {
    for (const programme of CATALOG) expect(programmeLine(programme, 'en')).toBe(programme.line);
    expect(CATALOG.map((programme) => programmeLine(programme, 'en'))).toEqual(['10 minutes', '15 minutes', '12 minutes']);
  });

  it('and that line is the minutes the film runs — which is how another language says it', () => {
    for (const programme of CATALOG) {
      expect(words('en')('programme.minutes', { count: Math.round(programme.durationMs / 60_000) })).toBe(programme.line);
    }
  });
});

describe('the words table — every language says everything', () => {
  it('has a table for each language a household can choose', () => {
    expect(Object.keys(WORDS).sort()).toEqual([...LANGUAGES].sort());
  });

  for (const language of LANGUAGES.filter((l) => l !== 'en')) {
    it(`${language}: has every key English has, and no key English has not`, () => {
      expect(Object.keys(WORDS[language]).sort()).toEqual([...keys].sort());
    });

    it(`${language}: says something for every key, and not the English over again`, () => {
      for (const key of keys) {
        expect(WORDS[language][key].trim(), key).not.toBe('');
        expect(WORDS[language][key], key).not.toBe(WORDS.en[key]);
      }
    });

    it(`${language}: puts the same values into each sentence as English does`, () => {
      for (const key of keys) expect(named(WORDS[language][key]), key).toEqual(named(WORDS.en[key]));
    });
  }
});

describe('Spanish — plain, to usted, and no longer than the place it goes', () => {
  const es = WORDS.es;

  it('sets the tone', () => {
    expect(es['home.question']).toBe('¿Qué le gustaría ver?');
    expect(es['home.lightOn']).toBe('Luz encendida');
    expect(es['home.lightOut']).toBe('Luz apagada');
    expect(es['home.open']).toBe('Abrir');
    expect(es['waiting.note']).toBe('Hay una nota de {name} esperando.');
    expect(es['waiting.question']).toBe('Wick tiene una pregunta para usted.');
    expect(es['watch.paused']).toBe('En pausa — {title}');
    expect(es['programme.minutes']).toBe('{count} minutos');
  });

  it('calls the mantelpiece the shelf where the family’s pictures stand, and a picture una foto', () => {
    expect(es['home.mantel']).toBe('Repisa');
    expect(es['waiting.photo']).toBe('Hay una foto de {name} esperando.');
    expect(es['photo.unavailable']).toBe('La foto no se puede mostrar ahora.');
    expect(es['mantel.from']).toBe('De {name}');
    expect(es['mantel.place']).toBe('{place} de {count}');
    expect(es['mantel.leave']).toBe('Dejarla');
    expect(es['mantel.takeDown']).toBe('Quitarla');
    // "La", for la foto: nothing here has to agree with whoever sent it.
    expect(es['mantel.choiceDetail']).toBe('Nadie se entera si la quita.');
  });

  it('calls the key what is said of it in a Spanish-speaking home in the United States: Play', () => {
    expect(es['read.hint']).toBe('Presione Play para oír esto.');
  });

  it('addresses her as usted: never tú', () => {
    for (const key of keys) expect(es[key], key).not.toMatch(/(?<!\p{L})(tú|tu|tus|te|ti|contigo|tuyo|tuya)(?!\p{L})/iu);
  });

  it('opens every question it closes', () => {
    for (const key of keys) {
      expect((es[key].match(/¿/g) ?? []).length, key).toBe((es[key].match(/\?/g) ?? []).length);
      expect((es[key].match(/¡/g) ?? []).length, key).toBe((es[key].match(/!/g) ?? []).length);
    }
  });

  it('leaves Wick its name', () => {
    for (const key of keys) expect(es[key].includes('Wick'), key).toBe(WORDS.en[key].includes('Wick'));
  });

  /**
   * The home screen gives each of these one line and has no height to
   * spare, so a sentence is shortened rather than set smaller. The two
   * words on the light's button are the exception: they are longer than
   * "Light on", and the line they share with the question is shorter than
   * the English one all the same (below).
   */
  const LONGER_ON_PURPOSE: readonly WordKey[] = ['home.lightOn', 'home.lightOut'];

  it('is within about 130% of the length of the English it stands in for', () => {
    for (const key of keys.filter((k) => !LONGER_ON_PURPOSE.includes(k))) {
      expect(es[key].length, `${key}: “${es[key]}”`).toBeLessThanOrEqual(Math.ceil(WORDS.en[key].length * 1.3));
    }
  });

  it('fits the top of the home screen: the question at 48pt and the light’s button at 32pt, on one line', () => {
    const line = (language: HouseholdLanguage, light: WordKey): number => WORDS[language]['home.question'].length * 48 + WORDS[language][light].length * 32;

    for (const light of LONGER_ON_PURPOSE) expect(line('es', light)).toBeLessThanOrEqual(line('en', light));
  });

  it('says a programme’s line in Spanish, by the minutes the film runs', () => {
    expect(CATALOG.map((programme) => programmeLine(programme, 'es'))).toEqual(['10 minutos', '15 minutos', '12 minutos']);
  });
});

describe('words(language) — the sentence, with what it names put in', () => {
  it('says a sentence in the language asked for', () => {
    expect(words('en')('home.question')).toBe('What would you like to watch?');
    expect(words('es')('home.question')).toBe('¿Qué le gustaría ver?');
  });

  it('puts in a name, a film’s title and a number', () => {
    expect(words('en')('waiting.note', { name: 'Sarah' })).toBe('A note from Sarah is waiting.');
    expect(words('es')('waiting.note', { name: 'Sarah' })).toBe('Hay una nota de Sarah esperando.');
    expect(words('es')('watch.paused', { title: 'Big Buck Bunny' })).toBe('En pausa — Big Buck Bunny');
    expect(words('en')('live.caption', { seconds: 42 })).toBe('Live from the front door · 42 seconds left');
    expect(words('en')('home.lightLabel', { light: 'Light on' })).toBe('Your light in the window. Light on. Press OK to see who can see it.');
  });

  it('puts a value in as it stands, even one that looks like a place for another', () => {
    expect(words('en')('waiting.note', { name: '{title}' })).toBe('A note from {title} is waiting.');
    expect(words('en')('waiting.note', { name: '$&' })).toBe('A note from $& is waiting.');
  });

  it('is English when no language is given, and for a language it has never heard of', () => {
    expect(words()('home.open')).toBe('Open');
    expect(words('fr' as HouseholdLanguage)('home.open')).toBe('Open');
    expect(words(undefined)('home.open')).toBe('Open');
  });

  it('is the same function each time for a language, so a screen is not drawn again for nothing', () => {
    expect(words('es')).toBe(words('es'));
    expect(words('es')).not.toBe(words('en'));
  });
});
