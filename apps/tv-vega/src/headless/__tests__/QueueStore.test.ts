import { describe, expect, it } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import { QueueStore, type FileSystemLike } from '../QueueStore.js';

function fakeFs(): FileSystemLike {
  const files = new Map<string, string>();
  return {
    async exists(path) {
      return files.has(path);
    },
    async readFileAsString(path) {
      return files.get(path) ?? '';
    },
    async writeStringToFile(path, content) {
      files.set(path, content);
      return content.length;
    },
  };
}

const doorCard = (id: string): QueuedCard => ({
  id,
  urgency: 'DOOR',
  card: { type: 'DOOR', id, householdId: 'hh-1', correlationId: 'c', createdAt: 0, actions: [], line: 'hi' },
  queuedAt: 0,
  shownCount: 0,
});

describe('QueueStore', () => {
  it('starts empty', async () => {
    const store = new QueueStore(fakeFs());
    expect(await store.readAll()).toEqual([]);
    expect(await store.lastSeenCardId()).toBeUndefined();
  });

  it('upserts by id without duplicating', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.upsert(doorCard('c1'));
    await store.upsert(doorCard('c2'));

    const all = await store.readAll();
    expect(all.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(await store.lastSeenCardId()).toBe('c2');
  });

  it('applies a Phase 2 patch to the matching DOOR card only', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.applyPatch({ cardId: 'c1', description: 'A courier in a blue jacket.' });

    const [card] = await store.readAll();
    expect(card!.card.type).toBe('DOOR');
    expect((card!.card as { description?: string }).description).toBe('A courier in a blue jacket.');
  });

  it('applies a corrected headline from a Phase 2 patch', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.applyPatch({ cardId: 'c1', line: 'Movement at the front door.' });

    const [card] = await store.readAll();
    expect((card!.card as { line: string }).line).toBe('Movement at the front door.');
  });

  it('applies a notice and replaces actions, exactly as egress.applyCardPatch does', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.applyPatch({
      cardId: 'c1',
      notice: 'The hallway chime rang.',
      actions: [{ id: 'dismiss', label: 'Not now', kind: 'dismiss' }],
    });

    const [q] = await store.readAll();
    expect(q!.card.type === 'DOOR' && q!.card.notice).toBe('The hallway chime rang.');
    expect(q!.card.actions.map((a) => a.id)).toEqual(['dismiss']);
  });

  it('caps patched actions at three on the device too', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    const four = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, kind: 'secondary' as const }));
    await store.applyPatch({ cardId: 'c1', actions: four });

    const [q] = await store.readAll();
    expect(q!.card.actions).toHaveLength(3);
  });

  it('keeps what the home screen is told beside its cards, each part replacing what was known of it', async () => {
    const store = new QueueStore(fakeFs());
    expect(store.readHome()).toEqual({});

    store.setHome({ light: 'on' });
    store.setHome({ lookedIn: { name: 'Sarah', at: 5, line: 'Sarah looked in this morning.' } });
    expect(store.readHome()).toEqual({ light: 'on', lookedIn: { name: 'Sarah', at: 5, line: 'Sarah looked in this morning.' } });

    // The whole of it, as the server sends when the television connects: what is not said is not so.
    store.setHome({ light: 'out' }, { whole: true });
    expect(store.readHome()).toEqual({ light: 'out' });
  });

  it('removes a card by id', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.remove('c1');
    expect(await store.readAll()).toEqual([]);
  });

  it('lastSeenCardId is a high-water mark that survives remove()', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.upsert(doorCard('c2'));
    await store.remove('c2');

    // The queue now only contains c1, but the device has already seen c2 —
    // reconcile must not redeliver it on the next reconnect.
    expect((await store.readAll()).map((c) => c.id)).toEqual(['c1']);
    expect(await store.lastSeenCardId()).toBe('c2');
  });

  it('queues and drains outbound device events', async () => {
    const store = new QueueStore(fakeFs());
    await store.enqueueOutbound({ t: 'card_shown', cardId: 'c1', at: 1 });
    await store.enqueueOutbound({ t: 'card_action', cardId: 'c1', action: 'answer', at: 2 });

    const drained = await store.drainOutbound();
    expect(drained).toHaveLength(2);
    expect(await store.drainOutbound()).toEqual([]);
  });

  it('restores what a previous launch persisted, when the disk works', async () => {
    const fs = fakeFs();
    const first = new QueueStore(fs);
    await first.upsert(doorCard('c1'));
    await first.enqueueOutbound({ t: 'card_shown', cardId: 'c1', at: 1 });

    const second = new QueueStore(fs);
    expect((await second.readAll()).map((c) => c.id)).toEqual(['c1']);
    expect(await second.lastSeenCardId()).toBe('c1');
    expect(await second.drainOutbound()).toHaveLength(1);
  });

  it('drains outbound events another process appended after this store loaded (RhythmSyncTask)', async () => {
    const fs = fakeFs();
    const holder = new QueueStore(fs);
    await holder.drainOutbound(); // loaded, empty

    await new QueueStore(fs).enqueueOutbound({ t: 'app_lifecycle', state: 'fg', at: 5 });

    expect(await holder.drainOutbound()).toEqual([{ t: 'app_lifecycle', state: 'fg', at: 5 }]);
    expect(await holder.drainOutbound()).toEqual([]);
  });

  describe('when every disk call throws — FL-013, the VVD never provisions a data root', () => {
    // The exact rejection observed on-device: a bare IoError, no detail.
    function brokenFs(): FileSystemLike {
      const fail = () => Promise.reject(new Error('com.amazon.kepler.io.IoError'));
      return { exists: fail, readFileAsString: fail, writeStringToFile: fail };
    }

    it('still holds every card it was given, in memory', async () => {
      const store = new QueueStore(brokenFs());
      await store.upsert(doorCard('c1'));
      await store.upsert(doorCard('c2'));
      await store.applyPatch({ cardId: 'c1', description: 'A courier in a blue jacket.' });
      await store.remove('c2');

      const all = await store.readAll();
      expect(all.map((c) => c.id)).toEqual(['c1']);
      expect((all[0]!.card as { description?: string }).description).toBe('A courier in a blue jacket.');
      expect(await store.lastSeenCardId()).toBe('c2');
    });

    it('still queues and drains outbound device events', async () => {
      const store = new QueueStore(brokenFs());
      await store.enqueueOutbound({ t: 'card_action', cardId: 'c1', action: 'dismiss', at: 2 });

      expect(await store.drainOutbound()).toEqual([{ t: 'card_action', cardId: 'c1', action: 'dismiss', at: 2 }]);
      expect(await store.drainOutbound()).toEqual([]);
    });
  });

  it('counts a showing on the card it was, and on no other', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.upsert(doorCard('c2'));

    await store.countShowing('c1');
    await store.countShowing('c1');
    await store.countShowing('never-held');

    expect((await store.readAll()).map((c) => [c.id, c.shownCount])).toEqual([['c1', 2], ['c2', 0]]);
  });
});

describe('QueueStore — a card this build does not know', () => {
  // The server learnt a new kind of card after this build was made.
  const unknown = (id: string): QueuedCard =>
    ({
      id,
      urgency: 'DEFERRED',
      card: { type: 'SOMETHING_NEW', id, householdId: 'hh-1', correlationId: 'c', createdAt: 0, actions: [{ id: 'ok', label: 'OK', kind: 'primary' }], headline: 'h' },
      queuedAt: 0,
      shownCount: 0,
    }) as unknown as QueuedCard;

  it('is not kept: there is nothing to show, so nothing may wait, be picked or take the remote', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.upsert(unknown('zz-new'));

    expect((await store.readAll()).map((c) => c.id)).toEqual(['c1']);
  });

  it('is not counted as seen: a later build is owed it', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.upsert(unknown('zz-new'));

    expect(await store.lastSeenCardId()).toBe('c1');
  });

  it('is not written to disk, and one found there — left by a newer build — is not read back', async () => {
    const fs = fakeFs();
    const store = new QueueStore(fs);
    await store.upsert(unknown('zz-new'));
    expect(await fs.exists('/data/wick-queue.json')).toBe(false);

    await fs.writeStringToFile('/data/wick-queue.json', JSON.stringify([unknown('zz-new'), doorCard('c1'), null, 'card']), 'utf8');
    expect((await new QueueStore(fs).readAll()).map((c) => c.id)).toEqual(['c1']);
  });

  it('does not take the place of a card held under the same id', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.upsert(unknown('c1'));

    expect((await store.readAll()).map((c) => c.card.type)).toEqual(['DOOR']);
  });
});

describe('QueueStore — the language her television speaks (packages/contracts language.ts)', () => {
  it('is English until the home says otherwise', () => {
    const store = new QueueStore(fakeFs());

    expect(store.language()).toBe('en');
    store.setHome({ light: 'on' }, { whole: true });
    expect(store.language()).toBe('en');
  });

  it('is what the home message says, and English again when the whole of a home names none', () => {
    const store = new QueueStore(fakeFs());

    store.setHome({ light: 'on', language: 'es' }, { whole: true });
    expect(store.language()).toBe('es');
    // A part of the home that does not speak of the language leaves it as it was.
    store.setHome({ light: 'out' });
    expect(store.language()).toBe('es');
    store.setHome({ light: 'on' }, { whole: true });
    expect(store.language()).toBe('en');
  });

  it('says when the language has changed — and learning it for the first time is not a change', () => {
    const store = new QueueStore(fakeFs());

    // Just connected: this television knew nothing, and the cards it is about to be sent are already in her language.
    expect(store.setHome({ language: 'es' }, { whole: true })).toEqual({ languageChanged: false });
    expect(store.setHome({ language: 'es' }, { whole: true })).toEqual({ languageChanged: false });
    expect(store.setHome({ light: 'on' })).toEqual({ languageChanged: false });
    // She has gone back to English.
    expect(store.setHome({ light: 'on' }, { whole: true })).toEqual({ languageChanged: true });
    expect(store.setHome({ light: 'on' }, { whole: true })).toEqual({ languageChanged: false });
    // And said yes to Spanish again, told as one part of the home.
    expect(store.setHome({ language: 'es' })).toEqual({ languageChanged: true });
  });

  it('says so when a home first told to be English turns out to have chosen another language', () => {
    const store = new QueueStore(fakeFs());

    expect(store.setHome({}, { whole: true })).toEqual({ languageChanged: false });
    expect(store.setHome({ language: 'es' }, { whole: true })).toEqual({ languageChanged: true });
  });

  it('remembers the language where the disk works, so the next launch does not begin in English', async () => {
    const fs = fakeFs();
    const first = new QueueStore(fs);
    first.setHome({ language: 'es' }, { whole: true });
    await first.readAll();

    const second = new QueueStore(fs);
    expect(await second.recallLanguage()).toBe('es');
    expect(second.language()).toBe('es');

    // And reading the cards is enough to have it: the app's first look does both.
    const third = new QueueStore(fs);
    await third.readAll();
    expect(third.language()).toBe('es');
  });

  it('remembers that she went back to English', async () => {
    const fs = fakeFs();
    const first = new QueueStore(fs);
    first.setHome({ language: 'es' }, { whole: true });
    first.setHome({}, { whole: true });
    await first.readAll();

    expect(await new QueueStore(fs).recallLanguage()).toBe('en');
  });

  it('counts a home that says otherwise than it remembered as a change: the cards it kept are in the old language', async () => {
    const fs = fakeFs();
    new QueueStore(fs).setHome({ language: 'es' }, { whole: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const relaunched = new QueueStore(fs);
    await relaunched.recallLanguage();
    expect(relaunched.setHome({ light: 'on' }, { whole: true })).toEqual({ languageChanged: true });
    expect(relaunched.language()).toBe('en');
  });

  it('goes by the server, not by what it remembered, when the server spoke first', async () => {
    const fs = fakeFs();
    new QueueStore(fs).setHome({ language: 'es' }, { whole: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const relaunched = new QueueStore(fs);
    relaunched.setHome({ light: 'on' }, { whole: true });
    expect(await relaunched.recallLanguage()).toBe('en');
  });

  it('is English when what is on disk is not a language Wick has', async () => {
    const fs = fakeFs();
    await fs.writeStringToFile('/data/wick-language.json', '"fr"', 'utf8');
    expect(await new QueueStore(fs).recallLanguage()).toBe('en');

    await fs.writeStringToFile('/data/wick-language.json', '{not json', 'utf8');
    expect(await new QueueStore(fs).recallLanguage()).toBe('en');
  });

  it('does not write the language again when nothing about it changed', async () => {
    const fs = fakeFs();
    let writes = 0;
    const counting: FileSystemLike = { ...fs, writeStringToFile: (path, content, encoding) => ((writes += path.includes('language') ? 1 : 0), fs.writeStringToFile(path, content, encoding)) };
    const store = new QueueStore(counting);

    store.setHome({ language: 'es' }, { whole: true });
    store.setHome({ language: 'es', light: 'on' }, { whole: true });
    store.setHome({ light: 'out' });
    await store.readAll();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writes).toBe(1);
  });

  it('works in memory where the disk does not — the Vega simulator (FL-013): the language is learnt again at each launch', async () => {
    const fail = () => Promise.reject(new Error('com.amazon.kepler.io.IoError'));
    const store = new QueueStore({ exists: fail, readFileAsString: fail, writeStringToFile: fail });

    expect(await store.recallLanguage()).toBe('en');
    expect(store.setHome({ language: 'es' }, { whole: true })).toEqual({ languageChanged: false });
    expect(store.language()).toBe('es');
  });
});

describe('QueueStore — a card sent again (a reconcile: on connecting, and when her language changes)', () => {
  const note = (over: Partial<QueuedCard> = {}): QueuedCard => ({
    id: 'note-1',
    urgency: 'DEFERRED',
    card: { type: 'MESSAGE', id: 'note-1', householdId: 'hh-1', correlationId: 'c', createdAt: 0, actions: [], fromName: 'Sarah', transcript: 'See you on Sunday.', suggestedReplies: [] },
    queuedAt: 100,
    shownCount: 0,
    ...over,
  });
  const inSpanish = (over: Partial<QueuedCard> = {}): QueuedCard => ({ ...note(over), card: { ...note().card, transcript: 'Nos vemos el domingo.' } as QueuedCard['card'] });
  const only = async (store: QueueStore): Promise<QueuedCard> => {
    const all = await store.readAll();
    expect(all).toHaveLength(1);
    return all[0]!;
  };

  it('takes the place of the one held under its id: the same card, in the words it now has', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(note());
    await store.upsert(inSpanish());

    expect(((await only(store)).card as { transcript?: string }).transcript).toBe('Nos vemos el domingo.');
  });

  it('does not lose a showing this television counted and the server had not heard of yet', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(note());
    await store.countShowing('note-1');

    await store.upsert(inSpanish({ shownCount: 0 }));

    expect((await only(store)).shownCount).toBe(1);
  });

  it('takes the server’s count when it is the larger: shown in another room', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(note());

    await store.upsert(inSpanish({ shownCount: 2 }));

    expect((await only(store)).shownCount).toBe(2);
  });

  it('does not count twice a showing the server already counted: it counts when one begins, this television when it ends', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(note());
    // On screen: `card_shown` goes to the server, which counts it at once.
    await store.beginShowing('note-1');
    // Sent again while she is reading it, with the server's count.
    await store.upsert(inSpanish({ shownCount: 1 }));
    // The break ends, unanswered.
    await store.countShowing('note-1');

    expect((await only(store)).shownCount).toBe(1);
  });

  it('counts each showing once when nothing is sent again in between', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(note());

    await store.beginShowing('note-1');
    await store.countShowing('note-1');
    expect((await only(store)).shownCount).toBe(1);

    await store.beginShowing('note-1');
    await store.countShowing('note-1');
    expect((await only(store)).shownCount).toBe(2);
  });

  it('starts afresh for a card asked again under the same id: it is a new question, not the old one sent again', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(note());
    await store.countShowing('note-1');
    await store.countShowing('note-1');

    await store.upsert(note({ queuedAt: 200, shownCount: 0 }));

    expect((await only(store)).shownCount).toBe(0);
  });

  it('forgets a showing under way when the card is answered', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(note({ shownCount: 1 }));
    await store.beginShowing('note-1');
    await store.remove('note-1');

    await store.upsert(note({ queuedAt: 200, shownCount: 0 }));
    await store.countShowing('note-1');

    expect((await only(store)).shownCount).toBe(1);
  });
});

describe('QueueStore — her mantelpiece, as the server last said it (packages/contracts mantel.ts)', () => {
  const item = (photoId: string) => ({ photoId, fromName: 'Sarah', keptAt: 5, url: `https://pictures.example/${photoId}.jpg?sig=secret` });

  it('knows nothing of it until the server answers', () => {
    expect(new QueueStore(fakeFs()).readMantel()).toBeUndefined();
  });

  it('keeps what the server answered, and when', () => {
    const store = new QueueStore(fakeFs());

    store.setMantel([item('p1'), item('p2')], 1_000);

    expect(store.readMantel()).toEqual({ items: [item('p1'), item('p2')], receivedAt: 1_000 });
  });

  it('replaces it whole with each answer — an empty one too: nothing is left on it', () => {
    const store = new QueueStore(fakeFs());
    store.setMantel([item('p1'), item('p2')], 1_000);

    store.setMantel([item('p2')], 2_000);
    expect(store.readMantel()).toEqual({ items: [item('p2')], receivedAt: 2_000 });

    store.setMantel([], 3_000);
    expect(store.readMantel()).toEqual({ items: [], receivedAt: 3_000 });
  });

  it('writes none of it down: an address is minted for one asking and kept nowhere', async () => {
    const files = new Map<string, string>();
    const fs: FileSystemLike = {
      exists: async (path) => files.has(path),
      readFileAsString: async (path) => files.get(path) ?? '',
      writeStringToFile: async (path, content) => (files.set(path, content), content.length),
    };
    const store = new QueueStore(fs);
    await store.upsert(doorCard('c1'));
    store.setHome({ mantel: 2 }, { whole: true });

    store.setMantel([item('p1'), item('p2')], 1_000);
    await store.enqueueOutbound({ t: 'mantel', at: 1 });
    await store.readAll();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const written = [...files.values()].join('\n');
    expect(written).not.toMatch(/pictures\.example|sig=secret|p1\.jpg/);
    expect(await new QueueStore(fs).readAll().then(() => new QueueStore(fs).readMantel())).toBeUndefined();
  });

  it('is told how many things are on it beside the light, and forgets that when the whole of a home names none', () => {
    const store = new QueueStore(fakeFs());

    store.setHome({ light: 'on', mantel: 3 }, { whole: true });
    expect(store.readHome().mantel).toBe(3);
    store.setHome({ light: 'out' });
    expect(store.readHome().mantel).toBe(3);
    store.setHome({ light: 'on' }, { whole: true });
    expect(store.readHome().mantel).toBeUndefined();
  });
});

describe('QueueStore — a picture sent back after its own press (her mantelpiece was full)', () => {
  const photo = (over: Partial<QueuedCard> = {}): QueuedCard => ({
    id: 'photo-p1',
    urgency: 'DEFERRED',
    card: {
      type: 'PHOTO', id: 'photo-p1', householdId: 'hh-1', correlationId: 'c', createdAt: 0, photoId: 'p1', fromName: 'Sarah',
      headline: 'A picture from Sarah.', actions: [{ id: 'keep', label: 'Keep it', kind: 'primary' }, { id: 'thanks', label: 'Thank you', kind: 'secondary' }],
    },
    queuedAt: 100,
    shownCount: 0,
    ...over,
  });
  const withNotice = (over: Partial<QueuedCard> = {}): QueuedCard => ({ ...photo(over), card: { ...photo().card, notice: 'Your mantelpiece is full. Take one down, then you can keep this.' } as QueuedCard['card'] });

  it('is held again under its id: nothing here remembers that it was answered', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(photo());
    await store.beginShowing('photo-p1');
    // "Keep it": the card is put away, and the press goes to the server.
    await store.remove('photo-p1');
    expect(await store.readAll()).toEqual([]);

    // The mantelpiece was full: the same card, with the line that says so.
    await store.upsert(withNotice({ shownCount: 1 }));

    const [held] = await store.readAll();
    expect(held!.id).toBe('photo-p1');
    expect((held!.card as { notice?: string }).notice).toMatch(/full/);
  });

  it('comes with the server’s count of its showings, and each showing after that is counted once', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(photo());
    await store.beginShowing('photo-p1');
    await store.remove('photo-p1');

    // The server counted the showing she answered.
    await store.upsert(withNotice({ shownCount: 1 }));
    expect((await store.readAll())[0]!.shownCount).toBe(1);

    // Shown again, and left this time.
    await store.beginShowing('photo-p1');
    await store.countShowing('photo-p1');
    expect((await store.readAll())[0]!.shownCount).toBe(2);
  });

  it('does not count the answered showing against the card that comes back, when the server sends it afresh', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(photo());
    await store.beginShowing('photo-p1');
    await store.remove('photo-p1');

    await store.upsert(withNotice({ queuedAt: 200, shownCount: 0 }));
    // The break ends with nothing more shown: no showing of this card was under way.
    expect((await store.readAll())[0]!.shownCount).toBe(0);
  });
});

describe('QueueStore — two answers about her mantelpiece in the same instant', () => {
  it('are still two answers: the later one is told apart from the earlier by when it came', () => {
    const store = new QueueStore(fakeFs());
    const item = { photoId: 'p1', fromName: 'Sarah', keptAt: 5, url: 'https://pictures.example/p1.jpg' };

    store.setMantel([item], 1_000);
    const first = store.readMantel()!;
    store.setMantel([], 1_000);
    const second = store.readMantel()!;

    expect(second.receivedAt).toBeGreaterThan(first.receivedAt);
    // And a clock that went back does not make a new answer look older than the last.
    store.setMantel([item], 500);
    expect(store.readMantel()!.receivedAt).toBeGreaterThan(second.receivedAt);
  });
});
