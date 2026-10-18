/**
 * Everything the Wick server writes for her television is in the
 * phrasebook: a note's replies, the Circle card, the four cards of watching
 * a film together, a family member's answer about the door or to a request
 * to ring, who looked in, a wave, and a picture for her mantelpiece.
 *
 * The real builders and tools are run against a table in memory, and what
 * they send is put through `cardIn` / `patchIn` / `homeIn`
 * (packages/contracts phrasebook/).
 */
import { describe, expect, it } from 'vitest';
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  DOOR_ANSWERS,
  MANTEL_FULL_NOTICE,
  MAX_CARD_DETAIL_CHARS,
  PHOTO_ACTIONS,
  REACH_ANSWERS,
  WATCH_ANSWERS,
  cardIn,
  freeTextOf,
  homeIn,
  patchIn,
  photoCardId,
  type Card,
  type CardPatch,
  type CircleCard,
  type DoorAnswer,
  type HomeState,
  type MessageCard,
  type PhotoCard,
  type QueuedCard,
  type ReachAnswer,
  type ReachPerson,
  type ReachRequest,
  type WatchAnswer,
  type WatchCard,
} from '@wick/contracts';
import { reachItem } from '@wick/agent';
import { COVERED_IN, cardTypesInTheUnion, coverageOf } from '../../../../packages/contracts/src/phrasebook/__tests__/support.js';
// The television's half of a film watched together is the edge's own code, run here as it is deployed.
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { askedUpdate, buildQuestionCard, decisionUpdate, startUpdate } from '../../../edge-device/lambda/watch-together.mjs';
import { buildCircleCard } from '../accounts/circle.js';
import { createMemoryStore } from '../accounts/__tests__/memoryStore.js';
import { WAVE_CARD_PREFIX, sendWave } from '../accounts/familyTvWave.js';
import type { Household, Membership } from '../accounts/types.js';
import { createS3PhotoObjects } from '../photos/objects.js';
import { buildPhotoCard, sendPhoto } from '../photos/send.js';
import { createMemoryObjects } from '../photos/__tests__/memoryObjects.js';
import { answerDoorRequest } from '../tools/answer_door_request.js';
import { answerReachRequest } from '../tools/answer_reach_request.js';
import { registerAnswerWatchTogether } from '../tools/answer_watch_together.js';
import type { ToolContext } from '../tools/context.js';
import { registerInviteToWatch } from '../tools/invite_to_watch.js';
import { registerJoinWatchTogether } from '../tools/join_watch_together.js';
import { recordLook } from '../tools/lookIn.js';
import { DECLINE_REPLY, REPLY_CHOICES, STANDING_REPLIES, buildMessageCard, type ReplyChoice } from '../tools/send_note_to_tv.js';
import { registerWithdrawWatchInvitation } from '../tools/withdraw_watch_invitation.js';
import { allowedContext } from '../tools/__tests__/toolContext.js';
import { createMemoryTable, type MemoryTable } from './memoryTable.js';

const coverage = coverageOf('mcp-server', { cardIn, patchIn });
/** Monday 12 October 2026, 10:00 in London (BST). */
const NOW = Date.UTC(2026, 9, 12, 9, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const labels = (card: { readonly actions: readonly { readonly label: string }[] }): string[] => card.actions.map((a) => a.label);
const cardOf = <T extends Card['type']>(queued: QueuedCard | undefined, type: T): Extract<Card, { type: T }> => {
  if (queued?.card.type !== type) throw new Error(`not a ${type} card`);
  return queued.card as Extract<Card, { type: T }>;
};

const household: Household = { householdId: 'hh-1', name: 'Margaret’s home', residentName: 'Margaret', createdBy: 'u_sarah', createdAt: 0 };
const member = (name: string, role: Membership['role'] = 'family', userId = 'u_sarah'): Membership => ({ householdId: 'hh-1', userId, name, role, status: 'pending', requestedAt: NOW });

describe('a note’s replies (tools/send_note_to_tv.ts)', () => {
  const SPANISH: Record<string, string> = {
    'Thanks for letting me know!': '¡Gracias por avisarme!',
    "I'll call you soon.": 'Llamaré pronto.',
    'Not right now.': 'Ahora mismo no.',
    'Yes, please do.': 'Sí, por favor.',
    "Yes, that's fine.": 'Sí, está bien.',
    "I'd love that.": 'Me encantaría.',
    'Another day would be better.': 'Mejor otro día.',
    'A bit later would be better.': 'Mejor un poco más tarde.',
    'No, thank you.': 'No, gracias.',
    'Thank you!': '¡Gracias!',
    'Please call me.': 'Llámame, por favor.',
    "I'm fine, thank you.": 'Estoy bien, gracias.',
    'Thinking of you too.': 'Yo también pienso en ti.',
    "That's lovely to hear.": 'Qué alegría saberlo.',
  };
  const note = (replies?: readonly ReplyChoice[]): MessageCard =>
    cardOf(buildMessageCard({ householdId: 'hh-1', correlationId: 'corr-1', fromName: 'Sarah Hughes', message: 'Shall I come on Saturday?', replies, now: NOW }), 'MESSAGE');

  it('the standing three', () => {
    const card = coverage.spanish(note());
    expect(card.suggestedReplies).toEqual(['¡Gracias por avisarme!', 'Llamaré pronto.', 'Ahora mismo no.']);
  });

  it('every reply that can be chosen for a note, each in the Spanish written for it', () => {
    expect(Object.keys(SPANISH).sort()).toEqual([...new Set([...Object.values(REPLY_CHOICES), ...STANDING_REPLIES, DECLINE_REPLY])].sort());
    const keys = Object.keys(REPLY_CHOICES) as ReplyChoice[];
    keys.forEach((key, i) => {
      const other = keys[(i + 1) % keys.length]!;
      const english = note([key, other]);
      const card = coverage.spanish(english);
      expect(card.suggestedReplies).toEqual(english.suggestedReplies.map((reply) => SPANISH[reply]));
    });
  });

  it('what the family wrote, and who they are, is not the phrasebook’s: the note is free text and the name is a name', () => {
    const english = note(['yes_please', 'another_day']);
    const card = coverage.spanish(english);
    expect(card.transcript).toBe('Shall I come on Saturday?');
    expect(card.fromName).toBe('Sarah Hughes');
    expect(freeTextOf(english)).toEqual({ transcript: 'Shall I come on Saturday?' });
    expect((cardIn('es', english, { transcript: '¿Voy el sábado?' }) as MessageCard).transcript).toBe('¿Voy el sábado?');
  });
});

describe('a wave (accounts/familyTvWave.ts)', () => {
  async function waved(name: string): Promise<MessageCard> {
    const sent: QueuedCard[] = [];
    const who = { householdId: 'hh-1', userId: 'u_sarah', deviceId: 'ftv-1', membership: { ...member(name), status: 'allowed' as const }, household };
    const done = await sendWave(createMemoryTable().ddb, { sendCard: async (card) => void sent.push(card), withdrawCard: async () => undefined }, who, NOW);
    expect(done).toBe(true);
    return cardOf(sent[0], 'MESSAGE');
  }

  it('is Wick’s own sentence, naming the television it came from, with her two buttons', async () => {
    const english = await waved('Sarah Hughes');
    expect(english.id.startsWith(WAVE_CARD_PREFIX)).toBe(true);
    const card = coverage.spanish(english);
    expect(card.transcript).toBe('Un saludo con la mano para usted, desde el televisor de Sarah.');
    expect(card.suggestedReplies).toEqual(['Devolver el saludo', 'Ahora no']);
    expect(card.fromName).toBe('Sarah Hughes');
  });

  it('is never free text: no machine is handed it, and no translation handed in replaces it', async () => {
    const english = await waved('Anne-Marie O’Brien');
    expect(freeTextOf(english)).toEqual({});
    expect((cardIn('es', english, { transcript: 'otra cosa' }) as MessageCard).transcript).toBe('Un saludo con la mano para usted, desde el televisor de Anne-Marie.');
    // The phrasebook knows a wave by the same mark the server gives it.
    expect((cardIn('es', { ...english, id: 'note-1f0c' }) as MessageCard).transcript).toBe(english.transcript);
  });
});

describe('the Circle card (accounts/circle.ts)', () => {
  const circle = (who: Membership): CircleCard => coverage.spanish(cardOf(buildCircleCard(household, who, NOW), 'CIRCLE'));

  it('somebody who would like to join her family circle', () => {
    const card = circle(member('Sarah Hughes'));
    expect(card).toMatchObject({
      personName: 'Sarah Hughes',
      headline: 'Sarah Hughes desea unirse a su círculo familiar.',
      detail: 'Si usted acepta, Sarah podrá enviarle notas aquí y ver lo que usted decida compartir. Puede cambiar lo que se comparte en cualquier momento.',
    });
    expect(labels(card)).toEqual(['Aceptar a Sarah', 'No, gracias']);
    expect(circle(member('Sarah', 'organiser')).headline).toBe('Sarah desea unirse a su círculo familiar.');
  });

  it('a neighbour, who is asked two things and shown nothing', () => {
    const card = circle(member('Tom Baker', 'neighbour', 'u_tom'));
    expect(card).toMatchObject({
      role: 'neighbour',
      headline: 'Tom Baker desea ser alguien del vecindario a quien usted pueda recurrir.',
      detail: 'Si usted acepta, podrá pedir a Tom que mire quién está en su puerta, o que le llame. Tom no verá su semana, su día ni sus notas.',
    });
    expect(labels(card)).toEqual(['Aceptar a Tom', 'No, gracias']);
  });

  it('whatever the person is called, and never past the card', () => {
    for (const name of ['Anne-Marie O’Brien', "Siobhán D'Arcy", 'José María de la Cruz', 'Dr. J. Patel', 'Bartholomew-Fitzgerald24', 'Wolfeschlegelsteinhausenbergerdorff Hubert Blaine']) {
      for (const role of ['family', 'neighbour'] as const) {
        const card = circle(member(name, role));
        expect(card.headline.startsWith(card.personName), name).toBe(true);
        expect(card.detail.length, card.detail).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
      }
    }
  });
});

describe('a film watched together (tools/invite_to_watch.ts and the tools beside it)', () => {
  async function connected(table: MemoryTable, ctx: ToolContext, clock: { now: number }) {
    const cards: QueuedCard[] = [];
    const sendCard = async (card: QueuedCard): Promise<void> => void cards.push(card);
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerInviteToWatch(mcpServer, table.ddb, ctx, sendCard, () => clock.now);
    registerJoinWatchTogether(mcpServer, table.ddb, ctx, sendCard, () => clock.now);
    registerAnswerWatchTogether(mcpServer, table.ddb, ctx, sendCard, () => clock.now);
    registerWithdrawWatchInvitation(mcpServer, table.ddb, ctx, async () => undefined, sendCard, () => clock.now);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError === true, (result.content as { text: string }[])[0]?.text).toBe(false);
      return result.structuredContent as Record<string, unknown>;
    };
    /** The newest card the tools sent, as her television shows it. */
    const shown = (): WatchCard => coverage.spanish(cardOf(cards.at(-1), 'WATCH'));
    return { call, cards, shown };
  }

  /** Her television, as the edge hears it: each press is the edge's own update against the table. */
  function television(table: MemoryTable, sessionId: string) {
    const target = { table: 'wick', householdId: 'hh-1', sessionId };
    const apply = (update: object): Promise<unknown> => table.ddb.send(new UpdateItemCommand(update as never));
    return {
      accepts: (at: number) => apply((decisionUpdate as (i: object) => object)({ ...target, accepted: true, at })),
      starts: (at: number) => apply((startUpdate as (i: object) => object)({ ...target, at })),
      reachesTheCredits: (at: number) => apply((askedUpdate as (i: object) => object)({ ...target, at })),
      row: () => table.rows('HH#hh-1').find((row) => row.sk?.S === `WATCH#${sessionId}`),
    };
  }

  async function invited(name: string, invite: { programme: string; date: string; time: string }, startsAt: number, asksAt: number = NOW) {
    const table = createMemoryTable();
    const clock = { now: asksAt };
    const family = await connected(table, allowedContext('hh-1', { name }), clock);
    const sessionId = (await family.call('invite_to_watch', invite)).sessionId as string;
    return { family, clock, startsAt, sessionId, tv: television(table, sessionId) };
  }

  /** Sunday 18 October 2026, 15:00 in London. */
  const SUNDAY_AT_THREE = Date.UTC(2026, 9, 18, 14, 0);
  const sintel = () => invited('Sarah Hughes', { programme: 'sintel', date: '2026-10-18', time: '15:00' }, SUNDAY_AT_THREE);

  it('the invitation', async () => {
    const card = (await sintel()).family.shown();
    expect(card).toMatchObject({
      withName: 'Sarah',
      headline: 'Sarah desea ver una película con usted.',
      detail: 'Sintel, el domingo 18 de octubre a las 15:00. Sarah vería la película desde su propia casa, tal como usted la reproduzca. Usted tiene el control remoto.',
    });
    expect(labels(card)).toEqual(['Sí, veámosla.', 'Esta vez no.']);
    expect(card.detail!.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
  });

  it('for every film, on other days and at other hours, from whoever asks', async () => {
    const asks: readonly (readonly [string, { programme: string; date: string; time: string }, string])[] = [
      ['Anne-Marie', { programme: 'big-buck-bunny', date: '2026-10-19', time: '11:30' }, 'Big Buck Bunny, el lunes 19 de octubre a las 11:30.'],
      ['José', { programme: 'tears-of-steel', date: '2026-11-03', time: '13:00' }, 'Tears of Steel, el martes 3 de noviembre a las 13:00.'],
      ['O’Brien', { programme: 'sintel', date: '2026-12-31', time: '09:05' }, 'Sintel, el jueves 31 de diciembre a las 9:05.'],
      ['Bartholomew-Fitzgerald24', { programme: 'tears-of-steel', date: '2027-01-02', time: '20:45' }, 'Tears of Steel, el sábado 2 de enero a las 20:45.'],
    ];
    for (const [name, invite, when] of asks) {
      // Asked a week before: an invitation is for the next two months, no further.
      const card = (await invited(name, invite, 0, Date.parse(`${invite.date}T00:00:00Z`) - 7 * 24 * HOUR)).family.shown();
      expect(card.headline).toBe(`${name} desea ver una película con usted.`);
      expect(card.detail!.startsWith(when), card.detail).toBe(true);
      expect(card.detail!.length, card.detail).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
    }
  });

  it('"… is ready", and what "Start the film" shares', async () => {
    const { family, clock, sessionId, tv, startsAt } = await sintel();
    await tv.accepts(NOW + MIN);
    clock.now = startsAt - 5 * MIN;
    await family.call('join_watch_together', { sessionId });

    const card = family.shown();
    expect(card).toMatchObject({
      headline: 'Sarah ya puede ver Sintel con usted.',
      detail: 'Desde que usted la inicie, Sarah verá la película tal como usted la reproduce: donde usted haga una pausa, también se pausará para Sarah. Solo esta película, y solo esta vez.',
      programmeId: 'sintel',
    });
    expect(labels(card)).toEqual(['Iniciar la película', 'Ahora no']);
    expect(card.detail!.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
  });

  it('a film called off after she had said yes', async () => {
    const { family, sessionId, tv } = await sintel();
    await tv.accepts(NOW + MIN);
    await family.call('withdraw_watch_invitation', { sessionId });

    const card = family.shown();
    expect(card).toMatchObject({
      headline: 'Al final, Sarah no puede ver la película.',
      detail: 'Sintel, el domingo 18 de octubre a las 15:00, no tendrá lugar. Sarah puede volver a pedírselo para otro momento.',
    });
    expect(labels(card)).toEqual(['De acuerdo']);
  });

  it('the question at the credits (the edge’s card, from the row the server wrote) and each answer the family member can choose', async () => {
    const spanish: Record<WatchAnswer, string> = { loved_it: 'Me encantó.', all_right: 'Estuvo bien.', not_for_me: 'No fue muy de mi gusto.' };
    for (const answer of Object.keys(WATCH_ANSWERS) as WatchAnswer[]) {
      const { family, clock, sessionId, tv, startsAt } = await sintel();
      await tv.accepts(NOW + MIN);
      clock.now = startsAt - 5 * MIN;
      await family.call('join_watch_together', { sessionId });
      await tv.starts(startsAt + MIN);
      await tv.reachesTheCredits(startsAt + 14 * MIN);

      const question = coverage.spanish(cardOf((buildQuestionCard as (i: object) => QueuedCard)({ householdId: 'hh-1', item: tv.row(), now: startsAt + 14 * MIN }), 'WATCH'));
      expect(question).toMatchObject({ headline: 'Ha terminado Sintel, con Sarah.', detail: '¿Qué le pareció?' });
      expect(labels(question)).toEqual(['Me encantó.', 'Estuvo bien.', 'No fue muy de mi gusto.']);

      clock.now = startsAt + 15 * MIN;
      await family.call('answer_watch_together', { sessionId, answer });
      const card = family.shown();
      expect(card).toMatchObject({ headline: `Sarah dice: “${spanish[answer]}”`, detail: 'Sobre Sintel, que ustedes vieron en compañía.' });
      expect(labels(card)).toEqual(['Entendido']);
    }
  });
});

describe('a family member’s answer about the door (tools/answer_door_request.ts)', () => {
  function asked(): MemoryTable {
    const table = createMemoryTable();
    const card = { type: 'DOOR', id: 'door-abc', householdId: 'hh-1', line: "Someone's at the front door.", actions: [] };
    table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#door-abc' }, data: { S: JSON.stringify({ id: 'door-abc', urgency: 'DOOR', queuedAt: NOW - MIN, expiresAt: NOW + 4 * MIN, shownCount: 0, card }) } });
    table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'LOOK#door-abc' }, cardId: { S: 'door-abc' }, askedAt: { N: String(NOW - 30_000) }, expiresAt: { N: String(NOW + 4 * MIN) }, ttl: { N: String(Math.floor(NOW / 1000) + 86_400) } });
    return table;
  }

  it('is shown under their first name, in the Spanish written for the answer they chose', async () => {
    const spanish: Record<DoorAnswer, string> = {
      known: 'Sarah dice: Está bien, sé quién es.',
      dont_open: 'Sarah dice: Por favor, no abra la puerta. Ahora mismo llamo por teléfono.',
      not_sure: 'Sarah dice: No distingo quién es. Ahora mismo llamo por teléfono.',
    };
    for (const answer of Object.keys(DOOR_ANSWERS) as DoorAnswer[]) {
      const patches: CardPatch[] = [];
      const outcome = await answerDoorRequest(asked().ddb, { householdId: 'hh-1', userId: 'u_sarah', memberName: 'Sarah Hughes', residentName: 'Margaret' }, 'door-abc', answer, async (patch) => void patches.push(patch), NOW);
      expect(outcome.shown).toBe(true);
      expect(coverage.spanishPatch(patches[0]!)).toEqual({ cardId: 'door-abc', notice: spanish[answer] });
    }
  });
});

describe('a family member’s answer to a request to ring (tools/answer_reach_request.ts)', () => {
  const sarah: ReachPerson = { userId: 'u_sarah', name: 'Sarah Hughes', role: 'organiser' };
  const REACH_ID = String(NOW - 2 * MIN);

  it('is shown under their first name, in the Spanish written for the answer they chose', async () => {
    const spanish: Record<ReachAnswer, string> = {
      now: 'Sarah dice: Ya estoy llamando por teléfono.',
      soon: 'Sarah dice: Llamaré por teléfono en menos de una hora.',
      hello: 'Sarah dice: Hola, igualmente.',
    };
    for (const answer of Object.keys(REACH_ANSWERS) as ReachAnswer[]) {
      const table = createMemoryTable();
      const request: ReachRequest = { householdId: 'hh-1', reachId: REACH_ID, kind: answer === 'hello' ? 'hello' : 'ring', askedAt: NOW - 2 * MIN, order: [sarah], asked: 1 };
      table.put(reachItem(request));
      const sent: QueuedCard[] = [];
      const outcome = await answerReachRequest(table.ddb, { householdId: 'hh-1', userId: 'u_sarah', memberName: 'Sarah Hughes', residentName: 'Margaret' }, REACH_ID, answer, async (card) => void sent.push(card), NOW);
      expect(outcome.shown).toBe(true);
      const card = coverage.spanish(cardOf(sent[0], 'REACH'));
      expect(card.headline).toBe(spanish[answer]);
      expect(labels(card)).toEqual(['Gracias']);
    }
  });
});

describe('who looked in (tools/lookIn.ts)', () => {
  it('is said on her home screen, for the morning, the afternoon and the evening where the house is', async () => {
    const said: HomeState[] = [];
    /** Monday 12 October 2026: 10:00, 15:00 and 20:00 in London. */
    const looks: readonly (readonly [string, number, string])[] = [
      ['Sarah Hughes', NOW, 'Sarah ha preguntado por usted esta mañana.'],
      ['Anne-Marie', NOW + 5 * HOUR, 'Anne-Marie ha preguntado por usted esta tarde.'],
      ['José', NOW + 10 * HOUR, 'José ha preguntado por usted esta noche.'],
    ];
    for (const [name, at, spanish] of looks) {
      await recordLook(createMemoryTable().ddb, { householdId: 'hh-1', userId: 'u_1', name, timeZone: 'Europe/London' }, at, async (_household, home) => void said.push(home));
      const english = said.at(-1)!;
      const home = homeIn('es', english);
      expect(home.lookedIn?.line).toBe(spanish);
      expect(home).toEqual({ ...english, lookedIn: { ...english.lookedIn, line: spanish } });
    }
    expect(said).toHaveLength(3);
  });
});

describe('a picture for her mantelpiece (photos/send.ts)', () => {
  /** Bytes that are a JPEG by their markers and nothing else: made here, never a photograph. */
  const jpeg = (): Uint8Array => {
    const bytes = new Uint8Array(64).fill(7);
    bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
    bytes.set([0xff, 0xd9], 62);
    return bytes;
  };

  /** The whole sending, as `POST /api/photos` does it: an allowed member, a television, a picture that passes. */
  async function sent(name: string): Promise<PhotoCard> {
    const store = createMemoryStore(() => NOW);
    await store.createHousehold(household);
    await store.putMembership({ ...member(name), status: 'allowed' });
    store.addTelevision('hh-1', { deviceId: 'tv-1', pairedAt: 5, connected: true });
    const bucket = createMemoryObjects();
    const cards: QueuedCard[] = [];
    const outcome = await sendPhoto(
      {
        ddb: createMemoryTable().ddb,
        store,
        objects: createS3PhotoObjects((command) => bucket.send(command), 'wick-photos-test'),
        moderate: async () => 'pass',
        sendCard: async (card) => void cards.push(card),
        withdrawCard: async () => undefined,
        now: () => NOW,
        newId: () => 'p_8Jk2-xQ9a',
      },
      { householdId: 'hh-1', userId: 'u_sarah' },
      jpeg(),
      undefined,
    );
    expect(outcome.sent).toBe(true);
    expect(cards).toHaveLength(1);
    return cardOf(cards[0], 'PHOTO');
  }

  it('reaches her television in Wick’s own words, under the first name of who sent it', async () => {
    const english = await sent('Sarah Hughes');
    const card = coverage.spanish(english);
    expect(card.headline).toBe('Una foto de parte de Sarah.');
    expect(labels(card)).toEqual(['Guardarla', 'Gracias']);
    expect(card.actions.map((a) => a.id)).toEqual([PHOTO_ACTIONS.keep, PHOTO_ACTIONS.thanks]);
    // The picture itself is not the phrasebook's: its id, and the name it came under.
    expect(card).toMatchObject({ id: english.id, photoId: english.photoId, fromName: english.fromName });
    expect(freeTextOf(english)).toEqual({});
  });

  it('whoever sent it', async () => {
    for (const name of ['Anne-Marie O’Brien', "D'Arcy", 'José María', 'Bartholomew-Fitzgerald24']) {
      expect(coverage.spanish(await sent(name)).headline).toBe(`Una foto de parte de ${name.split(' ')[0]}.`);
      const built = coverage.spanish(cardOf(buildPhotoCard(household, 'p_1', name, NOW), 'PHOTO'));
      expect(built).toMatchObject({ id: photoCardId('p_1'), photoId: 'p_1', fromName: name, headline: `Una foto de parte de ${name.split(' ')[0]}.` });
    }
  });

  it('and says so in her language when it comes back because her mantelpiece is full', () => {
    const stored = cardOf(buildPhotoCard(household, 'p_1', 'Sarah Hughes', NOW), 'PHOTO');
    const card = coverage.spanish({ ...stored, notice: MANTEL_FULL_NOTICE });
    expect(card.notice).toBe('Su repisa está llena. Quite una foto, y entonces podrá guardar esta.');
    expect(card.notice!.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
  });
});

describe('no kind of card can be forgotten', () => {
  it('every card in the union is proved somewhere, and every kind the Wick server builds was put through here', () => {
    expect(cardTypesInTheUnion().sort()).toEqual(Object.keys(COVERED_IN).sort());
    expect(coverage.missing()).toEqual([]);
  });
});
