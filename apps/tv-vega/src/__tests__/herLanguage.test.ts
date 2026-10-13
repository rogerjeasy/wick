/**
 * The television speaks her language (packages/contracts/src/language.ts),
 * from the question to the first Spanish word — the parts ResidentApp.tsx
 * runs, in the order it runs them, over a channel that is not a real one.
 *
 * ResidentApp itself is a React component and is not rendered here (no
 * view in this app is); the last test holds it to using these same parts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_ACTIONS,
  languageCardId,
  languageQuestion,
  type ChannelState,
  type ControlMessage,
  type DeviceChannel,
  type DeviceEvent,
  type LanguageCard,
  type QueuedCard,
} from '@wick/contracts';
import { BreakController } from '../break/BreakController.js';
import { removesCard } from '../cards/cardActions.js';
import { QueueStore, type FileSystemLike } from '../headless/QueueStore.js';
import { lightLabel } from '../home/light.js';
import { waitingLine } from '../home/waiting.js';
import { startCardChannel } from '../transport/startCardChannel.js';
import { words } from '../words/words.js';

/** The Vega simulator's disk (FL-013): nothing is kept, so everything here is as the app has it in memory. */
function noDisk(): FileSystemLike {
  const fail = () => Promise.reject(new Error('com.amazon.kepler.io.IoError'));
  return { exists: fail, readFileAsString: fail, writeStringToFile: fail };
}

class FakeChannel implements DeviceChannel {
  state: ChannelState = 'open';
  readonly sent: DeviceEvent[] = [];
  reconciles = 0;
  readonly #cards = new Set<(c: QueuedCard) => void>();
  readonly #controls = new Set<(m: ControlMessage) => void>();

  async connect(): Promise<void> {}
  close(): void {
    this.state = 'closed';
  }
  onCard(h: (c: QueuedCard) => void) {
    this.#cards.add(h);
    return () => this.#cards.delete(h);
  }
  onControl(h: (m: ControlMessage) => void) {
    this.#controls.add(h);
    return () => this.#controls.delete(h);
  }
  async send(e: DeviceEvent): Promise<void> {
    this.sent.push(e);
  }
  async reconcile(): Promise<void> {
    this.reconciles += 1;
  }
  pushCard(c: QueuedCard): void {
    for (const h of this.#cards) h(c);
  }
  pushControl(m: ControlMessage): void {
    for (const h of this.#controls) h(m);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const NOW = 1_800_000_000_000;
/** Long enough on the home screen for a note to be let through (NaturalBreakEngine TV_SETTLED). */
const SETTLED = NOW + 60_000;

const base = { householdId: 'hh-1', correlationId: 'c', createdAt: NOW } as const;

function languageCard(): QueuedCard {
  const id = languageCardId('es');
  const card: LanguageCard = { ...base, id, type: 'LANGUAGE', language: 'es', ...languageQuestion('es', 'Sarah') };
  return { id, urgency: 'DEFERRED', card, queuedAt: NOW, shownCount: 0 };
}

const note = (transcript: string, suggestedReplies: readonly string[]): QueuedCard => ({
  id: 'note-1',
  urgency: 'DEFERRED',
  card: { ...base, id: 'note-1', type: 'MESSAGE', actions: [], fromName: 'Sarah', transcript, suggestedReplies },
  queuedAt: NOW + 1,
  shownCount: 0,
});

/** What ResidentApp's one-second look does with the store, the channel's outbox and the break engine. */
async function look(store: QueueStore, engine: BreakController, now: number) {
  let cards = await store.readAll();
  const picked = engine.pickCard(cards, now);
  const showing = engine.noteShown(picked, cards, now);
  if (showing.began) {
    void store.enqueueOutbound({ t: 'card_shown', cardId: showing.began.id, at: now });
    await store.beginShowing(showing.began.id);
  }
  if (showing.ended) {
    await store.countShowing(showing.ended.id);
    cards = await store.readAll();
  }
  const language = store.language();
  const say = words(language);
  const waiting = engine.waiting(cards, now);
  return {
    card: picked,
    language,
    title: say('home.question'),
    light: lightLabel(store.readHome(), now, language),
    waiting: waiting ? waitingLine(waiting, language) : undefined,
  };
}

describe('she says yes to Spanish, on her own television', () => {
  it('shows the question, takes her press, and speaks Spanish from the home message on — asking for its cards again, once', async () => {
    const store = new QueueStore(noDisk());
    const channel = new FakeChannel();
    const engine = new BreakController();
    engine.setForeground(true, NOW);
    const running = startCardChannel(store, channel);

    // Connected: the whole of the home, in English, and the cards she is owed — a note, and the question.
    channel.pushControl({ t: 'home', home: { light: 'on' }, whole: true });
    channel.pushCard(languageCard());
    channel.pushCard(note('See you on Sunday.', ['Lovely', 'Not this week']));
    await settle();

    // Not at once: it waits for a natural break like any note (INV-5).
    expect((await look(store, engine, NOW + 1_000)).card).toBeUndefined();

    // Then the question is on screen — in both languages, with its two buttons as the server wrote them.
    const before = await look(store, engine, SETTLED);
    expect(before.card?.card).toMatchObject({
      type: 'LANGUAGE',
      headline: '¿Quiere que Wick le hable en español?',
      actions: [
        { id: 'yes', label: 'Sí, en español', kind: 'primary' },
        { id: 'no', label: 'No, keep English', kind: 'secondary' },
      ],
    });
    expect(before.language).toBe('en');
    expect(before.title).toBe('What would you like to watch?');
    expect(before.light).toBe('Light on');
    expect(await store.drainOutbound()).toEqual([{ t: 'card_shown', cardId: 'language-es', at: SETTLED }]);

    // Her press: the card is finished, and the press goes to the server (ResidentApp handleAction).
    const pressed = before.card!;
    expect(removesCard(pressed.card, LANGUAGE_ACTIONS.yes)).toBe(true);
    await store.remove(pressed.id);
    await store.enqueueOutbound({ t: 'card_action', cardId: pressed.id, action: LANGUAGE_ACTIONS.yes, at: SETTLED + 500 });
    expect(await store.drainOutbound()).toEqual([{ t: 'card_action', cardId: 'language-es', action: 'yes', at: SETTLED + 500 }]);

    // Nothing has changed yet: the language is the home's, and the home has not said so.
    expect((await look(store, engine, SETTLED + 1_000)).title).toBe('What would you like to watch?');
    expect(channel.reconciles).toBe(0);

    // The home message arrives with her language.
    channel.pushControl({ t: 'home', home: { light: 'on', language: 'es' }, whole: true });

    // At the very next look the television's own words are Spanish…
    const after = await look(store, engine, SETTLED + 2_000);
    expect(after.language).toBe('es');
    expect(after.title).toBe('¿Qué le gustaría ver?');
    expect(after.light).toBe('Luz encendida');
    // …and it has asked the server, once, for the cards it holds.
    expect(channel.reconciles).toBe(1);

    // The answer: the note again, in Spanish, and the whole of the home again. No second request.
    channel.pushCard(note('Nos vemos el domingo.', ['Qué bien', 'Esta semana no']));
    channel.pushControl({ t: 'home', home: { light: 'on', language: 'es' }, whole: true });
    await settle();

    const held = await store.readAll();
    expect(held.map((c) => c.id)).toEqual(['note-1']);
    expect(held[0]!.card).toMatchObject({ transcript: 'Nos vemos el domingo.', suggestedReplies: ['Qué bien', 'Esta semana no'] });
    expect((await look(store, engine, SETTLED + 3_000)).card?.card).toMatchObject({ transcript: 'Nos vemos el domingo.' });
    expect(channel.reconciles).toBe(1);

    running.stop();
  });

  it('changes nothing when she says no: the card is finished, the words stay as they were, and nothing is asked again', async () => {
    const store = new QueueStore(noDisk());
    const channel = new FakeChannel();
    const engine = new BreakController();
    engine.setForeground(true, NOW);
    const running = startCardChannel(store, channel);
    channel.pushControl({ t: 'home', home: { light: 'on' }, whole: true });
    channel.pushCard(languageCard());
    await settle();

    const shown = (await look(store, engine, SETTLED)).card!;
    expect(removesCard(shown.card, LANGUAGE_ACTIONS.no)).toBe(true);
    await store.remove(shown.id);
    // The server says how the home stands, as it does after any press that might change it: still English.
    channel.pushControl({ t: 'home', home: { light: 'on' }, whole: true });

    const after = await look(store, engine, SETTLED + 1_000);
    expect(after.card).toBeUndefined();
    expect(after.title).toBe('What would you like to watch?');
    expect(channel.reconciles).toBe(0);
    running.stop();
  });

  it('counts the showing of a note once when it is sent again, in Spanish, while she is reading it', async () => {
    const store = new QueueStore(noDisk());
    const channel = new FakeChannel();
    const engine = new BreakController();
    engine.setForeground(true, NOW);
    const running = startCardChannel(store, channel);
    channel.pushControl({ t: 'home', home: {}, whole: true });
    channel.pushCard(note('See you on Sunday.', []));
    await settle();

    expect((await look(store, engine, SETTLED)).card?.id).toBe('note-1');
    // Her language changes (she said yes in another room); the note comes again with the server's count, which already holds this showing.
    channel.pushControl({ t: 'home', home: { language: 'es' }, whole: true });
    channel.pushCard({ ...note('Nos vemos el domingo.', []), shownCount: 1 });
    await settle();
    expect((await look(store, engine, SETTLED + 1_000)).card?.card).toMatchObject({ transcript: 'Nos vemos el domingo.' });

    // She starts a film: the break is over, and the showing ends unanswered.
    engine.setPlayback({ state: 'PLAYING', positionMs: 10_000, durationMs: 600_000, contentId: 'sintel' } as never, SETTLED + 2_000);
    expect((await look(store, engine, SETTLED + 2_000)).card).toBeUndefined();

    expect((await store.readAll())[0]!.shownCount).toBe(1);
    running.stop();
  });
});

describe('the question about her language, once it has waited through two breaks', () => {
  it('is found on the home screen under its own words — the language asked for, not the one the television speaks', async () => {
    const store = new QueueStore(noDisk());
    const engine = new BreakController();
    engine.setForeground(true, NOW);
    await store.upsert({ ...languageCard(), shownCount: 2 });

    const seen = await look(store, engine, SETTLED);

    expect(seen.card).toBeUndefined();
    expect(seen.waiting).toBe('¿Quiere que Wick le hable en español?');
  });
});

describe('ResidentApp — the same parts, in the app', () => {
  const app = readFileSync(fileURLToPath(new URL('../ResidentApp.tsx', import.meta.url)), 'utf8');

  it('reads the language where it reads the home, once a second, and says the light and what is waiting in it', () => {
    expect(app).toMatch(/const language = store\.language\(\);/);
    expect(app).toMatch(/setLight\(lightLabel\(home, now, language\)\)/);
    expect(app).toMatch(/waitingLine\(waiting, language\)/);
  });

  it('gives the language to every screen that has words of its own', () => {
    for (const screen of ['HomeScreen', 'WatchScreen', 'CardRenderer', 'LiveView']) {
      const tag = app.slice(app.indexOf(`<${screen}`));
      expect(tag.slice(0, tag.indexOf('/>')), screen).toMatch(/\blanguage=\{language\}/);
    }
  });

  it('notes when a showing begins, so one sent again in the middle of it is not counted twice', () => {
    expect(app).toMatch(/await store\.beginShowing\(showing\.began\.id\)/);
  });

  it('draws nothing of the home until it knows the language: the first frame after a relaunch is not English', () => {
    expect(app).toMatch(/useState<HouseholdLanguage \| null>\(null\)/);
    expect(app).toMatch(/if \(language === null\) return </);
  });
});
