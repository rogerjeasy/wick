/**
 * Reading the two measurements a calm point is chosen from (choose.ts), as
 * the tools that made them print them. Pure, so each is tested against a
 * piece of real output.
 */
import type { Span } from './choose.js';

/**
 * ffmpeg's `silencedetect`, from its stderr. A silence still open when the
 * output ends is left out: where it ended is not known.
 */
export function parseSilences(stderr: string): Span[] {
  const silences: Span[] = [];
  let openedAt: number | undefined;
  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      openedAt = Number(start[1]);
      continue;
    }
    const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (end && openedAt !== undefined) {
      silences.push({ startMs: Math.round(Math.max(0, openedAt) * 1000), endMs: Math.round(Number(end[1]) * 1000) });
      openedAt = undefined;
    }
  }
  return silences;
}

export interface Sound {
  /** The film's integrated loudness (EBU R 128), in LUFS. */
  readonly loudnessLufs: number;
  /** The level below which a stretch was called quiet: so far below the film's own loudness (measure.sh). */
  readonly quietBelowDb: number;
}

/**
 * The first line of a silences file: how loud this film is, and so what
 * "quiet" was taken to mean for it. A film with a score throughout is never
 * silent, but it has its own quiet; one level for every film would find
 * nothing in a loud one and everything in a soft one.
 */
export function parseSound(text: string): Sound {
  const header = /^# loudness (-?[\d.]+) LUFS; quiet below (-?[\d.]+) dB$/m.exec(text);
  if (!header) throw new Error('the silences file does not say the loudness it was measured against');
  return { loudnessLufs: Number(header[1]), quietBelowDb: Number(header[2]) };
}

interface RekognitionSegment {
  readonly Type?: string;
  readonly StartTimestampMillis?: number;
  readonly EndTimestampMillis?: number;
  readonly TechnicalCueSegment?: { readonly Type?: string };
}

interface RekognitionResult {
  readonly JobStatus?: string;
  readonly NextToken?: string;
  readonly VideoMetadata?: readonly { readonly DurationMillis?: number }[];
  readonly Segments?: readonly RekognitionSegment[];
}

export interface Segments {
  readonly durationMs: number;
  readonly shots: Span[];
  readonly blackFrames: Span[];
  readonly endCreditsMs?: number;
}

/**
 * Amazon Rekognition's GetSegmentDetection result (SHOT and TECHNICAL_CUE),
 * whole. A job still running, or a result with more pages to come, is
 * refused: half a film is not a measurement.
 */
export function parseSegments(result: RekognitionResult): Segments {
  if (result.JobStatus !== 'SUCCEEDED') throw new Error(`segment detection is not finished: ${result.JobStatus ?? 'no status'}`);
  if (result.NextToken) throw new Error('segment detection has more pages: read them all first');

  const span = (s: RekognitionSegment): Span => ({ startMs: s.StartTimestampMillis ?? 0, endMs: s.EndTimestampMillis ?? 0 });
  const inOrder = (a: Span, b: Span): number => a.startMs - b.startMs;
  const segments = result.Segments ?? [];
  const cues = (type: string) => segments.filter((s) => s.Type === 'TECHNICAL_CUE' && s.TechnicalCueSegment?.Type === type).map(span).sort(inOrder);
  const [endCredits] = cues('EndCredits');

  return {
    durationMs: result.VideoMetadata?.[0]?.DurationMillis ?? 0,
    shots: segments.filter((s) => s.Type === 'SHOT').map(span).sort(inOrder),
    blackFrames: cues('BlackFrames'),
    ...(endCredits ? { endCreditsMs: endCredits.startMs } : {}),
  };
}
