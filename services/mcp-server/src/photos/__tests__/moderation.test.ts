import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetectModerationLabelsCommand } from '@aws-sdk/client-rekognition';
import {
  MODERATION_REFUSE_AT,
  MODERATION_TIMEOUT_MS,
  REFUSED_CATEGORIES,
  createRekognitionModeration,
  verdictOf,
  type ModerationLabel,
  type RekognitionSend,
} from '../moderation.js';

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

const label = (Name: string, Confidence: number, TaxonomyLevel = 1, ParentName = ''): ModerationLabel => ({ Name, Confidence, TaxonomyLevel, ParentName });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('verdictOf — which pictures Wick will not send', () => {
  it('passes a picture Rekognition has nothing to say about', () => {
    expect(verdictOf([])).toBe('pass');
    expect(verdictOf(undefined)).toBe('pass');
  });

  it('refuses each of the four top-level categories at eighty or above, and at no less', () => {
    expect(REFUSED_CATEGORIES).toEqual(['Explicit', 'Violence', 'Visually Disturbing', 'Hate Symbols']);
    expect(MODERATION_REFUSE_AT).toBe(80);
    for (const category of REFUSED_CATEGORIES) {
      expect(verdictOf([label(category, 80)]), category).toBe('refuse');
      expect(verdictOf([label(category, 99.9)]), category).toBe('refuse');
      expect(verdictOf([label(category, 79.99)]), category).toBe('pass');
    }
  });

  it('refuses a label under one of them by its own confidence, whatever the category above it scored', () => {
    // Rekognition returns the hierarchy: the L1 beside its L2 and L3.
    expect(verdictOf([label('Violence', 62), label('Graphic Violence', 61, 2, 'Violence'), label('Blood & Gore', 91, 3, 'Graphic Violence')])).toBe('refuse');
    expect(verdictOf([label('Explicit', 55), label('Explicit Nudity', 88, 2, 'Explicit')])).toBe('refuse');
    expect(verdictOf([label('Hate Symbols', 70), label('Nazi Party', 85, 2, 'Hate Symbols')])).toBe('refuse');
    expect(verdictOf([label('Visually Disturbing', 51), label('Crashes', 52, 2, 'Visually Disturbing'), label('Air Crash', 80, 3, 'Crashes')])).toBe('refuse');
  });

  it('knows the labels under them by name, so one returned without its parents is still refused', () => {
    for (const name of [
      'Explicit Nudity', 'Explicit Sexual Activity', 'Sex Toys', 'Exposed Male Genitalia', 'Exposed Female Genitalia', 'Exposed Buttocks or Anus', 'Exposed Female Nipple',
      'Weapons', 'Graphic Violence', 'Weapon Violence', 'Physical Violence', 'Self-Harm', 'Blood & Gore', 'Explosions and Blasts',
      'Death and Emaciation', 'Emaciated Bodies', 'Corpses', 'Crashes', 'Air Crash',
      'Nazi Party', 'White Supremacy', 'Extremist',
    ]) {
      expect(verdictOf([{ Name: name, Confidence: 80 }]), name).toBe('refuse');
    }
  });

  it('lets the other categories through at any confidence: a glass of wine at Christmas is a picture for a mantelpiece', () => {
    expect(
      verdictOf([
        label('Alcohol', 99),
        label('Alcoholic Beverages', 99, 2, 'Alcohol'),
        label('Swimwear or Underwear', 97),
        label('Female Swimwear or Underwear', 97, 2, 'Swimwear or Underwear'),
        label('Non-Explicit Nudity of Intimate parts and Kissing', 95),
        label('Kissing on the Lips', 95, 2, 'Non-Explicit Nudity of Intimate parts and Kissing'),
        label('Drugs & Tobacco', 90),
        label('Rude Gestures', 90),
        label('Gambling', 90),
      ]),
    ).toBe('pass');
  });

  it('fails closed on a label it cannot place: under something, sure of itself, and nothing says under what', () => {
    expect(verdictOf([label('Something New', 90, 2, 'A Category Nobody Returned')])).toBe('refuse');
    expect(verdictOf([label('Something New', 60, 2, 'A Category Nobody Returned')])).toBe('pass');
    // Placed under a category Wick lets through, it is let through.
    expect(verdictOf([label('Alcohol', 40), label('Something New', 90, 2, 'Alcohol')])).toBe('pass');
  });
});

describe('createRekognitionModeration — the one look anything takes at the picture', () => {
  it('asks Rekognition about the bytes themselves — nothing is stored to be looked at', async () => {
    const sent: DetectModerationLabelsCommand[] = [];
    const send = (async (command: DetectModerationLabelsCommand) => {
      sent.push(command);
      return { ModerationLabels: [] };
    }) as RekognitionSend;

    expect(await createRekognitionModeration(send)(BYTES)).toBe('pass');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(DetectModerationLabelsCommand);
    expect(sent[0]!.input).toEqual({ Image: { Bytes: BYTES }, MinConfidence: 50 });
  });

  it('refuses what the labels refuse', async () => {
    const send = (async () => ({ ModerationLabels: [label('Explicit', 93)] })) as RekognitionSend;

    expect(await createRekognitionModeration(send)(BYTES)).toBe('refuse');
  });

  it('FAILS CLOSED when Rekognition errors: the picture was not checked, and is not sent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = (async () => {
      throw Object.assign(new Error('User: arn:aws:sts::123456789012:assumed-role/x is not authorized'), { name: 'AccessDeniedException' });
    }) as RekognitionSend;

    expect(await createRekognitionModeration(send)(BYTES)).toBe('unchecked');
  });

  it('FAILS CLOSED when Rekognition does not answer in two seconds, and gives the request up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    let aborted = false;
    const send = ((_command: DetectModerationLabelsCommand, options?: { abortSignal?: AbortSignal }) =>
      new Promise(() => {
        options?.abortSignal?.addEventListener('abort', () => void (aborted = true));
      })) as RekognitionSend;

    const verdict = createRekognitionModeration(send)(BYTES);
    await vi.advanceTimersByTimeAsync(MODERATION_TIMEOUT_MS - 1);
    let settled = false;
    void verdict.then(() => void (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(MODERATION_TIMEOUT_MS).toBe(2000);
    expect(await verdict).toBe('unchecked');
    expect(aborted).toBe(true);
  });

  it('never logs a label, the bytes or whose picture it was — a count, and nothing else', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    const refusing = (async () => ({ ModerationLabels: [label('Explicit', 93), label('Explicit Nudity', 93, 2, 'Explicit')] })) as RekognitionSend;
    const failing = (async () => {
      throw Object.assign(new Error('arn:aws:iam::123456789012:role/secret'), { name: 'ThrottlingException' });
    }) as RekognitionSend;

    await createRekognitionModeration(refusing)(BYTES);
    await createRekognitionModeration(failing)(BYTES);

    const all = logged.join('\n');
    expect(all).not.toMatch(/Explicit|Nudity|arn:aws|123456789012/);
    expect(all).toContain('"labels":2');
    expect(all).toContain('ThrottlingException');
  });
});
