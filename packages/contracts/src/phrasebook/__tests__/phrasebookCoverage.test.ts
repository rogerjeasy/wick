/**
 * Everything the contracts' own builders write for her television is in the
 * phrasebook: the Reach card in every state (reach.ts), the Visit card
 * (visit.ts), the sentence on the home screen (light.ts), and the answers a
 * family member can choose that are shown to her under their name (door.ts,
 * reach.ts, watch.ts).
 *
 * The real builders are run, and what they write is put through `cardIn`.
 */
import { describe, expect, it } from 'vitest';
import {
  DOOR_ANSWERS,
  MAX_CARD_DETAIL_CHARS,
  REACH_ANSWERS,
  WATCH_ANSWERS,
  WATCH_QUESTION,
  buildReachAskCard,
  buildReachCard,
  buildVisitCard,
  cardIn,
  disputedSentence,
  homeIn,
  languageCardId,
  languageQuestion,
  lookedInWords,
  patchIn,
  sayIn,
  visitSentence,
  type Card,
  type LanguageCard,
  type ReachCard,
  type ReachPerson,
  type ReachRequest,
  type Visit,
  type VisitCard,
} from '../../index.js';
import { COVERED_IN, cardTypesInTheUnion, coverageOf } from './support.js';

const coverage = coverageOf('contracts', { cardIn, patchIn });
const LONDON = 'Europe/London';
/** Tuesday 13 October 2026, 15:00 in London (BST). */
const NOW = Date.UTC(2026, 9, 13, 14, 0);
const REACH_ID = String(NOW);
const MIN = 60_000;
const DAY = 86_400_000;

const person = (name: string, role: ReachPerson['role'] = 'family'): ReachPerson => ({ userId: `u_${name.toLowerCase().replace(/\W+/g, '_')}`, name, role });
const sarah = person('Sarah Hughes', 'organiser');
const david = person('David');
const anne = person('Anne-Marie');
const tom = person('Tom Next-Door', 'neighbour');

const request = (over: Partial<ReachRequest> = {}): ReachRequest => ({ householdId: 'hh-1', reachId: REACH_ID, kind: 'ring', askedAt: NOW, order: [sarah, david, tom], asked: 1, ...over });

const reach = (card: { card: Card }): ReachCard => {
  if (card.card.type !== 'REACH') throw new Error('not a reach card');
  return coverage.spanish(card.card);
};
const words = (card: ReachCard | VisitCard) => ({ headline: card.headline, ...(card.detail === undefined ? {} : { detail: card.detail }), labels: card.actions.map((a) => a.label) });

describe('the card her hold brings (reach.ts buildReachAskCard)', () => {
  it('offers to ask the first person in her circle, and says what Wick does not do', () => {
    expect(words(reach(buildReachAskCard({ householdId: 'hh-1', reachId: REACH_ID, first: sarah, now: NOW })))).toEqual({
      headline: '¿Pedir a Sarah que le llame?',
      detail: 'A Sarah solo se le dirá que usted desea una llamada. Wick no llama para pedir ayuda: en una emergencia, use el teléfono.',
      labels: ['Sí, pedírselo a Sarah', 'Solo saludar', 'No, ahora no'],
    });
  });

  it('whatever the first name is', () => {
    for (const name of ['Anne-Marie', 'O’Brien', "D'Arcy", 'José', 'Zoë Smith', 'Bartholomew-Fitzgerald24', 'X Æ A-12']) {
      const card = reach(buildReachAskCard({ householdId: 'hh-1', reachId: REACH_ID, first: person(name), now: NOW }));
      const first = name.split(' ')[0]!;
      expect(card.headline).toBe(`¿Pedir a ${first} que le llame?`);
      expect(card.actions[0]!.label).toBe(`Sí, pedírselo a ${first}`);
      expect(card.detail!.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
    }
  });

  it('says so when there is nobody to ask', () => {
    expect(words(reach(buildReachAskCard({ householdId: 'hh-1', reachId: REACH_ID, now: NOW })))).toEqual({
      headline: 'Ahora mismo no hay nadie a quien Wick pueda pedírselo.',
      detail: 'Cuando haya aceptado a alguien en su círculo familiar, podrá pedirle aquí que le llame.',
      labels: ['De acuerdo'],
    });
  });
});

describe('the card as a request stands (reach.ts buildReachCard)', () => {
  it('one person asked, and who is next', () => {
    expect(words(reach(buildReachCard(request(), NOW)))).toEqual({
      headline: 'Se ha pedido a Sarah que le llame.',
      detail: 'Si Sarah no ha respondido en tres minutos, Wick se lo pedirá a David.',
      labels: ['De acuerdo'],
    });
  });

  it('one person asked, and nobody after them', () => {
    expect(words(reach(buildReachCard(request({ order: [sarah] }), NOW)))).toEqual({
      headline: 'Se ha pedido a Sarah que le llame.',
      detail: 'Wick se lo dirá aquí cuando Sarah responda.',
      labels: ['De acuerdo'],
    });
  });

  it('a second person asked: the first has not answered, and who is next', () => {
    expect(words(reach(buildReachCard(request({ asked: 2 }), NOW)))).toEqual({
      headline: 'También se ha pedido a David que le llame.',
      detail: 'Sarah todavía no ha respondido. Si nadie ha respondido en tres minutos, Wick se lo pedirá a Tom.',
      labels: ['De acuerdo'],
    });
  });

  it('the last person asked: the others have not answered', () => {
    expect(words(reach(buildReachCard(request({ asked: 3 }), NOW)))).toEqual({
      headline: 'También se ha pedido a Tom que le llame.',
      detail: 'Sarah y David todavía no han respondido. Wick se lo dirá aquí cuando alguien responda.',
      labels: ['De acuerdo'],
    });
    expect(reach(buildReachCard(request({ order: [sarah, david, anne, tom], asked: 4 }), NOW)).detail).toBe(
      'Sarah, David y Anne-Marie todavía no han respondido. Wick se lo dirá aquí cuando alguien responda.',
    );
  });

  it('a hello', () => {
    expect(words(reach(buildReachCard(request({ kind: 'hello', order: [sarah] }), NOW)))).toEqual({
      headline: 'Se le ha dicho a Sarah que usted manda saludos.',
      labels: ['De acuerdo'],
    });
  });

  it('every answer a person can choose, under their name', () => {
    const spanish: Record<keyof typeof REACH_ANSWERS, string> = {
      now: 'Sarah dice: Ya estoy llamando por teléfono.',
      soon: 'Sarah dice: Llamaré por teléfono en menos de una hora.',
      hello: 'Sarah dice: Hola, igualmente.',
    };
    for (const key of Object.keys(REACH_ANSWERS) as (keyof typeof REACH_ANSWERS)[]) {
      const kind = key === 'hello' ? 'hello' : 'ring';
      const card = reach(buildReachCard(request({ kind, answer: { key, by: sarah.userId, byName: 'Sarah Hughes', at: NOW } }), NOW));
      expect(words(card)).toEqual({ headline: spanish[key], labels: ['Gracias'] });
    }
  });

  it('everyone asked and nobody has answered: one person, and several', () => {
    expect(words(reach(buildReachCard(request({ order: [sarah], doneAt: NOW }), NOW)))).toEqual({
      headline: 'Todavía no ha respondido nadie.',
      detail: 'Ya se le ha pedido a Sarah, y todavía puede responder. Wick se lo dirá aquí si Sarah responde.',
      labels: ['De acuerdo'],
    });
    expect(reach(buildReachCard(request({ asked: 3, doneAt: NOW }), NOW)).detail).toBe(
      'Ya se les ha pedido a Sarah, David y Tom, y todavía pueden responder. Wick se lo dirá aquí si alguien responde.',
    );
  });

  it('the shorter wordings the builder falls back to when the names would not fit', () => {
    const many = Array.from({ length: 9 }, (_, i) => person(`Bartholomew-Fitzgerald${String(i).padStart(2, '0')}`));

    const done = buildReachCard(request({ order: many, asked: 9, doneAt: NOW }), NOW);
    expect((done.card as ReachCard).detail).toBe('Everyone Wick can ask has been asked, and can still answer. Wick will tell you here if one of them does.');
    expect(reach(done).detail).toBe('Wick ya se lo ha pedido a todos los que puede, y todavía pueden responder. Wick se lo dirá aquí si alguien responde.');

    const asWell = buildReachCard(request({ order: many, asked: 9 }), NOW);
    expect((asWell.card as ReachCard).detail).toBe('Nobody asked before Bartholomew-Fitzgerald08 has answered yet. Wick will tell you here when somebody answers.');
    expect(reach(asWell).detail).toBe(
      'De las personas a quienes se pidió antes que a Bartholomew-Fitzgerald08, ninguna ha respondido todavía. Wick se lo dirá aquí cuando alguien responda.',
    );

    const wide = Array.from({ length: 4 }, (_, i) => person(`${'W'.repeat(80)}${i}`));
    const last = buildReachCard(request({ order: wide, asked: 3 }), NOW);
    expect((last.card as ReachCard).detail).toBe('Nobody has answered yet.');
    expect(reach(last).detail).toBe('Todavía no ha respondido nadie.');
  });

  it('never leaves a state in English, and never writes past the card, for circles of one to nine and names up to twenty-four characters', () => {
    for (const length of [3, 5, 12, 24]) {
      for (let size = 1; size <= 9; size += 1) {
        const order = Array.from({ length: size }, (_, i) => person(`${'N'.repeat(length - 1)}${i}`));
        for (let asked = 1; asked <= size; asked += 1) {
          for (const doneAt of [undefined, NOW]) {
            const built = buildReachCard(request({ order, asked, ...(doneAt === undefined ? {} : { doneAt }) }), NOW);
            const card = reach(built);
            expect(card.headline.length, card.headline).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
            expect(card.detail!.length, `${(built.card as ReachCard).detail} → ${card.detail}`).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
          }
        }
      }
    }
  });
});

describe('the visit, put to her (visit.ts buildVisitCard)', () => {
  /** Tuesday 13 October 2026: 9:02 and 9:47 in London. */
  const arrivedAt = Date.UTC(2026, 9, 13, 8, 2);
  const visit = (over: Partial<Visit> = {}): Visit => ({ householdId: 'hh-1', personId: 'maria', name: 'Maria', arrivedAt, leftAt: arrivedAt + 45 * MIN, ...over });
  const shown = (v: Visit): VisitCard => {
    const built = buildVisitCard(v, LONDON, NOW).card;
    if (built.type !== 'VISIT') throw new Error('not a visit card');
    return coverage.spanish(built);
  };

  it('asks whether what the door noted is right, with the day and both times', () => {
    expect(words(shown(visit()))).toEqual({
      headline: '¿Es correcto?',
      detail: 'Maria estuvo aquí el martes de 9:02 a 9:47.',
      labels: ['Sí, es correcto', 'No, no es correcto'],
    });
  });

  it('says only when they came, when nobody was seen leaving', () => {
    const { leftAt: _none, ...came } = visit();
    expect(shown(came).detail).toBe('Maria vino el martes a las 9:02.');
  });

  it('on every day of the week, morning, afternoon and night', () => {
    const days = ['martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo', 'lunes'];
    days.forEach((day, i) => {
      expect(shown(visit({ arrivedAt: arrivedAt + i * DAY, leftAt: arrivedAt + i * DAY + 45 * MIN })).detail).toBe(`Maria estuvo aquí el ${day} de 9:02 a 9:47.`);
    });
    // 13:15 to 14:05, and five past midnight to one.
    const afternoon = Date.UTC(2026, 9, 13, 12, 15);
    expect(shown(visit({ arrivedAt: afternoon, leftAt: afternoon + 50 * MIN })).detail).toBe('Maria estuvo aquí el martes de 13:15 a 14:05.');
    const midnight = Date.UTC(2026, 9, 12, 23, 5);
    expect(shown(visit({ arrivedAt: midnight, leftAt: midnight + 55 * MIN })).detail).toBe('Maria estuvo aquí el martes de 0:05 a 1:00.');
    const { leftAt: _none, ...atOne } = visit({ arrivedAt: Date.UTC(2026, 9, 13, 0, 20) });
    expect(shown(atOne).detail).toBe('Maria vino el martes a la 1:20.');
  });

  it('whoever the visitor is, as the roster names them', () => {
    for (const name of ['Dr. Patel', 'Anne-Marie O’Brien', 'José', "Nurse D'Arcy", 'Tuesday', 'Bartholomew-Fitzgerald24']) {
      expect(shown(visit({ name })).detail).toBe(`${name} estuvo aquí el martes de 9:02 a 9:47.`);
    }
  });

  it('holds the sentence the family would be told if she says it is not right (shown to her first, on the Tell card)', () => {
    expect(visitSentence(visit(), LONDON)).toBe('Maria was here on Tuesday from 9:02 am to 9:47 am.');
    expect(sayIn('es', disputedSentence(visit(), LONDON))).toBe('Wick anotó que Maria estuvo aquí el martes de 9:02 a 9:47. Eso no es correcto.');
    const { leftAt: _none, ...came } = visit({ name: 'Dr. Patel' });
    expect(sayIn('es', disputedSentence(came, LONDON))).toBe('Wick anotó que Dr. Patel vino el martes a las 9:02. Eso no es correcto.');
  });
});

describe('who looked in (light.ts lookedInWords)', () => {
  it('in the morning, the afternoon and the evening, where the house is', () => {
    const at = (hourUtc: number): number => Date.UTC(2026, 9, 13, hourUtc, 30);
    expect(sayIn('es', lookedInWords('Sarah', at(8), LONDON))).toBe('Sarah ha preguntado por usted esta mañana.');
    expect(sayIn('es', lookedInWords('Anne-Marie', at(13), LONDON))).toBe('Anne-Marie ha preguntado por usted esta tarde.');
    expect(sayIn('es', lookedInWords('José', at(19), LONDON))).toBe('José ha preguntado por usted esta noche.');
  });

  it('on the home screen', () => {
    const line = lookedInWords('Sarah', NOW, LONDON);
    expect(homeIn('es', { light: 'on', lookedIn: { name: 'Sarah', at: NOW, line } })).toEqual({ light: 'on', lookedIn: { name: 'Sarah', at: NOW, line: 'Sarah ha preguntado por usted esta tarde.' } });
  });
});

describe('the answers a family member chooses, as she reads them under their name', () => {
  it('about who is at the door (door.ts DOOR_ANSWERS, shown as a notice on the door card)', () => {
    const spanish: Record<keyof typeof DOOR_ANSWERS, string> = {
      known: 'Sarah dice: Está bien, sé quién es.',
      dont_open: 'Sarah dice: Por favor, no abra la puerta. Ahora mismo llamo por teléfono.',
      not_sure: 'Sarah dice: No distingo quién es. Ahora mismo llamo por teléfono.',
    };
    for (const key of Object.keys(DOOR_ANSWERS) as (keyof typeof DOOR_ANSWERS)[]) {
      expect(coverage.spanishPatch({ cardId: 'door-abc', notice: `Sarah says: ${DOOR_ANSWERS[key]}` }).notice).toBe(spanish[key]);
    }
  });

  it('about the film, and her own three answers to the same question (watch.ts)', () => {
    expect(sayIn('es', WATCH_QUESTION)).toBe('¿Qué le pareció?');
    const spanish: Record<keyof typeof WATCH_ANSWERS, string> = { loved_it: 'Me encantó.', all_right: 'Estuvo bien.', not_for_me: 'No fue muy de mi gusto.' };
    for (const key of Object.keys(WATCH_ANSWERS) as (keyof typeof WATCH_ANSWERS)[]) {
      expect(sayIn('es', WATCH_ANSWERS[key])).toBe(spanish[key]);
      expect(sayIn('es', `Sarah says: “${WATCH_ANSWERS[key]}”`)).toBe(`Sarah dice: “${spanish[key]}”`);
    }
  });
});

describe('the Language card', () => {
  it('is never passed through the phrasebook: it is how she comes to have one', () => {
    for (const language of ['es', 'en'] as const) {
      const card: LanguageCard = { type: 'LANGUAGE', id: languageCardId(language), householdId: 'hh-1', correlationId: 'c-1', createdAt: NOW, language, ...languageQuestion(language, 'Sarah') };
      expect(coverage.spanish(card)).toBe(card);
    }
  });
});

describe('no kind of card can be forgotten', () => {
  it('every card in the union is proved somewhere', () => {
    expect(cardTypesInTheUnion().sort()).toEqual(Object.keys(COVERED_IN).sort());
    for (const [type, where] of Object.entries(COVERED_IN)) expect(where.length, type).toBeGreaterThan(0);
  });

  it('and every kind the contracts build was put through here', () => {
    expect(coverage.missing()).toEqual([]);
  });
});
