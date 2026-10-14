import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain browser module, deliberately untyped (no build step).
import {
  CAPTURE_WORKLET_NAME,
  CAPTURE_WORKLET_URL,
  HEAR_CONTENT_TYPE,
  HEAR_MAX_MS,
  HEAR_SAMPLE_RATE,
  HOLD_MS,
  MAX_HEAR_BYTES,
  VOICE_WORDS,
  downsample,
  encodePcm16,
  heardAnswer,
  utterancePcm,
  voiceAvailable,
} from '../voice.js';
// @ts-expect-error — a plain browser module, deliberately untyped (no build step).
import { REQUEST_LIMITS_MS, requestLimitFor } from '../surface.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as HEAR from '../../../packages/contracts/src/hear.js';
import { HEAR_TIMEOUT_MS } from '../../../services/mcp-server/src/hear/transcribe.js';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('voice.js — the numbers are the server’s', () => {
  it('holds its rate, length and size to packages/contracts hear.ts', () => {
    expect(HEAR_SAMPLE_RATE).toBe(HEAR.HEAR_SAMPLE_RATE);
    expect(HEAR_MAX_MS).toBe(HEAR.HEAR_MAX_MS);
    expect(MAX_HEAR_BYTES).toBe(HEAR.MAX_HEAR_BYTES);
    expect(HEAR_CONTENT_TYPE).toBe('audio/l16; rate=16000; channels=1');
  });

  it('waits for an answer longer than the server waits for Transcribe', () => {
    expect(requestLimitFor('/api/hear', 'POST')).toBe(REQUEST_LIMITS_MS.hear);
    expect(requestLimitFor('/api/hear', 'post')).toBe(REQUEST_LIMITS_MS.hear);
    expect(REQUEST_LIMITS_MS.hear).toBeGreaterThan(HEAR_TIMEOUT_MS);
  });
});

describe('downsample — to 16 kHz from whatever the browser runs at', () => {
  it('takes 48 kHz to 16 kHz as the mean of each three samples', () => {
    const out = downsample(Float32Array.from([0.3, 0.6, 0.9, -0.3, -0.6, -0.9, 0, 0, 0.3]), 48_000);
    expect(Array.from(out).map((v) => Number(v.toFixed(5)))).toEqual([0.6, -0.6, 0.1]);
  });

  it('gives a second of audio a second’s worth of samples, at 44.1 kHz too', () => {
    expect(downsample(new Float32Array(48_000), 48_000)).toHaveLength(16_000);
    expect(downsample(new Float32Array(44_100), 44_100)).toHaveLength(16_000);
    expect(downsample(new Float32Array(16_000), 16_000)).toHaveLength(16_000);
  });

  it('keeps a quiet tone in the voice band and takes away most of one above 8 kHz', () => {
    const tone = (hz: number) => Float32Array.from({ length: 48_000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / 48_000));
    const loudness = (s: Float32Array) => Math.sqrt(s.reduce((sum, v) => sum + v * v, 0) / s.length);
    expect(loudness(downsample(tone(300), 48_000))).toBeGreaterThan(0.34);
    expect(loudness(downsample(tone(15_000), 48_000))).toBeLessThan(0.1);
  });

  it('returns a copy at the same rate, and draws straight lines up from a lower one', () => {
    const same = Float32Array.from([0.1, 0.2]);
    expect(downsample(same, 16_000)).not.toBe(same);
    expect(Array.from(downsample(Float32Array.from([0, 1, 0, -1]), 8_000)).map((v) => Number(v.toFixed(5)))).toEqual([0, 0.5, 1, 0.5, 0, -0.5, -1, -1]);
  });

  it('refuses a rate that is not one', () => {
    expect(() => downsample(new Float32Array(4), 0)).toThrow(RangeError);
    expect(() => downsample(new Float32Array(4), Number.NaN)).toThrow(RangeError);
  });
});

describe('encodePcm16 — signed 16-bit little-endian', () => {
  it('writes each sample as two bytes, low byte first', () => {
    const bytes = encodePcm16(Float32Array.from([0, 1, -1, 0.5, -0.5]));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(10);
    const view = new DataView(bytes.buffer);
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(i * 2, true))).toEqual([0, 32767, -32768, 16384, -16384]);
    // Little-endian, by the bytes themselves: 32767 is ff 7f.
    expect(Array.from(bytes.subarray(2, 4))).toEqual([0xff, 0x7f]);
  });

  it('holds anything past full scale at full scale, and makes silence of what is not a number', () => {
    const view = new DataView(encodePcm16(Float32Array.from([3, -7, Number.NaN, Number.POSITIVE_INFINITY])).buffer);
    expect([0, 1, 2, 3].map((i) => view.getInt16(i * 2, true))).toEqual([32767, -32768, 0, 0]);
  });
});

describe('utterancePcm — what the page sends', () => {
  it('joins the frames in order, brings them to 16 kHz and encodes them', () => {
    const frames = [Float32Array.from([0.5, 0.5, 0.5]), Float32Array.from([-0.5, -0.5, -0.5])];
    const view = new DataView(utterancePcm(frames, 48_000).buffer);
    expect(view.byteLength).toBe(4);
    expect([view.getInt16(0, true), view.getInt16(2, true)]).toEqual([16384, -16384]);
  });

  it('never sends more than ten seconds, however long the microphone ran', () => {
    const minute = Array.from({ length: 60 }, () => new Float32Array(48_000).fill(0.1));
    const pcm = utterancePcm(minute, 48_000);
    expect(pcm).toHaveLength(10 * 16_000 * 2);
    expect(pcm.length).toBeLessThanOrEqual(MAX_HEAR_BYTES);
  });

  it('is empty for nothing at all', () => {
    expect(utterancePcm([], 48_000)).toHaveLength(0);
  });
});

describe('heardAnswer — what the page does with what was heard', () => {
  it('asks the words, trimmed', () => {
    expect(heardAnswer(200, { text: '  How has Mum been this week? ' })).toEqual({ ask: 'How has Mum been this week?' });
  });

  it('says it did not catch that, in plain words, when nothing was heard', () => {
    expect(VOICE_WORDS.missed).toBe('Didn’t catch that — try again or type it.');
    expect(heardAnswer(200, { text: '' })).toEqual({ say: VOICE_WORDS.missed });
    expect(heardAnswer(200, { text: '   ' })).toEqual({ say: VOICE_WORDS.missed });
    expect(heardAnswer(200, {})).toEqual({ say: VOICE_WORDS.missed });
  });

  it('says the server’s own words for a refusal, and its own against a Wick server from before this', () => {
    expect(heardAnswer(429, { message: 'That is a lot of asking out loud. Type it, or try again in a minute.' })).toEqual({ say: 'That is a lot of asking out loud. Type it, or try again in a minute.' });
    expect(heardAnswer(404, {})).toEqual({ say: VOICE_WORDS.unavailable });
    expect(heardAnswer(502, {})).toEqual({ say: VOICE_WORDS.missed });
  });
});

describe('the control is offered only where a microphone can be asked for', () => {
  class AudioContext {}

  it('is available with getUserMedia and an AudioContext, and not without either', () => {
    expect(voiceAvailable({ mediaDevices: { getUserMedia: () => undefined } }, { AudioContext })).toBe(true);
    expect(voiceAvailable({ mediaDevices: { getUserMedia: () => undefined } }, { webkitAudioContext: AudioContext })).toBe(true);
    expect(voiceAvailable({}, { AudioContext })).toBe(false);
    expect(voiceAvailable({ mediaDevices: {} }, { AudioContext })).toBe(false);
    expect(voiceAvailable(undefined, { AudioContext })).toBe(false);
    expect(voiceAvailable({ mediaDevices: { getUserMedia: () => undefined } }, {})).toBe(false);
  });

  const page = read('../index.html');
  const main = read('../main.js');
  const control = /<button id="ask-voice"[^>]*>/.exec(page)?.[0] ?? '';

  it('is hidden in the page as published, and shown by main.js only where voiceAvailable says so', () => {
    expect(control).toMatch(/\bhidden\b/);
    expect(/<p id="voice-line"[^>]*>/.exec(page)?.[0]).toMatch(/\bhidden\b/);
    expect(main).toMatch(/if \(voiceAvailable\(navigator, window\)\) \{\s*\$\('ask-voice'\)\.hidden = false;\s*\$\('voice-line'\)\.hidden = false;/);
    expect(main.match(/\$\('ask-voice'\)\.hidden = false/g)).toHaveLength(1);
  });

  it('is labelled for a screen reader, says whether it is listening, and has a status that is announced', () => {
    expect(VOICE_WORDS.label).toBe('Ask by voice');
    expect(control).toMatch(/aria-label="Ask by voice"/);
    expect(control).toMatch(/aria-pressed="false"/);
    expect(control).toMatch(/type="button"/);
    expect(page).toMatch(/<span id="voice-status"[^>]*role="status"[^>]*aria-live="polite"/);
    expect(VOICE_WORDS.listening).toBe('Listening… press again to stop');
    expect(VOICE_WORDS.hearing).toBe('Hearing…');
  });

  it('says, under the control, who turns it into words and that no recording is kept', () => {
    expect(VOICE_WORDS.explained).toBe('Amazon Transcribe turns it into words; Wick keeps no recording.');
    expect(page).toContain(`<span id="voice-note">${VOICE_WORDS.explained}</span>`);
    expect(control).toMatch(/aria-describedby="voice-note"/);
  });

  it('asks for the microphone on a press, never as the page loads', () => {
    const asks = [...main.matchAll(/getUserMedia\(/g)];
    expect(asks).toHaveLength(1);
    const startListening = main.slice(main.indexOf('async function startListening('));
    expect(startListening.indexOf('getUserMedia(')).toBeGreaterThan(0);
    expect(startListening.indexOf('getUserMedia(')).toBeLessThan(startListening.indexOf('\n}\n'));
    // startListening is called from the button's own handlers and nowhere else.
    expect(main.match(/startListening\(\)/g)).toHaveLength(3);
    expect(main.match(/void startListening\(\)/g)).toHaveLength(2);
  });

  it('lets go of the microphone when the utterance ends, before it is sent', () => {
    const stop = main.slice(main.indexOf('session.stop = async'));
    expect(stop.indexOf('release();')).toBeGreaterThan(0);
    expect(stop.indexOf('release();')).toBeLessThan(stop.indexOf('hearAndAsk('));
    expect(main).toMatch(/const release = \(\) => stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\);/);
    expect(main).toMatch(/setTimeout\(\(\) => void session\.stop\(\), HEAR_MAX_MS\)/);
  });

  it('captures with an AudioWorklet, and a ScriptProcessor where there is none', () => {
    expect(main).toMatch(/context\.audioWorklet\.addModule\(CAPTURE_WORKLET_URL\)/);
    expect(main).toMatch(/new AudioWorkletNode\(context, CAPTURE_WORKLET_NAME/);
    expect(main).toMatch(/context\.createScriptProcessor\(4096, 1, 1\)/);
    // A file of the page's own, which the page's CSP allows; never a blob: address, which it does not.
    expect(CAPTURE_WORKLET_URL).toBe('./capture-worklet.js');
    const worklet = readFileSync(new URL('../capture-worklet.js', import.meta.url), 'utf8');
    expect(worklet).toContain(`registerProcessor('${CAPTURE_WORKLET_NAME}'`);
    expect(main).not.toMatch(/createObjectURL\(new Blob\(\[CAPTURE/);
    // Not the browser's own recogniser, which would send the sound somewhere else.
    expect(main).not.toMatch(/SpeechRecognition/);
  });

  it('sends the PCM to /api/hear, and asks what was heard through the form a typed question goes through', () => {
    expect(main).toMatch(/authorizedFetch\('\/api\/hear', \{ method: 'POST', headers: \{ 'content-type': HEAR_CONTENT_TYPE \}, body: pcm \}\)/);
    expect(main).toMatch(/\$\('ask-input'\)\.value = answer\.ask;\s*\$\('ask'\)\.requestSubmit\(\);/);
  });

  it('is a toggle on Space and Enter (a button’s click), and push-to-talk when held', () => {
    expect(HOLD_MS).toBeGreaterThanOrEqual(400);
    expect(main).toMatch(/\$\('ask-voice'\)\.addEventListener\('click'/);
    expect(main).toMatch(/\$\('ask-voice'\)\.addEventListener\('pointerdown'/);
    expect(main).toMatch(/if \(held >= HOLD_MS\) stopListening\(\);/);
  });

  it('is published beside the page (infra/sim-alexa.tf), as every module main.js imports is', () => {
    const tf = read('../../../infra/sim-alexa.tf');
    const imported = [...main.matchAll(/from '\.\/([\w-]+\.js)'/g)].map((m) => m[1]);
    expect(imported).toContain('voice.js');
    for (const file of imported) expect(tf, file).toContain(`key           = "${file}"`);
  });
});
