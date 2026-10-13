/**
 * Read to me, the edge's half (packages/contracts/src/speech.ts).
 *
 * While a card is on her screen, the Play key asks for it to be read: the
 * television sends `{ t: 'read', cardId }`, and the edge answers that one
 * television with a short-lived address of the reading. This file is the
 * reading: what is said, in which voice, the name it is kept under, the
 * bound on how often, and the order in which it is all done.
 *
 * THE RULES are the contract's, and this is how each is kept here:
 *
 *   - Only when she asks. Nothing here runs but as the answer to her own
 *     television's `read` (device-event.mjs).
 *   - What is read is the card as her television shows it, and nothing that
 *     is not on the screen: the caller hands in that card — the stored
 *     English put through the one wrapper every send passes (language.mjs),
 *     so her language and the translation kept beside the card — and
 *     `speechTextOf`, the contract's own (speech.generated.mjs, a generated
 *     copy), says what of it is read.
 *   - The voice is the household's language's (the contract's
 *     SPEECH_VOICES), one for the whole card. A passage that is still in
 *     English on her screen — a note no translation was kept for — is read
 *     as it is, by that same voice: the reading follows the screen, and a
 *     card does not change voices halfway down.
 *   - The words go to Amazon Polly as SSML this file builds: the passages,
 *     a pause between them, and nothing else. Every passage is escaped, so
 *     nothing a family note contains can be markup — it cannot change the
 *     voice, the volume, or fetch a sound.
 *   - Made once, kept a day: the object is named by a hash of the language,
 *     the voice and the exact SSML (`tts/<household>/<hash>.mp3`), so the
 *     same card read twice is made once, and the bucket lets it go
 *     (infra/core.tf).
 *   - At most thirty readings a household in an hour — one counter row for
 *     the hour, cleared away by the table.
 *   - Nothing about the reading reaches the family, or a log: the counter
 *     row says a number and an hour, and is kept where no family tool
 *     reads; a failure is logged by its reason alone — never the text, the
 *     address or the card.
 *
 * And it never keeps her waiting, and never costs her anything else: one
 * time limit for the whole answer, and every way it can fail is the same
 * quiet answer — no address — which the television takes as "nothing
 * changed".
 *
 * Pure but for what it is handed: device-event.mjs owns the clients.
 */
import { createHash } from 'node:crypto';
import { isReplayable, replayedCard } from './card-acted.mjs';
import { credentialsFromEnv, presignGet } from './presign.mjs';
import { SPEECH_URL_TTL_SEC, SPEECH_VOICES, speechObjectKey, speechTextOf } from './speech.generated.mjs';

/** The longest the whole answer may take. */
export const READING_TIME_LIMIT_MS = 4000;
export const MAX_READINGS_AN_HOUR = 30;
/** The hour's counter row: `HH#<household>` / `TRY#READ#<hour>`, beside the server's own `TRY#…` counters. */
export const READ_SK_PREFIX = 'TRY#READ#';

const HOUR_MS = 3_600_000;
const PAUSE = '<break time="600ms"/>';

/** Characters XML 1.0 cannot carry at all: one of them and the whole document is refused. */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (text) => text.replace(NOT_XML, '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * The SSML for a reading: the passages in order, a pause between them, and
 * nothing else — or undefined when there is nothing to say.
 */
export function ssmlOf(passages) {
  const said = (passages ?? []).filter((passage) => typeof passage === 'string' && passage.trim().length > 0).map((passage) => escapeXml(passage.trim()));
  if (said.length === 0) return undefined;
  return `<speak>${said.join(PAUSE)}</speak>`;
}

/**
 * A reading: what is said, in which voice, and the hash it is kept under —
 * of the language, the voice and the exact SSML, and of nothing else.
 * Undefined when there is nothing to read, or no voice for the language.
 */
export function readingOf({ language, passages, voices = SPEECH_VOICES }) {
  const voice = Object.hasOwn(voices, language) ? voices[language] : undefined;
  const ssml = ssmlOf(passages);
  if (!voice || !ssml) return undefined;
  const hash = createHash('sha256').update(`${language}\n${voice.voiceId}\n${ssml}`, 'utf8').digest('hex');
  return { language, voice, ssml, hash };
}

/** SynthesizeSpeech input for a reading. */
export function synthesisInput(reading) {
  return {
    Engine: 'neural',
    OutputFormat: 'mp3',
    TextType: 'ssml',
    Text: reading.ssml,
    VoiceId: reading.voice.voiceId,
    LanguageCode: reading.voice.languageCode,
  };
}

/**
 * UpdateItem input counting one reading in this hour — refused past the
 * thirtieth. The row says how many and nothing of what; the table clears it
 * away an hour after its hour is over.
 */
export function readingClaim({ table, householdId, now }) {
  const hour = Math.floor(now / HOUR_MS);
  return {
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `${READ_SK_PREFIX}${hour}` } },
    UpdateExpression: 'ADD tries :one SET #ttl = :ttl',
    ConditionExpression: 'attribute_not_exists(tries) OR tries < :max',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':one': { N: '1' }, ':max': { N: String(MAX_READINGS_AN_HOUR) }, ':ttl': { N: String((hour + 2) * 3600) } },
  };
}

/**
 * A stored card that can still be on her screen — the same rule reconcile
 * replays by (card-acted.mjs): there, not answered, and for a door card not
 * yet over. Undefined otherwise: a card she cannot be looking at is not read.
 */
export function readableCard(item, now) {
  if (!item?.data?.S) return undefined;
  try {
    return isReplayable(item, now) ? replayedCard(item) : undefined;
  } catch {
    return undefined;
  }
}

/** A reading's own key, and nothing else in the bucket: `tts/<household>/<hash>.mp3` (contracts speechObjectKey). */
const READING_KEY = /^tts\/[^/]+\/[0-9a-f]{64}\.mp3$/;

/**
 * A short-lived address for one reading — good for as long as it takes to
 * play (the contract's SPEECH_URL_TTL_SEC) — or undefined when one cannot
 * be made: no bucket configured, no credentials, or a key that is not a
 * reading's. Never throws. Signed by hand (presign.mjs); it is returned to
 * whoever is answering the television, and goes nowhere else.
 *
 * The bucket is the media bucket, which also holds what the door saw: this
 * signs for `tts/` and for nothing beside it.
 */
export function readingAddress({ bucket, key, env = process.env, now = Date.now() }) {
  if (!bucket || typeof key !== 'string' || !READING_KEY.test(key) || key.includes('..')) return undefined;
  const who = credentialsFromEnv(env);
  if (!who) return undefined;
  try {
    return presignGet({ bucket, key, region: who.region, credentials: who.credentials, expiresSec: SPEECH_URL_TTL_SEC, now });
  } catch {
    return undefined;
  }
}

const REACH_OFFER = /^reach-(\d{1,16})$/;

/**
 * The request a Reach card offers, from the card's id — for the one card
 * that is on her screen before anything is stored (reach.mjs: the offer her
 * hold brings). Its id is this server's clock at the hold, and nothing else is.
 */
export function reachOfferId(cardId) {
  const match = typeof cardId === 'string' ? REACH_OFFER.exec(cardId) : null;
  return match ? match[1] : undefined;
}

/**
 * The address of a reading of the card on her screen — or undefined, for
 * every reason there might be none. Never throws, and never takes longer
 * than the time limit.
 *
 * @param {object} input
 * @param {string} input.householdId  the television's own, from its connection (INV-8)
 * @param {() => Promise<object | undefined>} input.card  the card as her television shows it, or nothing
 * @param {() => Promise<string>} input.language  the household's language
 * @param {() => Promise<boolean>} input.claim  count this reading; false past the hour's bound
 * @param {(key: string) => Promise<boolean>} input.kept  whether the reading is kept already
 * @param {(input: object, signal: AbortSignal) => Promise<Uint8Array>} input.synthesize  Amazon Polly
 * @param {(key: string, bytes: Uint8Array, signal: AbortSignal) => Promise<void>} input.keep  put it in the bucket
 * @param {(key: string) => string | undefined} input.address  a short-lived address for that object
 */
export async function answerReading({ householdId, card, language, claim, kept, synthesize, keep, address, timeoutMs = READING_TIME_LIMIT_MS, log = (line) => console.error(JSON.stringify(line)) }) {
  const stop = new AbortController();
  const TIMED_OUT = Symbol('timed out');
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
  });

  const read = async () => {
    const shown = await card();
    if (!shown) return undefined;
    const reading = readingOf({ language: await language(), passages: speechTextOf(shown) });
    // Nothing on the card to read, or no voice for the language.
    if (!reading) return undefined;

    const key = speechObjectKey(householdId, reading.hash);
    // Signing is done here and costs nothing: without an address there is no point counting, or making, anything.
    const url = address(key);
    if (!url) return undefined;

    if (!(await claim())) return undefined;

    let have = false;
    try {
      have = await kept(key);
    } catch {
      // Not knowing whether it is kept only means making it again.
    }
    if (!have) {
      const bytes = await synthesize(synthesisInput(reading), stop.signal);
      if (!bytes || bytes.length === 0) throw Object.assign(new Error('the voice said nothing'), { name: 'EmptyAudio' });
      await keep(key, bytes, stop.signal);
    }
    return url;
  };

  try {
    const answer = await Promise.race([read(), limit]);
    if (answer !== TIMED_OUT) return answer;
    log({ level: 'error', msg: 'reading_failed', reason: 'timeout' });
    return undefined;
  } catch (err) {
    // Why, and never what was to be read, where it is kept, or for which card.
    log({ level: 'error', msg: 'reading_failed', reason: stop.signal.aborted ? 'timeout' : (err?.name ?? 'error') });
    return undefined;
  } finally {
    clearTimeout(timer);
    // Whatever is still under way is told to stop: nothing of it will be used.
    stop.abort();
  }
}
