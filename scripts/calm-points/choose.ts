/**
 * Calm points — the moments inside a programme where a note may arrive
 * without spoiling a scene.
 *
 * The Natural-Break Engine (apps/tv-vega/src/break) holds a family note
 * until the credits. For a fifteen-minute film that can be a twelve-minute
 * wait. A calm point is an earlier place where interrupting costs almost
 * nothing: the picture is changing and nobody is speaking.
 *
 * Nothing is guessed here. Two things are measured on the very encode the
 * television plays (measure.sh):
 *
 *   - where the picture changes — every shot, every fade through black and
 *     the start of the end credits, from Amazon Rekognition's video segment
 *     detection;
 *   - where the sound drops away — from ffmpeg, judged against the film's
 *     own loudness, not one level for every film.
 *
 * This file only chooses among them, by rules a person can check:
 *
 *   - a cut that falls inside a quiet stretch, or that the quiet follows at
 *     once, or the end of a fade through black;
 *   - never in the first minute, when nobody has settled into the programme;
 *   - never in the last stretch before the credits, which are a break already;
 *   - never two close together: the quieter one, or the fade, is kept.
 *
 * Pure, and deterministic: the same measurements give the same calm points.
 * No model chooses a calm point. One describes each afterwards, for people
 * to read (describe.ts); the television never sees that sentence.
 */

export interface Span {
  readonly startMs: number;
  readonly endMs: number;
}

/** What was measured for one programme, on the encode that is published. */
export interface Measured {
  readonly programmeId: string;
  readonly durationMs: number;
  /** Rekognition SHOT segments, in order. */
  readonly shots: readonly Span[];
  /** Rekognition TECHNICAL_CUE BlackFrames segments. */
  readonly blackFrames: readonly Span[];
  /** Where Rekognition says the end credits begin, when it found them. */
  readonly endCreditsMs?: number;
  /** The stretches ffmpeg found quiet — below `sound.quietBelowDb`. */
  readonly silences: readonly Span[];
  /** How loud the film is, and what "quiet" was taken to mean for it (parse.ts Sound). */
  readonly sound?: { readonly loudnessLufs: number; readonly quietBelowDb: number };
}

export interface CalmPoint {
  /** Position in the programme, in milliseconds. */
  readonly atMs: number;
  /** How long the silence around the cut lasts. Zero for a fade through black. */
  readonly quietMs: number;
  readonly kind: 'cut_in_silence' | 'after_black';
}

/** Nobody has settled into a programme in its first minute. */
export const FIRST_CALM_AFTER_MS = 60_000;
/** The credits are a break already; a calm point just before them would only come twice. */
export const NO_CALM_BEFORE_CREDITS_MS = 60_000;
/** A note should not be able to arrive at every other cut. */
export const MIN_CALM_SPACING_MS = 90_000;
/** A pause, not a breath between two lines. */
export const MIN_QUIET_MS = 1_000;

/** The quiet may begin this soon after the cut and still belong to it: the scene changes, and then nobody speaks. */
export const QUIET_MAY_FOLLOW_CUT_BY_MS = 500;

/** A fade through black ends a scene whatever the sound is doing: it outranks any silence. */
const BLACK_OUTRANKS_MS = 60_000;

const strength = (point: CalmPoint): number => (point.kind === 'after_black' ? BLACK_OUTRANKS_MS : 0) + point.quietMs;

export function chooseCalmPoints(measured: Measured): CalmPoint[] {
  const from = FIRST_CALM_AFTER_MS;
  const until = (measured.endCreditsMs ?? measured.durationMs) - NO_CALM_BEFORE_CREDITS_MS;

  const candidates: CalmPoint[] = [];

  // The first frame after a fade through black.
  for (const black of measured.blackFrames) candidates.push({ atMs: black.endMs, quietMs: 0, kind: 'after_black' });

  // A cut — where one shot gives way to the next — with silence on both sides of it.
  for (const shot of measured.shots.slice(1)) {
    const cut = shot.startMs;
    const silence = measured.silences.find((s) => s.startMs - QUIET_MAY_FOLLOW_CUT_BY_MS <= cut && cut <= s.endMs);
    if (!silence) continue;
    const quietMs = silence.endMs - silence.startMs;
    if (quietMs >= MIN_QUIET_MS) candidates.push({ atMs: cut, quietMs, kind: 'cut_in_silence' });
  }

  // Strongest first; of two as strong, the earlier. Each is kept unless one already kept is too close.
  const kept: CalmPoint[] = [];
  const ranked = candidates
    .filter((c) => c.atMs >= from && c.atMs <= until)
    .sort((a, b) => strength(b) - strength(a) || a.atMs - b.atMs);
  for (const candidate of ranked) {
    if (kept.every((k) => Math.abs(k.atMs - candidate.atMs) >= MIN_CALM_SPACING_MS)) kept.push(candidate);
  }
  return kept.sort((a, b) => a.atMs - b.atMs);
}
