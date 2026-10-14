/**
 * Ask by voice, in the family app: a family member's own question, spoken
 * instead of typed, turned into words by Amazon Transcribe and then asked
 * exactly as if it had been typed (services/mcp-server/src/hear,
 * apps/sim-alexa/voice.js).
 *
 * What travels is one short utterance as raw audio — mono, 16 kHz, signed
 * 16-bit little-endian PCM — in the body of one POST. Nothing of it is kept:
 * not the sound, not its length, not the words once they are answered.
 *
 * The resident's television has no microphone and is never listened to.
 */

/** Samples a second: what the page sends and what Transcribe is told. */
export const HEAR_SAMPLE_RATE = 16_000;

/** Two bytes a sample (16-bit), one channel. */
export const HEAR_BYTES_PER_SAMPLE = 2;

/** The longest utterance the page records: it stops by itself at ten seconds. */
export const HEAR_MAX_MS = 10_000;

/**
 * The most the server reads: ten seconds of audio, and a quarter of a
 * second more for a page whose clock and microphone disagree by a frame.
 * 10 s × 16 000 × 2 = 320 000 bytes; with the quarter second, 328 000.
 */
export const MAX_HEAR_BYTES = (HEAR_MAX_MS / 1000) * HEAR_SAMPLE_RATE * HEAR_BYTES_PER_SAMPLE + (HEAR_SAMPLE_RATE * HEAR_BYTES_PER_SAMPLE) / 4;
