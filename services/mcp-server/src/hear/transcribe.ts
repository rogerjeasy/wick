/**
 * Ask by voice: a family member's own question, spoken in the family app,
 * turned into words by Amazon Transcribe (packages/contracts hear.ts).
 *
 * The page sends one short utterance — mono, 16 kHz, signed 16-bit
 * little-endian PCM — as the body of one POST (hear/routes.ts). This streams
 * those bytes to Transcribe's streaming API, in order, in chunks of 8 KB
 * (a quarter of a second each: Transcribe's own advice is chunks of 50 to
 * 200 ms, and an AudioEvent of no more than a second), and keeps the words
 * of the final results — never a partial one, which is Transcribe still
 * changing its mind.
 *
 * Why one POST and not a socket: the Wick server runs on App Runner, which
 * has no WebSocket support (FRICTION.md FL-032), and the family app holds
 * no AWS credential and frames no AWS event stream — it is a page with no
 * build step. So the page sends the whole utterance once it has ended.
 *
 * Nothing is kept. The bytes are read from memory into the stream and
 * dropped with the request; nothing of them is logged, not even their
 * length, and no error from here carries them.
 */
import { StartStreamTranscriptionCommand, type AudioStream, type TranscriptResultStream } from '@aws-sdk/client-transcribe-streaming';
import { HEAR_SAMPLE_RATE } from '@wick/contracts';

/** Turns one utterance into the words that were said. Empty when nothing was understood. */
export type Hear = (pcm: Uint8Array) => Promise<string>;

/** The language heard. The family app's questions are in English, as its answers are. */
export const HEAR_LANGUAGE = 'en-US';
/** How much audio goes in one AudioEvent: a quarter of a second at 16 kHz, 16-bit. */
export const HEAR_CHUNK_BYTES = 8_192;
/** How long Transcribe is given for one utterance of ten seconds at most. */
export const HEAR_TIMEOUT_MS = 15_000;

/** A TranscribeStreamingClient's send, injected so the exact request is tested without AWS. */
export type TranscribeSend = (
  command: StartStreamTranscriptionCommand,
  options?: { readonly abortSignal?: AbortSignal },
) => Promise<{ readonly TranscriptResultStream?: AsyncIterable<TranscriptResultStream> | undefined }>;

/** The utterance, as Transcribe's input stream: its bytes in order, a chunk at a time, and nothing else. */
export async function* audioChunks(pcm: Uint8Array, size = HEAR_CHUNK_BYTES): AsyncGenerator<AudioStream> {
  for (let at = 0; at < pcm.length; at += size) {
    yield { AudioEvent: { AudioChunk: pcm.subarray(at, Math.min(at + size, pcm.length)) } };
  }
}

/**
 * The words of the final results, in order, joined by a space. A partial
 * result is never read. An exception Transcribe puts in the stream is
 * thrown — by its name alone, which says nothing of what was said.
 */
export async function transcriptOf(stream: AsyncIterable<TranscriptResultStream> | undefined): Promise<string> {
  const words: string[] = [];
  if (!stream) return '';
  for await (const event of stream) {
    const results = event.TranscriptEvent?.Transcript?.Results;
    if (!results) {
      const failed = Object.keys(event).find((key) => key.endsWith('Exception'));
      if (failed) throw Object.assign(new Error(failed), { name: failed });
      continue;
    }
    for (const result of results) {
      if (result.IsPartial !== false) continue;
      const said = result.Alternatives?.[0]?.Transcript?.trim();
      if (said) words.push(said);
    }
  }
  return words.join(' ').trim();
}

/** Hearing through Transcribe's streaming API, given up after HEAR_TIMEOUT_MS. */
export function createTranscribeHearing(send: TranscribeSend, timeoutMs = HEAR_TIMEOUT_MS): Hear {
  return async (pcm) => {
    const givenUp = new AbortController();
    const timer = setTimeout(() => givenUp.abort(), timeoutMs);
    try {
      const reply = await send(
        new StartStreamTranscriptionCommand({
          LanguageCode: HEAR_LANGUAGE,
          MediaEncoding: 'pcm',
          MediaSampleRateHertz: HEAR_SAMPLE_RATE,
          AudioStream: audioChunks(pcm),
        }),
        { abortSignal: givenUp.signal },
      );
      return await transcriptOf(reply.TranscriptResultStream);
    } finally {
      clearTimeout(timer);
    }
  };
}
