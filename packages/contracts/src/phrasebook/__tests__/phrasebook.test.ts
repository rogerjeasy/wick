import { describe, expect, it } from 'vitest';
import {
  MAX_CARD_DETAIL_CHARS,
  MANTEL_FULL_NOTICE,
  cardIn,
  freeTextOf,
  homeIn,
  languageCardId,
  languageQuestion,
  patchIn,
  photoCardId,
  photoCardWords,
  sayIn,
  type Card,
  type CardPatch,
  type DoorCard,
  type HomeState,
  type LanguageCard,
  type MessageCard,
  type PhotoCard,
  type TellCard,
  type WeekCard,
} from '../../index.js';
import { FIELD_LIMIT } from '../engine.js';
import { ES_CATALOGUE, SPANISH } from '../es.js';

const es = (english: string): string | undefined => sayIn('es', english);

const base = { householdId: 'hh-1', correlationId: 'c-1', createdAt: 1_790_900_000_000 };

describe('sayIn — one of Wick’s own sentences, in her language', () => {
  it('gives the Spanish for a sentence the phrasebook holds', () => {
    expect(es("Someone's at the front door.")).toBe('Hay alguien en la puerta de entrada.');
    expect(es('Is this right?')).toBe('¿Es correcto?');
    expect(es('Not now')).toBe('Ahora no');
  });

  it('is undefined for a sentence it does not hold: it never guesses', () => {
    expect(es('The cat sat on the mat.')).toBeUndefined();
    expect(es('')).toBeUndefined();
    expect(es('Shall we dance?')).toBeUndefined();
  });

  it('is undefined for a near miss: one word changed is another sentence', () => {
    expect(es('Someone is at the front door.')).toBeUndefined();
    expect(es("Someone's at the back door.")).toBeUndefined();
    expect(es('Your light is off.')).toBeUndefined();
    expect(es('Is this correct?')).toBeUndefined();
    expect(es('Sarah peeked in this morning.')).toBeUndefined();
    expect(es('Sarah looked in this morning')).toBeUndefined();
    expect(es('Sarah looked in this lunchtime.')).toBeUndefined();
    expect(es('Sarah has been asked to ring you soon.')).toBeUndefined();
  });

  it('matches the whole string and nothing less: no trimming, no part of a longer one', () => {
    expect(es(' Not now')).toBeUndefined();
    expect(es('Not now ')).toBeUndefined();
    expect(es('Not now\n')).toBeUndefined();
    expect(es('Not now, thank you')).toBeUndefined();
    expect(es('He said: Is this right?')).toBeUndefined();
  });

  it('a first name is one word: a word slipped in beside it is not swallowed as part of the name', () => {
    expect(es('Sarah quickly looked in this morning.')).toBeUndefined();
    expect(es('Dear Sarah has been asked to look.')).toBeUndefined();
  });

  it('never throws, whatever it is handed', () => {
    for (const odd of [undefined, null, 7, {}, [], 'x'.repeat(100_000)]) {
      expect(() => sayIn('es', odd as unknown as string)).not.toThrow();
      expect(sayIn('es', odd as unknown as string)).toBeUndefined();
    }
    expect(sayIn('fr' as unknown as 'es', 'Not now')).toBeUndefined();
    expect(sayIn('en' as unknown as 'es', 'Not now')).toBeUndefined();
  });
});

describe('what a placeholder carries', () => {
  it('a name, unchanged — hyphens, apostrophes and accents with it', () => {
    expect(es('Sarah looked in this morning.')).toBe('Sarah ha preguntado por usted esta mañana.');
    expect(es('Anne-Marie looked in this morning.')).toBe('Anne-Marie ha preguntado por usted esta mañana.');
    expect(es('O’Brien looked in this morning.')).toBe('O’Brien ha preguntado por usted esta mañana.');
    expect(es("D'Arcy looked in this morning.")).toBe("D'Arcy ha preguntado por usted esta mañana.");
    expect(es('José looked in this morning.')).toBe('José ha preguntado por usted esta mañana.');
    expect(es('Zoë looked in this morning.')).toBe('Zoë ha preguntado por usted esta mañana.');
  });

  it('a name with characters that mean something to a pattern, exactly as it is', () => {
    for (const name of ['$&', '$1', '$$', 'A+B', '(Bob)', '[x]', 'a|b', '^caret$', 'st*r', 'back\\slash', '{name}', '{first|cap}', 'a.b', '\\d+', '.*']) {
      expect(es(`${name} looked in this morning.`), name).toBe(`${name} ha preguntado por usted esta mañana.`);
      expect(es(`Ask ${name} to look`), name).toBe(`Pedir a ${name} que mire`);
    }
  });

  it('a name that is a weekday stays a name, and the weekday beside it is translated', () => {
    expect(es('Tuesday was here on Tuesday from 9:02 am to 9:47 am.')).toBe('Tuesday estuvo aquí el martes de 9:02 a 9:47.');
    expect(es('Monday looked in this evening.')).toBe('Monday ha preguntado por usted esta noche.');
    expect(es('April usually comes on Friday mornings.')).toBe('April suele venir los viernes por la mañana.');
  });

  it('a very long name, whole and promptly', () => {
    const long = 'Wolfeschlegelsteinhausenbergerdorff'.repeat(6);
    const started = Date.now();
    expect(es(`${long} has been asked to look.`)).toBe(`Se ha pedido a ${long} que mire.`);
    expect(es(`${long} ${long} would like to join your family circle.`)).toBe(`${long} ${long} desea unirse a su círculo familiar.`);
    expect(es(`${'a '.repeat(400)}looked in this morning.`)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a full name of several words where a builder writes one, titles and initials with it', () => {
    expect(es('Maria Lopez was here on Monday from 9:02 am to 9:47 am.')).toBe('Maria Lopez estuvo aquí el lunes de 9:02 a 9:47.');
    expect(es('Dr. Patel came on Friday at 10:15 am.')).toBe('Dr. Patel vino el viernes a las 10:15.');
    expect(es('Sarah J. Hughes would like to join your family circle.')).toBe('Sarah J. Hughes desea unirse a su círculo familiar.');
  });

  it('every weekday', () => {
    const days = [['Monday', 'lunes'], ['Tuesday', 'martes'], ['Wednesday', 'miércoles'], ['Thursday', 'jueves'], ['Friday', 'viernes'], ['Saturday', 'sábado'], ['Sunday', 'domingo']] as const;
    for (const [english, spanish] of days) {
      expect(es(`There was no visit on ${english}.`)).toBe(`El ${spanish} no hubo visita.`);
    }
    expect(es('Maria usually comes on Saturday afternoons.')).toBe('Maria suele venir los sábados por la tarde.');
    expect(es('Maria usually comes on Sunday evenings.')).toBe('Maria suele venir los domingos a última hora de la tarde.');
    expect(es('Maria usually comes on Wednesday nights.')).toBe('Maria suele venir los miércoles por la noche.');
    expect(es('There was no visit on Someday.')).toBeUndefined();
  });

  it('a clock time, on the twenty-four-hour clock she reads', () => {
    const at = (time: string): string | undefined => es(`Maria came on Monday at ${time}.`);
    expect(at('9:02 am')).toBe('Maria vino el lunes a las 9:02.');
    expect(at('3:15 pm')).toBe('Maria vino el lunes a las 15:15.');
    expect(at('12:05 am')).toBe('Maria vino el lunes a las 0:05.');
    expect(at('12:30 pm')).toBe('Maria vino el lunes a las 12:30.');
    expect(at('11:59 pm')).toBe('Maria vino el lunes a las 23:59.');
    // One o'clock is "la una": the article follows the hour.
    expect(at('1:05 am')).toBe('Maria vino el lunes a la 1:05.');
    expect(at('1:05 pm')).toBe('Maria vino el lunes a las 13:05.');
    // As Intl writes it on some runtimes: a narrow no-break space before am/pm, or a no-break space.
    expect(at(`9:02${String.fromCharCode(0x202f)}am`)).toBe('Maria vino el lunes a las 9:02.');
    expect(at(`3:15${String.fromCharCode(0xa0)}pm`)).toBe('Maria vino el lunes a las 15:15.');
    expect(at('9:02am')).toBe('Maria vino el lunes a las 9:02.');
    expect(at('25:02 am')).toBeUndefined();
    expect(at('9:75 am')).toBeUndefined();
    expect(at('9:02')).toBeUndefined();
  });

  it('a part of the day', () => {
    expect(es('Sarah looked in this morning.')).toBe('Sarah ha preguntado por usted esta mañana.');
    expect(es('Sarah looked in this afternoon.')).toBe('Sarah ha preguntado por usted esta tarde.');
    expect(es('Sarah looked in this evening.')).toBe('Sarah ha preguntado por usted esta noche.');
  });

  it('a date, and the hour beside it', () => {
    expect(es('Sintel, on Sunday 18 October at 3 pm.')).toBe('Sintel, el domingo 18 de octubre a las 15:00.');
    expect(es('Big Buck Bunny, on Thursday 1 January at 9:05 am.')).toBe('Big Buck Bunny, el jueves 1 de enero a las 9:05.');
    expect(es('Tears of Steel, on Saturday 31 August at 1 pm.')).toBe('Tears of Steel, el sábado 31 de agosto a las 13:00.');
    expect(es('Sintel, on Sunday 18 Brumaire at 3 pm.')).toBeUndefined();
    const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].forEach((month, i) => {
      expect(es(`Sintel, on Monday 2 ${month} at 3 pm.`)).toBe(`Sintel, el lunes 2 de ${months[i]} a las 15:00.`);
    });
  });

  it('a count', () => {
    expect(es('3 of 4.')).toBe('3 de 4.');
    expect(es('Nobody had come at night in the 6 weeks before.')).toBe('En las 6 semanas anteriores no había venido nadie por la noche.');
    expect(es('three of four.')).toBeUndefined();
  });

  it('the nouns a builder uses where there is no one name', () => {
    expect(es('Ask the family to look')).toBe('Pedir a la familia que mire');
    expect(es('The family has been asked to look.')).toBe('Se ha pedido a la familia que mire.');
    expect(es('Shall I tell the family?')).toBe('¿Se lo digo a la familia?');
    expect(es('What your family sees')).toBe('Lo que ve su familia');
    expect(es('Your family can see this.')).toBe('Su familia puede ver esto.');
    expect(es('Someone has been asked to ring you.')).toBe('Se ha pedido a alguien que le llame.');
    expect(es('Someone looked in this morning.')).toBe('Alguien ha preguntado por usted esta mañana.');
    expect(es('That was the film, with your family.')).toBe('Ha terminado la película, con su familia.');
  });

  it('a list of names, with "y" for "and"', () => {
    expect(es('Sarah has not answered yet.')).toBe('Sarah todavía no ha respondido.');
    expect(es('Sarah and David have not answered yet.')).toBe('Sarah y David todavía no han respondido.');
    expect(es('Sarah, David and Tom have not answered yet.')).toBe('Sarah, David y Tom todavía no han respondido.');
    // "y" stays "y" before a name that begins with I: a name is never touched to fit the grammar.
    expect(es('Sarah and Irene have not answered yet.')).toBe('Sarah y Irene todavía no han respondido.');
  });

  it('a film’s title, unchanged', () => {
    expect(es('Sarah is ready to watch Big Buck Bunny with you.')).toBe('Sarah ya puede ver Big Buck Bunny con usted.');
    expect(es('About Tears of Steel, which you watched together.')).toBe('Sobre Tears of Steel, que ustedes vieron en compañía.');
  });
});

describe('a field of several sentences', () => {
  it('is translated sentence by sentence when every sentence is held', () => {
    expect(es('Sarah has been asked to ring you. Nobody has answered yet.')).toBe('Se ha pedido a Sarah que le llame. Todavía no ha respondido nadie.');
    expect(es('Maria usually comes on Friday mornings. There was no visit on Friday.')).toBe('Maria suele venir los viernes por la mañana. El viernes no hubo visita.');
  });

  it('is left whole when one sentence is not: never half in each language', () => {
    expect(es('Sarah has been asked to ring you. The weather is fine.')).toBeUndefined();
    expect(es('The weather is fine. Sarah has been asked to ring you.')).toBeUndefined();
    expect(es('Nobody has answered yet. Nobody has answered yet. Hmm.')).toBeUndefined();
  });

  it('a name cannot hide the end of a sentence: an unknown sentence before a known one is not taken for a long name', () => {
    expect(es('Sarah has been told you said hallo. Tom has been asked to look.')).toBeUndefined();
    expect(es('It rained. Maria was here on Monday from 9:02 am to 9:47 am.')).toBeUndefined();
    expect(es('It rained today. Maria Lopez would like to join your family circle.')).toBeUndefined();
  });

  it('the sentence that says most is the one that is meant', () => {
    // "somebody" is not somebody's name, and "Wick noted that Maria" is not a visitor's.
    expect(es('Wick will tell you here when somebody answers.')).toBe('Wick se lo dirá aquí cuando alguien responda.');
    expect(es('Wick will tell you here when Sarah answers.')).toBe('Wick se lo dirá aquí cuando Sarah responda.');
    expect(es('Wick noted that Maria was here on Tuesday from 9:02 am to 9:47 am. That is not right.')).toBe(
      'Wick anotó que Maria estuvo aquí el martes de 9:02 a 9:47. Eso no es correcto.',
    );
  });
});

describe('what she consents by, word for word', () => {
  it('the family circle (INV-9)', () => {
    expect(es('Sarah would like to join your family circle.')).toBe('Sarah desea unirse a su círculo familiar.');
    expect(es('If you allow it, Sarah can send you notes here and see what you choose to share. You can change what is shared at any time.')).toBe(
      'Si usted acepta, Sarah podrá enviarle notas aquí y ver lo que usted decida compartir. Puede cambiar lo que se comparte en cualquier momento.',
    );
    expect(es('Tom would like to be a neighbour you can ask.')).toBe('Tom desea ser alguien del vecindario a quien usted pueda recurrir.');
    expect(es('If you allow it, you can ask Tom to look at who is at your door, or to ring you. Tom will not see your week, your day or your notes.')).toBe(
      'Si usted acepta, podrá pedir a Tom que mire quién está en su puerta, o que le llame. Tom no verá su semana, su día ni sus notas.',
    );
    expect(es('Allow Sarah')).toBe('Aceptar a Sarah');
    expect(es('No, thank you')).toBe('No, gracias');
  });

  it('"Shall I tell Sarah?" (INV-10)', () => {
    expect(es('Shall I tell Sarah?')).toBe('¿Se lo digo a Sarah?');
    expect(es('Tell Sarah')).toBe('Decírselo a Sarah');
    expect(es('Keep it to myself')).toBe('Me lo guardo');
  });

  it('"Start the film", and what it shares', () => {
    expect(es('From when you start it, Sarah sees the film as you play it: where you pause, it pauses for Sarah too. Only this film, and only this time.')).toBe(
      'Desde que usted la inicie, Sarah verá la película tal como usted la reproduce: donde usted haga una pausa, también se pausará para Sarah. Solo esta película, y solo esta vez.',
    );
    expect(es('Start the film')).toBe('Iniciar la película');
  });

  it('asking to be rung: Wick calls nobody, and says so', () => {
    expect(es('Ask Sarah to ring you?')).toBe('¿Pedir a Sarah que le llame?');
    expect(es('Sarah will be told only that you would like a call. Wick does not call for help: in an emergency, use the telephone.')).toBe(
      'A Sarah solo se le dirá que usted desea una llamada. Wick no llama para pedir ayuda: en una emergencia, use el teléfono.',
    );
    expect(es('Yes, ask Sarah')).toBe('Sí, pedírselo a Sarah');
  });

  it('the visit: the door’s reading, put to her', () => {
    expect(es('Maria was here on Tuesday from 9:02 am to 9:47 am.')).toBe('Maria estuvo aquí el martes de 9:02 a 9:47.');
    expect(es('Yes, that’s right')).toBe('Sí, es correcto');
    expect(es('No, that’s not right')).toBe('No, no es correcto');
  });

  it('the light: one thing, and nothing more', () => {
    expect(es('Sarah can see that your day has begun, and nothing more: not when, and not what you watch.')).toBe(
      'Sarah puede ver que su día ha empezado, y nada más: ni cuándo, ni lo que usted ve.',
    );
    expect(es('Your family cannot tell whether you put it out or it has not been lit yet. It lights again tomorrow.')).toBe(
      'Su familia no puede saber si usted la apagó o si todavía no se ha encendido. Mañana se enciende de nuevo.',
    );
  });

  it('"What Sarah sees"', () => {
    expect(es('What Sarah sees')).toBe('Lo que ve Sarah');
    expect(es('Never shared, whatever you choose: your health, money, relationships, where you go, or your words.')).toBe(
      'Nunca se comparte, elija lo que elija: su salud, su dinero, sus relaciones, adónde va ni sus palabras.',
    );
  });
});

describe('the catalogue', () => {
  const entries = Object.entries(ES_CATALOGUE).flatMap(([module, list]) => list.map((entry) => ({ module, ...entry })));
  const fill = (text: string): string => text.replace(/\{(first|name|names|title)\d?\}/g, 'Sarah');

  it('compiles whole: no sentence is dropped for being written wrongly', () => {
    expect(SPANISH.problems).toEqual([]);
    expect(SPANISH.size).toBe(entries.length);
    expect(entries.length).toBeGreaterThan(120);
  });

  it('holds each English sentence once', () => {
    const english = entries.map((entry) => entry.en);
    expect(english.filter((en, i) => english.indexOf(en) !== i)).toEqual([]);
  });

  it('no sentence ends in a short capitalised word a name could carry across a full stop', () => {
    expect(entries.filter((entry) => /(^|\s)[A-Z][^\s.,:;!?]{0,2}\.$/.test(entry.en)).map((entry) => entry.en)).toEqual([]);
  });

  it('every Spanish sentence is written out: no placeholder left that the English does not have', () => {
    for (const entry of entries) {
      const keys = new Set([...entry.en.matchAll(/\{([a-z]+\d?)\}/g)].map((m) => m[1]!));
      for (const text of [entry.to, ...(entry.short === undefined ? [] : [entry.short])]) {
        for (const used of text.matchAll(/\{([a-z]+\d?)[|?}]/g)) expect(keys.has(used[1]!), `${entry.en} → ${text}`).toBe(true);
      }
      // A name she reads is a name she must be able to find again in the Spanish.
      for (const key of keys) if (/^(first|name|names|title)/.test(key)) expect(entry.to, entry.en).toContain(`{${key}`);
    }
  });

  it('speaks to her as usted: tú is only ever her own voice, in the replies she can send', () => {
    const informal = /(^|[\s¿¡])(tú|tu|tus|te|ti|contigo|vos)([\s.,;:!?]|$)/i;
    const hers = entries.filter((entry) => informal.test(entry.to)).map((entry) => entry.en);
    expect(hers).toEqual(['Thinking of you too.']);
  });

  it('keeps Wick’s name, and brackets its questions and exclamations the Spanish way', () => {
    for (const entry of entries) {
      expect(entry.to.includes('Wick'), entry.en).toBe(entry.en.includes('Wick'));
      expect((entry.to.match(/\?/g) ?? []).length, entry.to).toBe((entry.to.match(/¿/g) ?? []).length);
      expect((entry.to.match(/!/g) ?? []).length, entry.to).toBe((entry.to.match(/¡/g) ?? []).length);
    }
  });

  it('a button stays a button: short, and never long beside the English', () => {
    const buttons = entries.filter((entry) => entry.button);
    expect(buttons.length).toBeGreaterThan(40);
    for (const { en, to } of buttons) {
      const [english, spanish] = [fill(en), sayIn('es', fill(en))!];
      expect(spanish, en).toBe(fill(to).replace(/\{(\w+)\|cap\}/g, 'Sarah'));
      // Never more than about 26 characters, with a name of ordinary length in it.
      expect(spanish.length, `${english} → ${spanish}`).toBeLessThanOrEqual(26);
      // No more than the English and two fifths again — or eighteen characters, which is short whatever the English was.
      if (!en.includes('{')) expect(spanish.length, `${english} → ${spanish}`).toBeLessThanOrEqual(Math.max(Math.ceil(english.length * 1.4), 18));
    }
  });

  it('a sentence with names of twenty-four characters in it still fits a card', () => {
    const long = 'Bartholomew-Fitzgerald24';
    expect(long).toHaveLength(24);
    for (const { en } of entries.filter((entry) => !entry.button)) {
      const english = en
        .replace(/\{(first|name|names)\d?\}/g, long)
        .replace(/\{title\}/g, 'Tears of Steel')
        .replace(/\{day\d?\}/g, 'Wednesday')
        .replace(/\{date\}/g, 'Wednesday 30 September')
        .replace(/\{time\d?\}/g, '11:59 pm')
        .replace(/\{part\}/g, 'this afternoon')
        .replace(/\{parts\}/g, 'afternoons')
        .replace(/\{n\d?\}/g, '12');
      const spanish = sayIn('es', english);
      expect(spanish, english).toBeDefined();
      expect(spanish!.length, spanish).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
    }
  });

  it('goes by the card’s own limit', () => {
    expect(FIELD_LIMIT).toBe(MAX_CARD_DETAIL_CHARS);
  });
});

describe('a translation that would not fit the card', () => {
  const names = (count: number): string => {
    const list = Array.from({ length: count }, (_, i) => `Bartholomew-Fitzgerald${String(i).padStart(2, '0')}`);
    return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
  };

  const next = 'Bartholomew-Fitzgerald99';
  const english = (count: number): string => `${names(count)} have not answered yet. If nobody has answered in three minutes, Wick will ask ${next}.`;
  const theLongWay = (count: number): string =>
    `${names(count).replace(' and ', ' y ')} todavía no han respondido. Si nadie ha respondido en tres minutos, Wick se lo pedirá a ${next}.`;

  it('is said more shortly, as the builder itself would have: never cut, and never over the limit', () => {
    // Five names of twenty-four characters: the English just fits a card, and the Spanish said the long way just does not.
    expect(english(5).length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
    expect(theLongWay(5).length).toBeGreaterThan(MAX_CARD_DETAIL_CHARS);

    const spanish = es(english(5))!;

    expect(spanish).toBe(`Todavía no ha respondido nadie. Si nadie ha respondido en tres minutos, Wick se lo pedirá a ${next}.`);
    expect(spanish.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
  });

  it('is said the long way whenever that fits', () => {
    expect(theLongWay(3).length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
    expect(es(english(3))).toBe(theLongWay(3));
  });

  it('is left in English, whole, when no way of saying it fits: the English is known to', () => {
    const wide = 'W'.repeat(56);
    const fits = `Nobody asked before ${wide} has answered yet. If nobody has answered in three minutes, Wick will ask ${wide}.`;
    expect(fits.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
    expect(es(fits)).toBeUndefined();
  });
});

const door: DoorCard = {
  ...base,
  type: 'DOOR',
  id: 'door-abc',
  line: "Someone's at the front door.",
  description: 'A man in a yellow jacket holding a clipboard.',
  imageRef: 'https://download.example/frame.jpg?sig=abc',
  match: { personId: 'maria', name: 'Maria', basis: 'schedule', expectedToday: true, confidence: 0.9 },
  notice: 'The hallway chime rang.',
  actions: [
    { id: 'watch_live', label: 'Watch live', kind: 'primary' },
    { id: 'hallway_chime', label: 'Ring the hallway chime', kind: 'secondary' },
    { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
  ],
};

const note: MessageCard = {
  ...base,
  type: 'MESSAGE',
  id: 'note-1f0c',
  actions: [],
  fromName: 'Sarah',
  transcript: 'Shall I come on Saturday?',
  suggestedReplies: ['Yes, please do.', 'Another day would be better.', 'Not right now.'],
};

const wave: MessageCard = {
  ...base,
  type: 'MESSAGE',
  id: 'note-wave-7d1e',
  actions: [],
  fromName: 'Sarah Hughes',
  transcript: 'A wave to you from Sarah’s television.',
  suggestedReplies: ['Wave back', 'Not now'],
};

const week: WeekCard = {
  ...base,
  type: 'WEEK',
  id: 'week-2026-W41',
  isoWeek: '2026-W41',
  text: 'A quiet week. Maria came on Tuesday and Friday.',
  actions: [
    { id: 'seen', label: 'OK', kind: 'primary' },
    { id: 'sharing', label: 'What Sarah sees', kind: 'secondary' },
  ],
};

const tell: TellCard = {
  ...base,
  type: 'TELL',
  id: 'tell-missed_visit-maria-2026-10-09',
  headline: 'Shall I tell Sarah?',
  detail: 'Maria usually comes on Friday mornings. There was no visit on Friday.',
  actions: [
    { id: 'tell_family', label: 'Tell Sarah', kind: 'primary' },
    { id: 'keep_private', label: 'Keep it to myself', kind: 'dismiss' },
  ],
};

const photo: PhotoCard = { ...base, type: 'PHOTO', id: photoCardId('p_8Jk2-xQ9a'), photoId: 'p_8Jk2-xQ9a', fromName: 'Sarah Hughes', photoUrl: 'https://photos.example/p_8Jk2-xQ9a.jpg?sig=abc', ...photoCardWords('Sarah Hughes') };

describe('a picture for the mantelpiece (mantel.ts)', () => {
  it('says who it is from — from, not of — and offers to keep it or to say thank you', () => {
    expect(es('A picture from Sarah.')).toBe('Una foto de parte de Sarah.');
    expect(es('A picture from Anne-Marie.')).toBe('Una foto de parte de Anne-Marie.');
    expect(es('Keep it')).toBe('Guardarla');
    expect(es('Thank you')).toBe('Gracias');
  });

  it('"Thank you" is its own button: not the reply to a note, and not the way out of a question', () => {
    expect(es('Thank you!')).toBe('¡Gracias!');
    expect(es('No, thank you')).toBe('No, gracias');
    expect(es('No, thank you.')).toBe('No, gracias.');
    expect(es('Thank you.')).toBeUndefined();
  });

  it('says so when the mantelpiece is full, and what to do', () => {
    expect(es(MANTEL_FULL_NOTICE)).toBe('Su repisa está llena. Quite una foto, y entonces podrá guardar esta.');
    expect(es('Your mantelpiece is full.')).toBeUndefined();
    expect(es('Your mantelpiece is full. Take two down, then you can keep this.')).toBeUndefined();
  });

  it('the card: its headline and its two buttons, and nothing else of it', () => {
    expect(cardIn('es', photo)).toEqual({
      ...photo,
      headline: 'Una foto de parte de Sarah.',
      actions: [
        { id: 'keep', label: 'Guardarla', kind: 'primary' },
        { id: 'thanks', label: 'Gracias', kind: 'secondary' },
      ],
    });
    expect('notice' in cardIn('es', photo)).toBe(false);
  });

  it('the card with the notice on it, when "Keep it" found no room', () => {
    const full: PhotoCard = { ...photo, notice: MANTEL_FULL_NOTICE };
    const shown = cardIn('es', full) as PhotoCard;
    expect(shown.notice).toBe('Su repisa está llena. Quite una foto, y entonces podrá guardar esta.');
    expect(shown.headline).toBe('Una foto de parte de Sarah.');
    expect(shown).toMatchObject({ id: full.id, photoId: 'p_8Jk2-xQ9a', fromName: 'Sarah Hughes', photoUrl: 'https://photos.example/p_8Jk2-xQ9a.jpg?sig=abc' });
  });

  it('the notice as a patch to the card she has open', () => {
    expect(patchIn('es', { cardId: photo.id, notice: MANTEL_FULL_NOTICE })).toEqual({ cardId: photo.id, notice: 'Su repisa está llena. Quite una foto, y entonces podrá guardar esta.' });
    expect(patchIn('es', { cardId: photo.id })).toEqual({ cardId: photo.id });
  });

  it('has no free text: a picture carries no words of the family’s, so no machine is handed any of it', () => {
    expect(freeTextOf(photo)).toEqual({});
    expect(freeTextOf({ ...photo, notice: MANTEL_FULL_NOTICE })).toEqual({});
    expect(cardIn('es', photo, { transcript: 'x', description: 'y', text: 'z' })).toEqual(cardIn('es', photo));
  });
});

describe('freeTextOf — what on a card is not Wick’s own sentence', () => {
  it('is the note the family wrote', () => {
    expect(freeTextOf(note)).toEqual({ transcript: 'Shall I come on Saturday?' });
  });

  it('is the door’s description of who is there', () => {
    expect(freeTextOf(door)).toEqual({ description: 'A man in a yellow jacket holding a clipboard.' });
    const { description: _none, ...bare } = door;
    expect(freeTextOf(bare)).toEqual({});
  });

  it('is the week’s paragraph', () => {
    expect(freeTextOf(week)).toEqual({ text: 'A quiet week. Maria came on Tuesday and Friday.' });
  });

  it('is not a wave’s sentence: that one is Wick’s', () => {
    expect(freeTextOf(wave)).toEqual({});
  });

  it('is nothing on any other card, and nothing that is not there', () => {
    expect(freeTextOf(tell)).toEqual({});
    const { transcript: _none, ...silent } = note;
    expect(freeTextOf(silent)).toEqual({});
    expect(freeTextOf({ ...note, transcript: '' })).toEqual({});
    expect(freeTextOf({ ...base, type: 'LANGUAGE', id: languageCardId('es'), language: 'es', ...languageQuestion('es', 'Sarah') })).toEqual({});
  });
});

describe('cardIn — a card as her television should show it', () => {
  it('puts every sentence of Wick’s into her language, and the buttons’ labels with them', () => {
    expect(cardIn('es', tell)).toEqual({
      ...tell,
      headline: '¿Se lo digo a Sarah?',
      detail: 'Maria suele venir los viernes por la mañana. El viernes no hubo visita.',
      actions: [
        { id: 'tell_family', label: 'Decírselo a Sarah', kind: 'primary' },
        { id: 'keep_private', label: 'Me lo guardo', kind: 'dismiss' },
      ],
    });
  });

  it('never touches an id, an action’s id or kind, a name, a time or an address', () => {
    const shown = cardIn('es', door) as DoorCard;
    expect(shown.id).toBe(door.id);
    expect(shown.householdId).toBe(door.householdId);
    expect(shown.correlationId).toBe(door.correlationId);
    expect(shown.createdAt).toBe(door.createdAt);
    expect(shown.imageRef).toBe(door.imageRef);
    expect(shown.match).toEqual(door.match);
    expect(shown.actions.map(({ id, kind }) => ({ id, kind }))).toEqual(door.actions.map(({ id, kind }) => ({ id, kind })));
    expect(shown.line).toBe('Hay alguien en la puerta de entrada.');
    expect(shown.notice).toBe('Ha sonado el timbre del pasillo.');
    expect(shown.actions.map((a) => a.label)).toEqual(['Ver en vivo', 'Tocar timbre del pasillo', 'Ahora no']);
    expect((cardIn('es', wave) as MessageCard).fromName).toBe('Sarah Hughes');
  });

  it('leaves free text exactly as it was unless a translation is handed in', () => {
    expect((cardIn('es', door) as DoorCard).description).toBe(door.description);
    expect((cardIn('es', note) as MessageCard).transcript).toBe(note.transcript);
    expect((cardIn('es', week) as WeekCard).text).toBe(week.text);
    expect((cardIn('es', door, {}) as DoorCard).description).toBe(door.description);
  });

  it('shows the translation handed in for a free field, and only for the field it is for', () => {
    expect((cardIn('es', door, { description: 'Un hombre con chaqueta amarilla y una carpeta.' }) as DoorCard).description).toBe('Un hombre con chaqueta amarilla y una carpeta.');
    expect((cardIn('es', note, { transcript: '¿Voy el sábado?' }) as MessageCard).transcript).toBe('¿Voy el sábado?');
    expect((cardIn('es', week, { text: 'Una semana tranquila.' }) as WeekCard).text).toBe('Una semana tranquila.');
    // A translation for a field this card does not have, or has not got, is nobody's.
    expect(cardIn('es', tell, { transcript: 'x', description: 'y', text: 'z' })).toEqual(cardIn('es', tell));
    expect((cardIn('es', note, { description: 'y', text: 'z' }) as MessageCard).transcript).toBe(note.transcript);
    const { description: _none, ...bare } = door;
    expect('description' in cardIn('es', bare, { description: 'Un hombre.' })).toBe(false);
    expect((cardIn('es', door, { description: '' }) as DoorCard).description).toBe(door.description);
  });

  it('never puts the family’s own words through the phrasebook, even when they read like one of Wick’s sentences', () => {
    const lookalike: MessageCard = { ...note, transcript: 'Not now' };
    expect((cardIn('es', lookalike) as MessageCard).transcript).toBe('Not now');
    const echo: MessageCard = { ...note, transcript: 'A wave to you from Sarah’s television.' };
    expect((cardIn('es', echo) as MessageCard).transcript).toBe('A wave to you from Sarah’s television.');
    const described: DoorCard = { ...door, description: 'Someone\'s at the front door.' };
    expect((cardIn('es', described) as DoorCard).description).toBe("Someone's at the front door.");
    const weekly: WeekCard = { ...week, text: 'Nobody has answered yet.' };
    expect((cardIn('es', weekly) as WeekCard).text).toBe('Nobody has answered yet.');
  });

  it('translates a note’s replies one by one: they are the fixed catalogue, and what travels back is still which button', () => {
    expect((cardIn('es', note) as MessageCard).suggestedReplies).toEqual(['Sí, por favor.', 'Mejor otro día.', 'Ahora mismo no.']);
    const mixed: MessageCard = { ...note, suggestedReplies: ['Yes, please do.', 'Bring cake.', 'Not right now.'] };
    expect((cardIn('es', mixed) as MessageCard).suggestedReplies).toEqual(['Sí, por favor.', 'Bring cake.', 'Ahora mismo no.']);
  });

  it('a wave’s sentence is Wick’s: it is translated by the phrasebook, and no translation handed in replaces it', () => {
    const shown = cardIn('es', wave, { transcript: 'Una traducción de máquina.' }) as MessageCard;
    expect(shown.transcript).toBe('Un saludo con la mano para usted, desde el televisor de Sarah.');
    expect(shown.suggestedReplies).toEqual(['Devolver el saludo', 'Ahora no']);
  });

  it('leaves a sentence it does not hold in English, whole, and translates the rest of the card', () => {
    const odd: TellCard = { ...tell, detail: 'Maria usually comes on Friday mornings. Something Wick has never said.' };
    const shown = cardIn('es', odd) as TellCard;
    expect(shown.detail).toBe(odd.detail);
    expect(shown.headline).toBe('¿Se lo digo a Sarah?');
  });

  it('returns the Language card as it is: it is already in both languages', () => {
    const card: LanguageCard = { ...base, type: 'LANGUAGE', id: languageCardId('es'), language: 'es', ...languageQuestion('es', 'Sarah') };
    expect(cardIn('es', card)).toBe(card);
    const back: LanguageCard = { ...base, type: 'LANGUAGE', id: languageCardId('en'), language: 'en', ...languageQuestion('en', 'Sarah') };
    expect(cardIn('es', back, { transcript: 'x' })).toBe(back);
  });

  it('returns a card of a kind it does not know unchanged, and never throws', () => {
    const unknown = { ...base, type: 'HOLOGRAM', id: 'h-1', headline: 'Not now', actions: [{ id: 'ok', label: 'OK', kind: 'primary' }] } as unknown as Card;
    expect(cardIn('es', unknown)).toBe(unknown);
    for (const broken of [undefined, null, 7, 'card', {}, { type: 'DOOR' }, { type: 'MESSAGE', suggestedReplies: 'no' }, { type: 'TELL', actions: [null, 7, { id: 'x' }] }]) {
      expect(() => cardIn('es', broken as unknown as Card)).not.toThrow();
    }
    expect(cardIn('es', { type: 'TELL', actions: [null, { id: 'x' }], headline: 7 } as unknown as Card)).toEqual({ type: 'TELL', actions: [null, { id: 'x' }], headline: 7 });
  });

  it('does not change the card it was given', () => {
    const before = structuredClone(tell);
    cardIn('es', tell, { transcript: 'x' });
    expect(tell).toEqual(before);
  });
});

describe('patchIn — the same for a patch to a card already on her television', () => {
  it('translates the corrected headline, the notice and the buttons’ labels', () => {
    const patch: CardPatch = {
      cardId: 'door-abc',
      line: 'Movement at the front door.',
      notice: "Sarah says: Please don't open the door. I'll ring you now.",
      imageRef: 'https://download.example/frame.jpg',
      actions: [
        { id: 'watch_live', label: 'Watch live', kind: 'primary' },
        { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
      ],
    };
    expect(patchIn('es', patch)).toEqual({
      cardId: 'door-abc',
      line: 'Movimiento en la puerta de entrada.',
      notice: 'Sarah dice: Por favor, no abra la puerta. Ahora mismo llamo por teléfono.',
      imageRef: 'https://download.example/frame.jpg',
      actions: [
        { id: 'watch_live', label: 'Ver en vivo', kind: 'primary' },
        { id: 'dismiss', label: 'Ahora no', kind: 'dismiss' },
      ],
    });
  });

  it('changes the description only by the translation handed in', () => {
    const patch: CardPatch = { cardId: 'door-abc', description: 'Three cars parked in a parking lot.', line: 'The doorbell rang.' };
    expect(patchIn('es', patch)).toEqual({ cardId: 'door-abc', description: 'Three cars parked in a parking lot.', line: 'Ha sonado el timbre.' });
    expect(patchIn('es', patch, { description: 'Tres coches en un aparcamiento.' }).description).toBe('Tres coches en un aparcamiento.');
    expect(patchIn('es', patch, { transcript: 'x', text: 'y' }).description).toBe('Three cars parked in a parking lot.');
    expect('description' in patchIn('es', { cardId: 'door-abc' }, { description: 'x' })).toBe(false);
  });

  it('adds nothing a patch did not carry, and never throws', () => {
    expect(patchIn('es', { cardId: 'door-abc' })).toEqual({ cardId: 'door-abc' });
    expect(patchIn('es', { cardId: 'door-abc', notice: 'A sentence Wick has never said.' })).toEqual({ cardId: 'door-abc', notice: 'A sentence Wick has never said.' });
    for (const broken of [undefined, null, 7, {}, { actions: 'no' }]) expect(() => patchIn('es', broken as unknown as CardPatch)).not.toThrow();
  });
});

describe('homeIn — what the home screen is told', () => {
  const home: HomeState = { light: 'on', lookedIn: { name: 'Sarah', at: 1_790_900_000_000, line: 'Sarah looked in this morning.', until: 1_790_950_000_000 }, language: 'es' };

  it('translates the one sentence, and nothing else', () => {
    expect(homeIn('es', home)).toEqual({ ...home, lookedIn: { ...home.lookedIn, line: 'Sarah ha preguntado por usted esta mañana.' } });
  });

  it('leaves a home screen with no look as it is, and a line it does not hold in English', () => {
    const quiet: HomeState = { light: 'out', lightOutUntil: 1_790_950_000_000 };
    expect(homeIn('es', quiet)).toEqual(quiet);
    expect(homeIn('es', {})).toEqual({});
    const odd: HomeState = { lookedIn: { name: 'Sarah', at: 1, line: 'Sarah waved at the window.' } };
    expect(homeIn('es', odd)).toEqual(odd);
    for (const broken of [undefined, null, 7, { lookedIn: 7 }, { lookedIn: { line: 7 } }]) expect(() => homeIn('es', broken as unknown as HomeState)).not.toThrow();
  });
});
