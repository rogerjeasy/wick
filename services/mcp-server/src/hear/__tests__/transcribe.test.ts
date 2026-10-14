import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartStreamTranscriptionCommand, type TranscriptResultStream } from '@aws-sdk/client-transcribe-streaming';
import { HEAR_CHUNK_BYTES, HEAR_TIMEOUT_MS, audioChunks, createTranscribeHearing, transcriptOf } from '../transcribe.js';

afterEach(() => {
  vi.useRealTimers();
});

async function* stream(...events: TranscriptResultStream[]): AsyncGenerator<TranscriptResultStream> {
  for (const event of events) yield event;
}
const result = (Transcript: string, IsPartial: boolean): TranscriptResultStream => ({
  TranscriptEvent: { Transcript: { Results: [{ IsPartial, Alternatives: [{ Transcript }] }] } },
});

describe('audioChunks — the utterance as Transcribe’s input stream', () => {
  it('yields every byte, in order, in AudioEvents of 8 KB and the rest', async () => {
    const pcm = Uint8Array.from({ length: 2 * HEAR_CHUNK_BYTES + 6 }, (_, i) => i & 0xff);
    const events = [];
    for await (const event of audioChunks(pcm)) events.push(event);

    expect(events.every((e) => Object.keys(e).join() === 'AudioEvent')).toBe(true);
    const chunks = events.map((e) => e.AudioEvent!.AudioChunk!);
    expect(chunks.map((c) => c.length)).toEqual([HEAR_CHUNK_BYTES, HEAR_CHUNK_BYTES, 6]);
    expect(Buffer.concat(chunks).equals(Buffer.from(pcm))).toBe(true);
  });

  it('yields nothing for nothing', async () => {
    const events = [];
    for await (const event of audioChunks(new Uint8Array())) events.push(event);
    expect(events).toEqual([]);
  });
});

describe('transcriptOf — the words of the final results', () => {
  it('reads final results only, in order, and never a partial one', async () => {
    expect(await transcriptOf(stream(result('how is', true), result('How is Mum?', false), result('is the', true), result('Is the light on?', false)))).toBe('How is Mum? Is the light on?');
  });

  it('is empty when nothing was understood, or there was no stream', async () => {
    expect(await transcriptOf(stream({ TranscriptEvent: { Transcript: { Results: [] } } }))).toBe('');
    expect(await transcriptOf(stream(result('   ', false)))).toBe('');
    expect(await transcriptOf(undefined)).toBe('');
  });

  it('throws an exception Transcribe put in the stream, by its name and nothing more', async () => {
    const failed = { BadRequestException: { Message: 'secret words' } } as unknown as TranscriptResultStream;
    await expect(transcriptOf(stream(failed))).rejects.toMatchObject({ name: 'BadRequestException', message: 'BadRequestException' });
  });
});

describe('createTranscribeHearing', () => {
  it('asks Transcribe for en-US PCM at 16 kHz, with the utterance as its stream', async () => {
    let asked: StartStreamTranscriptionCommand | undefined;
    const hear = createTranscribeHearing(async (command) => {
      asked = command;
      for await (const _ of command.input.AudioStream!) void _;
      return { TranscriptResultStream: stream(result('Hello', false)) };
    });

    expect(await hear(new Uint8Array(64))).toBe('Hello');
    expect(asked).toBeInstanceOf(StartStreamTranscriptionCommand);
    expect(asked!.input).toMatchObject({ LanguageCode: 'en-US', MediaEncoding: 'pcm', MediaSampleRateHertz: 16_000 });
  });

  it(`gives up after ${HEAR_TIMEOUT_MS / 1000} seconds by aborting the request`, async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const hear = createTranscribeHearing(
      (_command, options) =>
        new Promise((_resolve, reject) => {
          signal = options?.abortSignal;
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );

    const heard = hear(new Uint8Array(64));
    const outcome = expect(heard).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(HEAR_TIMEOUT_MS);
    await outcome;
    expect(signal?.aborted).toBe(true);
  });
});
