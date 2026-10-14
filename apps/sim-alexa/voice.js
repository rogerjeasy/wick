/**
 * Ask by voice — what the family app does with the sound of a question
 * before it sends it, with no DOM and no network, so it is tested
 * (./__tests__/voice.test.ts).
 *
 * One short utterance, at most ten seconds, captured from the microphone at
 * whatever rate the browser's audio runs (44.1 or 48 kHz, usually), is
 * brought down to 16 kHz, one channel, and written as signed 16-bit
 * little-endian PCM: what Amazon Transcribe's streaming API takes as `pcm`.
 * The page sends those bytes to the Wick server (`POST /api/hear`), which
 * hands them to Transcribe and answers with the words; the page then asks
 * the words exactly as if they had been typed.
 *
 * Not the browser's own SpeechRecognition: in most browsers that sends the
 * sound to a third party the family never chose. Here it goes to the Wick
 * server and to Transcribe, and nowhere else, and is kept by neither.
 */

/** Samples a second sent (packages/contracts hear.ts HEAR_SAMPLE_RATE; a test holds them equal). */
export const HEAR_SAMPLE_RATE = 16_000;
/** The longest utterance: listening stops by itself at ten seconds (contracts HEAR_MAX_MS). */
export const HEAR_MAX_MS = 10_000;
/** The most the server reads (contracts MAX_HEAR_BYTES): ten seconds and a quarter. The page never sends more than ten. */
export const MAX_HEAR_BYTES = 328_000;
/** What the page calls the body. The server takes this or application/octet-stream. */
export const HEAR_CONTENT_TYPE = 'audio/l16; rate=16000; channels=1';
/** A press held at least this long is push-to-talk: letting go stops listening. A shorter one is a toggle. */
export const HOLD_MS = 600;

/** What the control says, aloud and on the page. */
export const VOICE_WORDS = {
  label: 'Ask by voice',
  listening: 'Listening… press again to stop',
  hearing: 'Hearing…',
  missed: 'Didn’t catch that — try again or type it.',
  blocked: 'Wick could not use the microphone. Allow it for this page, or type your question.',
  unavailable: 'This Wick cannot hear a question yet. Type it instead.',
  explained: 'Amazon Transcribe turns it into words; Wick keeps no recording.',
};

/**
 * Whether this browser can be asked for a microphone at all, and can read
 * one. Where it cannot, the control is not shown: a button that can only
 * fail is worse than none.
 *
 * @param {any} nav  the page's `navigator`
 * @param {any} win  the page's `window`
 */
export function voiceAvailable(nav, win) {
  return typeof nav?.mediaDevices?.getUserMedia === 'function' && typeof (win?.AudioContext ?? win?.webkitAudioContext) === 'function';
}

/**
 * Brings audio from `fromRate` to `toRate`. Down: each output sample is the
 * mean of the input samples it stands for — a box filter, which keeps the
 * hiss above 8 kHz from folding back into the voice. Up (a rare browser
 * running below 16 kHz): straight lines between the samples there are.
 *
 * @param {Float32Array} samples
 * @param {number} fromRate
 * @param {number} [toRate]
 * @returns {Float32Array}
 */
export function downsample(samples, fromRate, toRate = HEAR_SAMPLE_RATE) {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('A sample rate is a positive number.');
  if (fromRate === toRate) return Float32Array.from(samples);
  const ratio = fromRate / toRate;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  if (ratio > 1) {
    for (let i = 0; i < length; i++) {
      const from = Math.floor(i * ratio);
      const to = Math.min(samples.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = from; j < to; j++) sum += samples[j];
      out[i] = sum / (to - from);
    }
  } else {
    for (let i = 0; i < length; i++) {
      const at = i * ratio;
      const j = Math.floor(at);
      const next = Math.min(j + 1, samples.length - 1);
      out[i] = samples[j] + (samples[next] - samples[j]) * (at - j);
    }
  }
  return out;
}

/**
 * Float samples in [-1, 1] as signed 16-bit little-endian PCM. Anything
 * louder than full scale is held at full scale, never wrapped round.
 *
 * @param {Float32Array} samples
 * @returns {Uint8Array}
 */
export function encodePcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return bytes;
}

/**
 * What was captured, as the bytes the page sends: the frames joined, brought
 * to 16 kHz, cut at ten seconds and encoded.
 *
 * @param {Float32Array[]} frames  as the microphone gave them, in order
 * @param {number} fromRate  the AudioContext's sample rate
 * @returns {Uint8Array}
 */
export function utterancePcm(frames, fromRate) {
  const length = frames.reduce((n, frame) => n + frame.length, 0);
  const joined = new Float32Array(length);
  let at = 0;
  for (const frame of frames) {
    joined.set(frame, at);
    at += frame.length;
  }
  const down = downsample(joined, fromRate);
  return encodePcm16(down.subarray(0, (HEAR_MAX_MS / 1000) * HEAR_SAMPLE_RATE));
}

/**
 * What the server's answer means for the page: words to ask, or a sentence
 * to say instead. Empty words are the page's own "didn't catch that".
 *
 * @param {number} status
 * @param {{text?: unknown, message?: unknown}} body
 * @returns {{ask: string} | {say: string}}
 */
export function heardAnswer(status, body) {
  if (status === 200) {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    return text ? { ask: text } : { say: VOICE_WORDS.missed };
  }
  if (status === 404) return { say: VOICE_WORDS.unavailable };
  return { say: typeof body?.message === 'string' && body.message ? body.message : VOICE_WORDS.missed };
}

/**
 * The AudioWorklet that hands the page the microphone's samples, a frame at
 * a time: ./capture-worklet.js, published beside the page. A file of the
 * page's own rather than a Blob, because the page's Content-Security-Policy
 * runs scripts from its own origin and from no `blob:` address
 * (infra/csp/family-app.csp). Where AudioWorklet is missing, main.js falls
 * back to a ScriptProcessor.
 */
export const CAPTURE_WORKLET_NAME = 'wick-capture';
export const CAPTURE_WORKLET_URL = './capture-worklet.js';
