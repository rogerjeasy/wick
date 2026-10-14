/**
 * /api/hear over a real socket: ask by voice. One short utterance of raw
 * 16 kHz PCM in, its words out — heard by a stand-in for Amazon Transcribe's
 * streaming API given to the real hearing code (hear/transcribe.ts), so what
 * Transcribe would be sent is checked byte for byte.
 *
 * What the route adds: who may be heard, what kind of body, how much, how
 * often — and that nothing of the audio is kept or logged, and nothing in a
 * request can name a household (INV-8).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StartStreamTranscriptionCommand, TranscriptResultStream } from '@aws-sdk/client-transcribe-streaming';
import { HEAR_SAMPLE_RATE, MAX_HEAR_BYTES } from '@wick/contracts';
import type { AppDeps } from '../server.js';
import { HEARINGS_PER_PERSON_PER_MINUTE, HEAR_WORDS } from '../hear/routes.js';
import { HEAR_CHUNK_BYTES, createTranscribeHearing, type TranscribeSend } from '../hear/transcribe.js';
import { linkInvited, linkNewOrganiser, residentAllows, startServer, TOM, type Harness, type Linked } from './harness.js';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

/** What the stand-in for Transcribe was asked: each request's input, and every byte of audio it was streamed, in order. */
interface Heard {
  readonly requests: Record<string, unknown>[];
  readonly audio: Uint8Array[];
  readonly chunkSizes: number[][];
}

/** A Transcribe streaming client that reads the whole input stream, as Transcribe does, and says `words` (partials first). */
function fakeTranscribe(words: () => string): { send: TranscribeSend; heard: Heard } {
  const heard: Heard = { requests: [], audio: [], chunkSizes: [] };
  const send: TranscribeSend = async (command: StartStreamTranscriptionCommand) => {
    const { AudioStream, ...rest } = command.input;
    heard.requests.push(rest);
    const chunks: Uint8Array[] = [];
    for await (const event of AudioStream!) if (event.AudioEvent?.AudioChunk) chunks.push(event.AudioEvent.AudioChunk);
    heard.chunkSizes.push(chunks.map((c) => c.length));
    heard.audio.push(new Uint8Array(Buffer.concat(chunks)));
    const said = words();
    async function* results(): AsyncGenerator<TranscriptResultStream> {
      if (!said) {
        yield { TranscriptEvent: { Transcript: { Results: [] } } };
        return;
      }
      // A partial result first — Transcribe still making up its mind — which must never be read.
      yield { TranscriptEvent: { Transcript: { Results: [{ IsPartial: true, Alternatives: [{ Transcript: 'how is mum bean' }] }] } } };
      yield { TranscriptEvent: { Transcript: { Results: [{ IsPartial: false, Alternatives: [{ Transcript: said }] }] } } };
    }
    return { TranscriptResultStream: results() };
  };
  return { send, heard };
}

/** Bytes that are 16-bit samples by their count and nothing else: made here, never a recording. */
const pcm = (bytes: number, seed = 1): Uint8Array => Uint8Array.from({ length: bytes }, (_, i) => (i * 31 + seed) & 0xff);

const L16 = 'audio/l16; rate=16000; channels=1';

const hear = (h: Harness, who: Pick<Linked, 'tokens'> | null, body: Uint8Array | string, contentType: string | null = L16, path = '/api/hear') =>
  fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: { ...(who ? { authorization: `Bearer ${who.tokens.access_token}` } : {}), ...(contentType ? { 'content-type': contentType } : {}) },
    body,
  });

async function home(words: () => string = () => 'How has Mum been this week?', overrides: Partial<AppDeps> = {}) {
  const transcribe = fakeTranscribe(words);
  const h = await startServer({ hear: createTranscribeHearing(transcribe.send), ...overrides });
  closers.push(h.close);
  const sarah = await linkNewOrganiser(h);
  await residentAllows(h, sarah.householdId, sarah.userId);
  return { h, sarah, heard: transcribe.heard };
}

describe('POST /api/hear — a spoken question, turned into words', () => {
  it('streams exactly the bytes sent, in order, to Transcribe as 16 kHz PCM in English, and answers with the final words only', async () => {
    const { h, sarah, heard } = await home();
    const sent = pcm(3 * HEAR_CHUNK_BYTES + 100);

    const res = await hear(h, sarah, sent);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'How has Mum been this week?' });
    expect(heard.requests).toEqual([{ LanguageCode: 'en-US', MediaEncoding: 'pcm', MediaSampleRateHertz: HEAR_SAMPLE_RATE }]);
    expect(Buffer.from(heard.audio[0]!).equals(Buffer.from(sent))).toBe(true);
    // Chunks of about 8 KB, the last one whatever is left.
    expect(heard.chunkSizes[0]).toEqual([HEAR_CHUNK_BYTES, HEAR_CHUNK_BYTES, HEAR_CHUNK_BYTES, 100]);
  });

  it('takes application/octet-stream as well', async () => {
    const { h, sarah, heard } = await home();
    const res = await hear(h, sarah, pcm(640), 'application/octet-stream');
    expect(res.status).toBe(200);
    expect(heard.audio).toHaveLength(1);
  });

  it('answers 200 with empty text when nothing was understood: the page says so in its own words', async () => {
    const { h, sarah } = await home(() => '');
    const res = await hear(h, sarah, pcm(3200));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '' });
  });

  it('is for someone signed in: 401 with no token, or a token that is not one — and Transcribe is not asked', async () => {
    const { h, heard } = await home();

    expect((await hear(h, null, pcm(640))).status).toBe(401);
    expect((await hear(h, { tokens: { access_token: 'not-a-token', refresh_token: '', expires_in: 0 } }, pcm(640))).status).toBe(401);
    expect(heard.requests).toEqual([]);
  });

  it('lets the family app’s browser send it: the preflight allows the headers it sets', async () => {
    const { h } = await home();
    const res = await fetch(`${h.base}/api/hear`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('takes ten seconds of audio and a little more, and refuses one byte past that with 413 — before Transcribe hears any of it', async () => {
    const { h, sarah, heard } = await home();
    expect(MAX_HEAR_BYTES).toBe(328_000);
    expect(MAX_HEAR_BYTES).toBeGreaterThanOrEqual(10 * 16_000 * 2);

    expect((await hear(h, sarah, pcm(10 * 16_000 * 2))).status).toBe(200);
    expect((await hear(h, sarah, pcm(MAX_HEAR_BYTES))).status).toBe(200);

    const res = await hear(h, sarah, pcm(MAX_HEAR_BYTES + 2));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_long', message: HEAR_WORDS.tooLong });
    expect(heard.requests).toHaveLength(2);
  });

  it.each([['audio/wav'], ['audio/webm'], ['application/json'], ['text/plain'], ['multipart/form-data; boundary=x'], ['audio/l16; rate=44100'], ['audio/l16; rate=16000; channels=2']])(
    'refuses %s with 415: Wick hears 16 kHz mono PCM and nothing else',
    async (contentType) => {
      const { h, sarah, heard } = await home();
      const res = await hear(h, sarah, contentType === 'application/json' ? '{"text":"hello"}' : pcm(640), contentType);
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: 'not_audio', message: HEAR_WORDS.notAudio });
      expect(heard.requests).toEqual([]);
    },
  );

  it('refuses no content type at all with 415, an empty body and an odd number of bytes with 400', async () => {
    const { h, sarah, heard } = await home();

    expect((await hear(h, sarah, pcm(640), null)).status).toBe(415);
    const empty = await hear(h, sarah, new Uint8Array());
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'empty', message: HEAR_WORDS.empty });
    expect((await hear(h, sarah, pcm(641))).status).toBe(400);
    expect(heard.requests).toEqual([]);
  });

  it(`hears a person ${HEARINGS_PER_PERSON_PER_MINUTE} times a minute and refuses the next with 429 — that person only, and only for the minute`, async () => {
    // From the real clock: the invitation below is accepted against it, and a fixed hour stops working once that hour has passed.
    let now = Date.now();
    const { h, sarah, heard } = await home(undefined, { now: () => now });
    const tom = await linkInvited(h, TOM, await invitation(h, sarah));
    await residentAllows(h, tom.householdId, tom.userId);

    for (let i = 0; i < HEARINGS_PER_PERSON_PER_MINUTE; i++) expect((await hear(h, sarah, pcm(640))).status).toBe(200);
    const refused = await hear(h, sarah, pcm(640));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'too_many', message: HEAR_WORDS.busy });
    expect(heard.requests).toHaveLength(HEARINGS_PER_PERSON_PER_MINUTE);

    // Somebody else in the same home is not held to Sarah's minute.
    expect((await hear(h, tom, pcm(640))).status).toBe(200);

    now += 60_000;
    expect((await hear(h, sarah, pcm(640))).status).toBe(200);
  });

  it('hears someone still waiting for her press — they may ask the app what to do next — but not someone turned down or removed', async () => {
    const { h, sarah, heard } = await home();
    const tom = await linkInvited(h, TOM, await invitation(h, sarah));

    expect((await hear(h, tom, pcm(640))).status).toBe(200);

    await h.store.setMemberStatus(tom.householdId, tom.userId, 'declined', Date.now());
    const declined = await hear(h, tom, pcm(640));
    expect(declined.status).toBe(403);
    expect(await declined.json()).toEqual({ error: 'not_a_member', message: 'Margaret chose not to share this with you.' });

    await h.store.setMemberStatus(tom.householdId, tom.userId, 'removed', Date.now());
    expect((await hear(h, tom, pcm(640))).status).toBe(403);
    expect(heard.requests).toHaveLength(1);
  });

  it('says so in words where this Wick cannot hear, and when Transcribe fails — and never says why', async () => {
    const without = await startServer();
    closers.push(without.close);
    const sarah = await linkNewOrganiser(without);
    const res = await hear(without, sarah, pcm(640));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'hearing_unavailable', message: HEAR_WORDS.unavailable });

    const failing = await startServer({
      hear: createTranscribeHearing(async () => {
        throw Object.assign(new Error('arn:aws:transcribe:us-east-1:123456789012 is not authorized'), { name: 'AccessDeniedException' });
      }),
    });
    closers.push(failing.close);
    const priya = await linkNewOrganiser(failing);
    const failed = await hear(failing, priya, pcm(640));
    expect(failed.status).toBe(502);
    const body = await failed.text();
    expect(JSON.parse(body)).toEqual({ error: 'hearing_failed', message: HEAR_WORDS.failed });
    expect(body).not.toMatch(/arn|123456789012|AccessDenied/);
  });
});

describe('nothing of the audio is kept or logged', () => {
  it('logs one line per hearing — its outcome and how long it took — and never the bytes, their length or the words', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { h, sarah } = await home(() => 'Is the light on at Mum’s?');
    const sent = pcm(12_346, 9);

    expect((await hear(h, sarah, sent)).status).toBe(200);

    const lines = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls, ...info.mock.calls].map((args) => args.map(String).join(' '));
    const hearings = lines.filter((line) => line.includes('"msg":"hear"'));
    expect(hearings).toHaveLength(1);
    expect(Object.keys(JSON.parse(hearings[0]!)).sort()).toEqual(['level', 'ms', 'msg', 'outcome']);
    expect(JSON.parse(hearings[0]!)).toMatchObject({ msg: 'hear', outcome: 'heard' });
    const everything = lines.join('\n');
    expect(everything).not.toContain('12346');
    expect(everything).not.toContain('12,346');
    expect(everything).not.toMatch(/light on/i);
    expect(everything).not.toContain(Buffer.from(sent.subarray(0, 64)).toString('base64'));
    expect(everything).not.toContain(Buffer.from(sent.subarray(0, 32)).toString('hex'));
  });

  it('logs a failure by its name alone', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await startServer({
      hear: createTranscribeHearing(async () => {
        throw Object.assign(new Error('the words were: ring me now'), { name: 'BadRequestException' });
      }),
    });
    closers.push(h.close);
    const sarah = await linkNewOrganiser(h);

    expect((await hear(h, sarah, pcm(640))).status).toBe(502);

    const everything = [...log.mock.calls, ...error.mock.calls].map((args) => args.map(String).join(' ')).join('\n');
    expect(everything).toContain('"err":"BadRequestException"');
    expect(everything).not.toMatch(/ring me now/);
  });
});

describe('INV-8: there is no household to name', () => {
  it('hears whatever a request names, and the answer is the words alone', async () => {
    const { h, sarah, heard } = await home();
    const priya = await linkNewOrganiser(h, { name: 'Priya', email: 'priya@example.com', password: 'another long passphrase' }, 'Asha');

    const res = await fetch(`${h.base}/api/hear?householdId=${priya.householdId}&household=${priya.householdId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sarah.tokens.access_token}`, 'content-type': L16, 'x-household-id': priya.householdId },
      body: pcm(640),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['text']);
    expect(JSON.stringify(body)).not.toContain(priya.householdId);
    expect(JSON.stringify(body)).not.toContain(sarah.householdId);
    expect(heard.requests).toHaveLength(1);
  });

  it('has no route that takes a household in its address', async () => {
    const { h, sarah } = await home();
    for (const path of [`/api/hear/${sarah.householdId}`, `/api/households/${sarah.householdId}/hear`]) {
      expect((await hear(h, sarah, pcm(640), L16, path)).status, path).toBe(404);
    }
  });
});

describe('the rest of the server is as it was', () => {
  it('still reads JSON where JSON is sent, and never takes audio for it', async () => {
    const { h, sarah } = await home();
    const elsewhere = await hear(h, sarah, pcm(640), L16, '/api/circle/invitations');
    expect(elsewhere.status).toBe(201);
    expect(await elsewhere.json()).toMatchObject({ role: 'family' });
  });
});

async function invitation(h: Harness, organiser: Linked): Promise<string> {
  const res = await fetch(`${h.base}/api/circle/invitations`, { method: 'POST', headers: { authorization: `Bearer ${organiser.tokens.access_token}` } });
  return ((await res.json()) as { code: string }).code;
}
