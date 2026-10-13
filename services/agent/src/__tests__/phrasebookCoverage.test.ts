/**
 * Everything the agent plane writes for her television is in the
 * phrasebook: the door card and every patch to it, "Shall I tell Sarah?"
 * with every sentence the detector can write, the visit and what follows
 * her "No", the request to be rung in every state, and the Week card's two
 * buttons.
 *
 * The real builders and handlers are run, and what they send is put through
 * `cardIn` / `patchIn` (packages/contracts phrasebook/).
 */
import { describe, expect, it } from 'vitest';
import {
  REACH_ACTIONS,
  VISIT_ACTIONS,
  VISIT_SETTLED_MS,
  cardIn,
  patchIn,
  reachCardId,
  sayIn,
  visitCardId,
  visitId,
  type Card,
  type CardPatch,
  type DoorCard,
  type QueuedCard,
  type ReachCard,
  type ReachPerson,
  type ReachRequest,
  type RosterEntry,
  type TellCard,
  type TimelineEntry,
  type Visit,
  type VisitCard,
  type WeekCard,
  type WeekNarrative,
} from '@wick/contracts';
import type { RingDevice, RingHistoryEvent } from '@wick/ring';
import { COVERED_IN, cardTypesInTheUnion, coverageOf } from '../../../../packages/contracts/src/phrasebook/__tests__/support.js';
import { CHIME_NOTICE, chimePatch, type ChimeResult } from '../agents/door/actions.js';
import { handleAskFamily, type FamilyMember } from '../agents/door/askFamily.js';
import { NOBODY_AFTER_MOTION_LINE, NOBODY_AFTER_RING_LINE, buildDescriptionPatch, buildImagePatch, buildPhaseOneCard } from '../agents/door/index.js';
import { buildWeekCard, familyNameForWeekCard } from '../agents/narrator/weekCard.js';
import { handleReachAsk } from '../agents/reach/ask.js';
import { handleReachDue } from '../agents/reach/due.js';
import { askAboutDifferences, buildTellCard } from '../agents/tell/ask.js';
import { handleVisitAnswer } from '../agents/visit/answer.js';
import { askAboutVisits } from '../agents/visit/ask.js';
import { whatsDifferent, type DifferentInput } from '../rhythm/different.js';

const coverage = coverageOf('agent', { cardIn, patchIn });
const LONDON = 'Europe/London';
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Friday 9 October 2026, midnight UTC. */
const FRIDAY = Date.UTC(2026, 9, 9);
const NOW = FRIDAY + 14 * HOUR;

const labels = (card: { readonly actions: readonly { readonly label: string }[] }): string[] => card.actions.map((a) => a.label);
const cardOf = <T extends Card['type']>(queued: QueuedCard | undefined, type: T): Extract<Card, { type: T }> => {
  if (queued?.card.type !== type) throw new Error(`not a ${type} card`);
  return queued.card as Extract<Card, { type: T }>;
};

describe('the door card (agents/door/index.ts)', () => {
  const device: RingDevice = { id: 'ava1.ring.device.ABNJQ', name: 'Front Door', online: true, capabilities: { motion: true, image: true, chime: false } };
  const event: RingHistoryEvent = { id: 'ava1.ring.history.event.XWRR', deviceId: device.id, start: FRIDAY + 9 * HOUR, end: FRIDAY + 9 * HOUR + 11_000, eventType: 'ding', detections: [] };
  const phaseOne = (over: { hallwayChime?: boolean; family?: readonly string[]; roster?: readonly RosterEntry[] } = {}): DoorCard =>
    buildPhaseOneCard({ event, device, hallwayChime: over.hallwayChime ?? false, householdId: 'hh-1', correlationId: 'corr-1', now: NOW, ...(over.family ? { family: over.family } : {}), ...(over.roster ? { roster: over.roster } : {}) });

  it('says someone is at the door, and offers to ask the one person she allows', () => {
    const card = coverage.spanish(phaseOne({ family: ['Sarah Hughes'], hallwayChime: true }));
    expect(card.line).toBe('Hay alguien en la puerta de entrada.');
    expect(labels(card)).toEqual(['Ver en vivo', 'Pedir a Sarah que mire', 'Ahora no']);
  });

  it('whatever that person is called, and "the family" when it is several or the name is too long for a button', () => {
    for (const name of ['Anne-Marie', 'O’Brien', "D'Arcy", 'José']) {
      expect(labels(coverage.spanish(phaseOne({ family: [name] })))[1]).toBe(`Pedir a ${name} que mire`);
    }
    expect(labels(coverage.spanish(phaseOne({ family: ['Sarah', 'David'] })))[1]).toBe('Pedir a la familia que mire');
    expect(labels(coverage.spanish(phaseOne({ family: ['Bartholomew-Fitzgerald24'] })))[1]).toBe('Pedir a la familia que mire');
  });

  it('offers the hallway chime when there is nobody to ask, and only the way out when there is neither', () => {
    expect(labels(coverage.spanish(phaseOne({ hallwayChime: true })))).toEqual(['Ver en vivo', 'Tocar timbre del pasillo', 'Ahora no']);
    expect(labels(coverage.spanish(phaseOne()))).toEqual(['Ver en vivo', 'Ahora no']);
  });

  it('for a visitor she expects, who is on the card by name and never translated', () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'FRI 09:00±30m' };
    const card = coverage.spanish(phaseOne({ roster: [maria], family: ['Sarah'], hallwayChime: true }));
    expect(card.match?.name).toBe('Maria');
    expect(labels(card)).toEqual(['Ver en vivo', 'Tocar timbre del pasillo', 'Ahora no']);
  });

  it('corrects the headline when the picture shows nobody, and leaves the description to be translated as free text', () => {
    const nobody = { description: 'Three cars parked in a parking lot.', confidence: 0.9, personVisible: false };
    const afterMotion = buildDescriptionPatch('door-abc', nobody, 'motion')!;
    const afterRing = buildDescriptionPatch('door-abc', nobody, 'button_press')!;
    expect([afterMotion.line, afterRing.line]).toEqual([NOBODY_AFTER_MOTION_LINE, NOBODY_AFTER_RING_LINE]);

    expect(coverage.spanishPatch(afterMotion)).toEqual({ cardId: 'door-abc', description: nobody.description, line: 'Movimiento en la puerta de entrada.' });
    expect(coverage.spanishPatch(afterRing).line).toBe('Ha sonado el timbre.');
    expect(patchIn('es', afterRing, { description: 'Tres coches en un aparcamiento.' }).description).toBe('Tres coches en un aparcamiento.');
  });

  it('a description alone, or the picture, carries no word of Wick’s and is left exactly as it is', () => {
    const described = buildDescriptionPatch('door-abc', { description: 'A man in a yellow jacket holding a clipboard.', confidence: 0.9, personVisible: true })!;
    expect(patchIn('es', described)).toEqual(described);
    const picture = buildImagePatch('door-abc', { url: 'https://download.example/frame.jpg?sig=abc' } as Parameters<typeof buildImagePatch>[1]);
    expect(patchIn('es', picture)).toEqual(picture);
  });

  const queued = (card: DoorCard): QueuedCard => ({ id: card.id, urgency: 'DOOR', queuedAt: NOW, expiresAt: NOW + 5 * MIN, shownCount: 1, card });

  it('says what the hallway chime did, whatever it did (agents/door/actions.ts)', () => {
    const spanish: Record<ChimeResult, string> = {
      rang: 'Ha sonado el timbre del pasillo.',
      snoozed: 'El timbre del pasillo está silenciado, así que no ha sonado.',
      offline: 'El timbre del pasillo no ha respondido.',
      failed: 'El timbre del pasillo no ha respondido.',
      no_audio: 'El timbre del pasillo no tiene ningún sonido configurado para Wick.',
      no_chime: 'No hay ningún timbre del pasillo al que Wick tenga acceso.',
    };
    for (const result of Object.keys(CHIME_NOTICE) as ChimeResult[]) {
      const patch = coverage.spanishPatch(chimePatch(queued(phaseOne({ hallwayChime: true })), result));
      expect(patch.notice, result).toBe(spanish[result]);
      expect(patch.actions!.map((a) => a.label)).toEqual(['Ver en vivo', 'Ahora no']);
    }
  });

  async function askedToLook(family: readonly FamilyMember[], offered: readonly string[]): Promise<CardPatch> {
    const patches: CardPatch[] = [];
    const door = queued(phaseOne({ family: offered }));
    await handleAskFamily(
      { householdId: 'hh-1', deviceId: 'tv-1', cardId: door.id, action: 'ask_family', at: NOW },
      { loadCard: async () => door, listFamily: async () => family, claimOnce: async () => true, sendPatch: async (patch) => void patches.push(patch), nudge: async () => undefined, now: () => NOW },
    );
    expect(patches).toHaveLength(1);
    return coverage.spanishPatch(patches[0]!);
  }

  it('says who was asked to look, or that there is nobody to ask (agents/door/askFamily.ts)', async () => {
    const sarah = { userId: 'u_sarah', name: 'Sarah Hughes' };
    expect(await askedToLook([sarah], ['Sarah'])).toMatchObject({ notice: 'Se ha pedido a Sarah que mire.' });
    expect(await askedToLook([{ userId: 'u_anne', name: 'Anne-Marie O’Brien' }], ['Anne-Marie'])).toMatchObject({ notice: 'Se ha pedido a Anne-Marie que mire.' });
    const several = await askedToLook([sarah, { userId: 'u_david', name: 'David' }], ['Sarah', 'David']);
    expect(several.notice).toBe('Se ha pedido a la familia que mire.');
    expect(several.actions!.map((a) => a.label)).toEqual(['Ver en vivo', 'Ahora no']);
    expect((await askedToLook([], ['Sarah'])).notice).toBe('Ahora mismo no hay nadie a quien Wick pueda pedírselo.');
  });
});

describe('"Shall I tell Sarah?" (agents/tell/ask.ts, with the detector’s own sentences from rhythm/different.ts)', () => {
  const visit = (when: number, personId: string, name: string): TimelineEntry => ({ at: when, kind: 'visit', summary: `${name} visited.`, personId });
  const door = (when: number): TimelineEntry => ({ at: when, kind: 'door', summary: 'Someone was at the front door.' });
  const input = (over: Partial<DifferentInput>): DifferentInput => ({ entries: [], roster: [], now: NOW, observedSince: FRIDAY - 8 * WEEK, timeZone: LONDON, ...over });

  async function asked(found: DifferentInput, family: readonly string[] = ['Sarah Hughes']): Promise<TellCard[]> {
    const sent: QueuedCard[] = [];
    let n = 0;
    await askAboutDifferences('hh-1', {
      loadDifferences: async () => whatsDifferent(found),
      listFamily: async () => family.map((name, i) => ({ userId: `u_${i}`, name })),
      claimOnce: async () => true,
      release: async () => undefined,
      sendCard: async (card) => void sent.push(card),
      now: () => found.now,
      newCorrelationId: () => `corr-${(n += 1)}`,
    });
    return sent.map((card) => coverage.spanish(cardOf(card, 'TELL')));
  }

  it('asks, shows the very sentence, and offers to tell or to keep it', async () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' };
    const entries = [1, 2, 3, 4, 5, 6].flatMap((k) => [visit(FRIDAY - k * WEEK + 9 * HOUR, 'maria', 'Maria'), visit(FRIDAY - 3 * DAY - k * WEEK + 9 * HOUR, 'maria', 'Maria')]);
    const [card] = await asked(input({ roster: [maria], entries: [...entries, visit(FRIDAY - 3 * DAY + 9 * HOUR, 'maria', 'Maria')] }));

    expect(card).toMatchObject({
      headline: '¿Se lo digo a Sarah?',
      detail: 'Maria suele venir los viernes por la mañana. El viernes no hubo visita.',
    });
    expect(labels(card!)).toEqual(['Decírselo a Sarah', 'Me lo guardo']);
  });

  it('speaks of "the family" when several people would be told', async () => {
    const [card] = await asked(input({ entries: [door(FRIDAY + 70 * MIN)], now: FRIDAY + 8 * HOUR }), ['Sarah', 'David']);
    expect(card!.headline).toBe('¿Se lo digo a la familia?');
    expect(labels(card!)).toEqual(['Decírselo a la familia', 'Me lo guardo']);
  });

  it('a regular visitor who did not come: every weekday, and every part of the day the detector names', async () => {
    const codes = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const days = ['los domingos', 'los lunes', 'los martes', 'los miércoles', 'los jueves', 'los viernes', 'los sábados'];
    const on = ['El domingo', 'El lunes', 'El martes', 'El miércoles', 'El jueves', 'El viernes', 'El sábado'];
    const hours: readonly (readonly [number, string])[] = [[9, 'por la mañana'], [14, 'por la tarde'], [18, 'a última hora de la tarde'], [22, 'por la noche']];
    for (let d = 0; d < 7; d += 1) {
      for (const [hour, part] of hours) {
        const day = FRIDAY + (d - 5) * DAY;
        const who: RosterEntry = { personId: 'dr-patel', name: 'Dr. Patel', expectedPattern: `${codes[d]} ${String(hour).padStart(2, '0')}:00±30m` };
        const entries = [1, 2, 3, 4, 5, 6].map((k) => visit(day - k * WEEK + hour * HOUR, 'dr-patel', 'Dr. Patel'));
        const cards = await asked(input({ roster: [who], entries, now: day + (hour + 3) * HOUR, observedSince: day - 8 * WEEK }));
        expect(cards.map((card) => card.detail), `${codes[d]} ${hour}`).toEqual([`Dr. Patel suele venir ${days[d]} ${part}. ${on[d]} no hubo visita.`]);
      }
    }
  });

  it('somebody at the door in the night', async () => {
    // Ten past two in the morning in London, which in October is ten past one UTC.
    const [card] = await asked(input({ entries: [door(FRIDAY + 70 * MIN)], now: FRIDAY + 8 * HOUR }));
    expect(card!.detail).toBe('Alguien vino a la puerta por la noche, el viernes a las 2:10. En las 6 semanas anteriores no había venido nadie por la noche.');
    // Ten past one in the morning: "la una".
    const [atOne] = await asked(input({ entries: [door(FRIDAY + 10 * MIN)], now: FRIDAY + 8 * HOUR }));
    expect(atOne!.detail).toBe('Alguien vino a la puerta por la noche, el viernes a la 1:10. En las 6 semanas anteriores no había venido nadie por la noche.');
  });

  const usualFridays = (perFriday: number): TimelineEntry[] => [1, 2, 3, 4, 5, 6].flatMap((k) => Array.from({ length: perFriday }, (_, i) => door(FRIDAY - k * WEEK + (9 + i) * HOUR)));

  it('a quiet door: nobody, and fewer than usual', async () => {
    expect((await asked(input({ entries: usualFridays(3) })))[0]!.detail).toBe(
      'El viernes, a las 15:00, todavía no había venido nadie a la puerta. Un viernes a esa hora, lo habitual es alrededor de 3.',
    );
    expect((await asked(input({ entries: [...usualFridays(4), door(FRIDAY + 9 * HOUR)] })))[0]!.detail).toBe(
      'El viernes, hasta las 15:00, había venido a la puerta menos gente de lo habitual: 1. Un viernes a esa hora, lo habitual es alrededor de 4.',
    );
  });

  it('a busy door', async () => {
    const today = [9, 10, 11, 12, 13].map((h) => door(FRIDAY + h * HOUR));
    expect((await asked(input({ entries: [...usualFridays(1), ...today] })))[0]!.detail).toBe(
      'El viernes hubo más movimiento de lo habitual en la puerta: 5 personas hasta las 15:00. Un viernes a esa hora, lo habitual es alrededor de 1.',
    );
  });

  it('a quiet or a busy door on any day of the week, at any hour', async () => {
    for (let d = 0; d < 7; d += 1) {
      for (const hour of [1, 11, 13, 23]) {
        const day = FRIDAY + d * DAY;
        const usual = [1, 2, 3, 4, 5, 6].flatMap((k) => [0, 1, 2].map((i) => door(day - k * WEEK + i * 10 * MIN)));
        const now = day + hour * HOUR + 30 * MIN;
        const quiet = await asked(input({ entries: usual, now, observedSince: day - 8 * WEEK }));
        const busy = await asked(input({ entries: [...usual, ...Array.from({ length: 9 }, (_, i) => door(day + 20 * MIN + i * MIN))], now, observedSince: day - 8 * WEEK }));
        // Each is one difference or more (the night has its own); every one of them is in Spanish, which `asked` has checked.
        expect(quiet.length + busy.length, `${d} ${hour}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe('the visit, witnessed (agents/visit/ask.ts, answer.ts)', () => {
  /** Tuesday 6 October 2026: 9:02 and 9:47 in London. */
  const arrivedAt = Date.UTC(2026, 9, 6, 8, 2);
  const maria: Visit = { householdId: 'hh-1', personId: 'maria', name: 'Maria', arrivedAt, leftAt: arrivedAt + 45 * MIN };
  const { leftAt: _unseen, ...neverSeenLeaving } = maria;

  async function askedAbout(visit: Visit, now: number): Promise<VisitCard> {
    const sent: QueuedCard[] = [];
    await askAboutVisits('hh-1', { recent: async () => [visit], claimAsk: async () => true, releaseAsk: async () => undefined, sendCard: async (card) => void sent.push(card), now: () => now, timeZone: LONDON });
    expect(sent).toHaveLength(1);
    return coverage.spanish(cardOf(sent[0], 'VISIT'));
  }

  it('asks her whether what the door noted is right', async () => {
    const card = await askedAbout(maria, maria.leftAt! + VISIT_SETTLED_MS);
    expect(card).toMatchObject({ headline: '¿Es correcto?', detail: 'Maria estuvo aquí el martes de 9:02 a 9:47.' });
    expect(labels(card)).toEqual(['Sí, es correcto', 'No, no es correcto']);
    expect((await askedAbout(neverSeenLeaving, arrivedAt + 5 * HOUR)).detail).toBe('Maria vino el martes a las 9:02.');
  });

  async function disputed(visit: Visit, who: string): Promise<TellCard> {
    const sent: QueuedCard[] = [];
    const id = visitId(visit);
    await handleVisitAnswer(
      { householdId: 'hh-1', deviceId: 'tv-1', cardId: visitCardId(id), action: VISIT_ACTIONS.wrong, at: NOW },
      {
        answer: async () => ({ ...visit, answer: 'disputed' }),
        withdraw: async () => undefined,
        whoToTell: async () => who,
        // As actionLambda.ts does it: the Tell card, with the sentence the family would be told.
        offerToTell: async (offer) => {
          sent.push(buildTellCard({ ...offer, correlationId: 'corr-1' }));
          return true;
        },
        now: () => NOW,
        timeZone: LONDON,
      },
    );
    expect(sent).toHaveLength(1);
    return coverage.spanish(cardOf(sent[0], 'TELL'));
  }

  it('her "No" becomes a question of the same kind, showing the very sentence that would be told', async () => {
    const card = await disputed(maria, 'Sarah');
    expect(card).toMatchObject({ headline: '¿Se lo digo a Sarah?', detail: 'Wick anotó que Maria estuvo aquí el martes de 9:02 a 9:47. Eso no es correcto.' });
    expect(labels(card)).toEqual(['Decírselo a Sarah', 'Me lo guardo']);
    expect((await disputed(neverSeenLeaving, 'the family')).detail).toBe('Wick anotó que Maria vino el martes a las 9:02. Eso no es correcto.');
  });
});

describe('the request to be rung, as the agent plane moves it on (agents/reach/ask.ts, due.ts)', () => {
  const REACH_ID = String(NOW);
  const circle: (ReachPerson & { since: number })[] = [
    { userId: 'u_sarah', name: 'Sarah Hughes', role: 'organiser', since: 1 },
    { userId: 'u_david', name: 'David', role: 'family', since: 2 },
    { userId: 'u_tom', name: 'Tom', role: 'neighbour', since: 3 },
  ];
  const press = (action: string) => ({ householdId: 'hh-1', deviceId: 'tv-1', cardId: reachCardId(REACH_ID), action, at: NOW });

  async function pressed(action: string, people: typeof circle): Promise<{ card: ReachCard; request: ReachRequest | undefined }> {
    const sent: QueuedCard[] = [];
    let request: ReachRequest | undefined;
    await handleReachAsk(press(action), {
      listCircle: async () => people,
      claimOnce: async (made) => {
        request = made;
        return true;
      },
      sendCard: async (card) => void sent.push(card),
      nudge: async () => undefined,
      schedule: async () => undefined,
      now: () => NOW,
    });
    expect(sent).toHaveLength(1);
    return { card: coverage.spanish(cardOf(sent[0], 'REACH')), request };
  }

  async function due(request: ReachRequest, people: typeof circle): Promise<ReachCard> {
    const sent: QueuedCard[] = [];
    await handleReachDue(
      { householdId: 'hh-1', reachId: request.reachId, step: request.asked },
      { load: async () => request, listCircle: async () => people, advance: async () => true, finish: async () => true, sendCard: async (card) => void sent.push(card), nudge: async () => undefined, schedule: async () => undefined, now: () => NOW + 3 * MIN },
    );
    expect(sent).toHaveLength(1);
    return coverage.spanish(cardOf(sent[0], 'REACH'));
  }

  it('her press, three minutes without an answer, three more, and nobody left to ask', async () => {
    const { card: first, request } = await pressed(REACH_ACTIONS.ring, circle);
    expect(first).toMatchObject({ headline: 'Se ha pedido a Sarah que le llame.', detail: 'Si Sarah no ha respondido en tres minutos, Wick se lo pedirá a David.' });

    const second = await due(request!, circle);
    expect(second).toMatchObject({ headline: 'También se ha pedido a David que le llame.', detail: 'Sarah todavía no ha respondido. Si nadie ha respondido en tres minutos, Wick se lo pedirá a Tom.' });

    const third = await due({ ...request!, asked: 2 }, circle);
    expect(third).toMatchObject({ headline: 'También se ha pedido a Tom que le llame.', detail: 'Sarah y David todavía no han respondido. Wick se lo dirá aquí cuando alguien responda.' });

    const exhausted = await due({ ...request!, asked: 3 }, circle);
    expect(exhausted).toMatchObject({
      headline: 'Todavía no ha respondido nadie.',
      detail: 'Ya se les ha pedido a Sarah, David y Tom, y todavía pueden responder. Wick se lo dirá aquí si alguien responde.',
    });
    expect(labels(exhausted)).toEqual(['De acuerdo']);
  });

  it('a hello, and a press when the person offered has since gone', async () => {
    expect((await pressed(REACH_ACTIONS.hello, circle)).card.headline).toBe('Se le ha dicho a Sarah que usted manda saludos.');
    expect((await pressed(REACH_ACTIONS.ring, [])).card).toMatchObject({
      headline: 'Ahora mismo no hay nadie a quien Wick pueda pedírselo.',
      detail: 'Cuando haya aceptado a alguien en su círculo familiar, podrá pedirle aquí que le llame.',
    });
  });
});

describe('the Week card (agents/narrator/weekCard.ts)', () => {
  const narrative: WeekNarrative = { householdId: 'hh-1', isoWeek: '2026-W41', text: 'A quiet week. Maria came on Tuesday and Friday.', deltas: [], timeline: [], generatedAt: NOW };
  const week = (allowed: readonly string[]): WeekCard => coverage.spanish(cardOf(buildWeekCard(narrative, 'corr-1', NOW, familyNameForWeekCard(allowed)), 'WEEK'));

  it('has two buttons of Wick’s, and a paragraph that is not', () => {
    const card = week(['Sarah Hughes']);
    expect(labels(card)).toEqual(['Entendido', 'Lo que ve Sarah']);
    expect(card.text).toBe(narrative.text);
    expect(cardIn('es', card, { text: 'Una semana tranquila.' })).toMatchObject({ text: 'Una semana tranquila.' });
  });

  it('names her family when several can see the week, when nobody can yet, or when the name would not fit', () => {
    for (const allowed of [['Sarah', 'David'], [], ['Bartholomew-Fitzgerald24']]) expect(labels(week(allowed))).toEqual(['Entendido', 'Lo que ve su familia']);
    expect(labels(week(['Anne-Marie']))[1]).toBe('Lo que ve Anne-Marie');
  });
});

describe('no kind of card can be forgotten', () => {
  it('every card in the union is proved somewhere, and every kind the agent plane builds was put through here', () => {
    expect(cardTypesInTheUnion().sort()).toEqual(Object.keys(COVERED_IN).sort());
    expect(coverage.missing()).toEqual([]);
  });

  it('the phrasebook the agent plane bundles is the contracts’ own', () => {
    expect(sayIn('es', 'Not now')).toBe('Ahora no');
  });
});
