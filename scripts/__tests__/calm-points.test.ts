import { describe, expect, it } from 'vitest';
import {
  FIRST_CALM_AFTER_MS,
  MIN_CALM_SPACING_MS,
  MIN_QUIET_MS,
  NO_CALM_BEFORE_CREDITS_MS,
  chooseCalmPoints,
  type Measured,
} from '../calm-points/choose.js';
import { parseSegments, parseSilences, parseSound } from '../calm-points/parse.js';

const MIN = 60_000;

/** A film of `minutes` with a cut every ten seconds and no sound to speak of, unless given. */
function film(over: Partial<Measured> & { minutes?: number } = {}): Measured {
  const durationMs = (over.minutes ?? 10) * MIN;
  const shots = [];
  for (let start = 0; start < durationMs; start += 10_000) shots.push({ startMs: start, endMs: start + 9_960 });
  return { programmeId: 'film', durationMs, shots, blackFrames: [], silences: [], endCreditsMs: durationMs - MIN, ...over };
}

const silenceAround = (cutMs: number, quietMs = 2_000) => ({ startMs: cutMs - quietMs / 2, endMs: cutMs + quietMs / 2 });

describe('chooseCalmPoints — where a note may arrive without spoiling a scene', () => {
  it('is a cut that falls inside a silence: the picture changes while nobody is speaking', () => {
    const points = chooseCalmPoints(film({ silences: [silenceAround(120_000)] }));

    expect(points).toEqual([{ atMs: 120_000, quietMs: 2_000, kind: 'cut_in_silence' }]);
  });

  it('is never a cut with sound over it, nor a silence with no cut in it', () => {
    // Silence from 2:03 to 2:07 — in the middle of a shot. And every cut has sound.
    expect(chooseCalmPoints(film({ silences: [{ startMs: 123_000, endMs: 127_000 }] }))).toEqual([]);
    expect(chooseCalmPoints(film())).toEqual([]);
  });

  it('counts a cut that the quiet follows at once: the scene changes, and then nobody speaks', () => {
    // The quiet begins three tenths of a second after the cut at two minutes.
    const follows = chooseCalmPoints(film({ silences: [{ startMs: 120_300, endMs: 122_300 }] }));
    // A second and a half after it is not "at once": that is a silence inside the next shot.
    const later = chooseCalmPoints(film({ silences: [{ startMs: 121_500, endMs: 123_500 }] }));

    expect(follows).toEqual([{ atMs: 120_000, quietMs: 2_000, kind: 'cut_in_silence' }]);
    expect(later).toEqual([]);
  });

  it('needs the silence to be long enough to be a pause, not a breath', () => {
    const breath = chooseCalmPoints(film({ silences: [silenceAround(120_000, MIN_QUIET_MS - 100)] }));
    const pause = chooseCalmPoints(film({ silences: [silenceAround(120_000, MIN_QUIET_MS)] }));

    expect(breath).toEqual([]);
    expect(pause).toHaveLength(1);
  });

  it('counts a fade through black as the end of a scene, whatever the sound is doing', () => {
    const points = chooseCalmPoints(film({ blackFrames: [{ startMs: 179_500, endMs: 180_400 }] }));

    // Where the black ends: the first frame of the scene that follows.
    expect(points).toEqual([{ atMs: 180_400, quietMs: 0, kind: 'after_black' }]);
  });

  it('leaves the first minute alone: nobody has settled into a programme yet', () => {
    const early = FIRST_CALM_AFTER_MS - 10_000;

    expect(chooseCalmPoints(film({ silences: [silenceAround(early)] }))).toEqual([]);
  });

  it('leaves the last stretch to the credits, which are a break already', () => {
    const m = film();
    const late = m.endCreditsMs! - NO_CALM_BEFORE_CREDITS_MS + 10_000;

    expect(chooseCalmPoints({ ...m, silences: [silenceAround(late)] })).toEqual([]);
  });

  it('keeps calm points apart, choosing the quieter of two that are close', () => {
    const points = chooseCalmPoints(film({ silences: [silenceAround(120_000, 1_500), silenceAround(150_000, 4_000), silenceAround(300_000, 2_000)] }));

    expect(points.map((p) => p.atMs)).toEqual([150_000, 300_000]);
    for (let i = 1; i < points.length; i += 1) expect(points[i]!.atMs - points[i - 1]!.atMs).toBeGreaterThanOrEqual(MIN_CALM_SPACING_MS);
  });

  it('prefers a fade through black to a merely quiet cut nearby', () => {
    const points = chooseCalmPoints(film({ silences: [silenceAround(150_000, 5_000)], blackFrames: [{ startMs: 169_700, endMs: 170_300 }] }));

    expect(points).toEqual([{ atMs: 170_300, quietMs: 0, kind: 'after_black' }]);
  });

  it('is in order, and the same for the same film', () => {
    const m = film({ minutes: 20, silences: [silenceAround(600_000), silenceAround(120_000), silenceAround(360_000)] });

    expect(chooseCalmPoints(m).map((p) => p.atMs)).toEqual([120_000, 360_000, 600_000]);
    expect(chooseCalmPoints(m)).toEqual(chooseCalmPoints(m));
  });

  it('falls back to the last minute of the film when no credits were found', () => {
    const { endCreditsMs: _none, ...withoutCredits } = film();
    const late = withoutCredits.durationMs - 20_000;

    expect(chooseCalmPoints({ ...withoutCredits, silences: [silenceAround(late)] })).toEqual([]);
  });
});

describe('parseSilences — what ffmpeg heard', () => {
  it('reads each silence as a start and an end, in milliseconds', () => {
    const stderr = [
      '[Parsed_silencedetect_0 @ 0x7a00c08f00] silence_start: 84.373354',
      'frame= 2032 fps=0.0 q=-0.0 size=N/A',
      '[Parsed_silencedetect_0 @ 0x7a00c08f00] silence_end: 86.994687 | silence_duration: 2.621333',
      '[Parsed_silencedetect_0 @ 0x7a00c08f00] silence_start: 87.018625',
      '[Parsed_silencedetect_0 @ 0x7a00c08f00] silence_end: 92.836812 | silence_duration: 5.818187',
    ].join('\n');

    expect(parseSilences(stderr)).toEqual([
      { startMs: 84_373, endMs: 86_995 },
      { startMs: 87_019, endMs: 92_837 },
    ]);
  });

  it('drops a silence that never ended in the output, rather than guess where it did', () => {
    expect(parseSilences('[silencedetect @ 0x1] silence_start: 590.2')).toEqual([]);
  });
});

describe('parseSound — how quiet is quiet, for this film', () => {
  it('reads the film’s own loudness and the level below which it was called quiet', () => {
    const text = ['# loudness -12.2 LUFS; quiet below -24.2 dB', '[silencedetect @ 0x1] silence_start: 84.3', '[silencedetect @ 0x1] silence_end: 86.9 | silence_duration: 2.6'].join('\n');

    expect(parseSound(text)).toEqual({ loudnessLufs: -12.2, quietBelowDb: -24.2 });
  });

  it('refuses a measurement that does not say how it was made', () => {
    expect(() => parseSound('[silencedetect @ 0x1] silence_start: 84.3')).toThrow(/loudness/);
  });
});

describe('parseSegments — what Rekognition saw', () => {
  const result = {
    JobStatus: 'SUCCEEDED',
    VideoMetadata: [{ DurationMillis: 596_458, FrameRate: 24 }],
    Segments: [
      { Type: 'TECHNICAL_CUE', StartTimestampMillis: 460_938, EndTimestampMillis: 461_813, TechnicalCueSegment: { Type: 'BlackFrames', Confidence: 100 } },
      { Type: 'TECHNICAL_CUE', StartTimestampMillis: 21, EndTimestampMillis: 460_896, TechnicalCueSegment: { Type: 'Content', Confidence: 100 } },
      { Type: 'TECHNICAL_CUE', StartTimestampMillis: 490_479, EndTimestampMillis: 579_938, TechnicalCueSegment: { Type: 'EndCredits', Confidence: 100 } },
      { Type: 'SHOT', StartTimestampMillis: 1_563, EndTimestampMillis: 11_854, ShotSegment: { Index: 1, Confidence: 99 } },
      { Type: 'SHOT', StartTimestampMillis: 21, EndTimestampMillis: 1_396, ShotSegment: { Index: 0, Confidence: 99 } },
    ],
  };

  it('keeps the shots in order, the black frames, and where the credits begin', () => {
    expect(parseSegments(result)).toEqual({
      durationMs: 596_458,
      shots: [{ startMs: 21, endMs: 1_396 }, { startMs: 1_563, endMs: 11_854 }],
      blackFrames: [{ startMs: 460_938, endMs: 461_813 }],
      endCreditsMs: 490_479,
    });
  });

  it('refuses a job that did not finish: half a film is not a measurement', () => {
    expect(() => parseSegments({ ...result, JobStatus: 'IN_PROGRESS' })).toThrow(/not finished/);
    expect(() => parseSegments({ ...result, NextToken: 'more' })).toThrow(/more pages/);
  });
});

describe('the committed calm points', () => {
  it('are exactly what the committed measurements give: the television’s file is generated, never edited', async () => {
    const { readFileSync } = await import('node:fs');
    const { CALM_POINTS_FILE, readMeasured, renderCalmPointsModule } = await import('../calm-points/build.js');

    expect(readFileSync(CALM_POINTS_FILE, 'utf8')).toBe(renderCalmPointsModule(readMeasured()));
  });

  it('come from a measurement of every film that says how quiet was judged', async () => {
    const { readMeasured } = await import('../calm-points/build.js');
    const measured = readMeasured();

    expect(measured.map((m) => m.programmeId)).toEqual(['big-buck-bunny', 'sintel', 'tears-of-steel']);
    for (const m of measured) {
      expect(m.shots.length, m.programmeId).toBeGreaterThan(100);
      expect(m.endCreditsMs, m.programmeId).toBeGreaterThan(0);
      // Quiet is fourteen decibels below the film's own loudness, whatever that is.
      expect(m.sound!.quietBelowDb, m.programmeId).toBeCloseTo(m.sound!.loudnessLufs - 14, 1);
    }
  });
});
