/**
 * What Wick plays.
 *
 * Wick owns its player because the Natural-Break Engine needs the position
 * and the credits marker (§3.4, §3.6) — and a Vega app cannot see or draw
 * over another app's playback at all (SP-1, `WICK.md` R1). So the product
 * needs programmes of its own.
 *
 * These are the Blender Foundation's open films: Creative Commons
 * Attribution 3.0, so they can be played, and shown in the demo, with the
 * attribution below. No studio content, no trademark, nothing to clear.
 *
 * `durationMs` and `creditsPositionMs` are measured from the stream itself
 * (ffmpeg, 2026-10-02), not taken from the film's published running time —
 * each host's encode has its own lead-in. `creditsPositionMs` is the same
 * field Content Personalization reports to the platform (§3.3): the moment
 * the story is over and Wick may speak.
 *
 * Three, never four (Principle 6) — the test holds the list to it.
 */
export interface Programme {
  readonly id: string;
  readonly title: string;
  /** One plain line under the title on the home screen. */
  readonly line: string;
  readonly streamUrl: string;
  readonly durationMs: number;
  readonly creditsPositionMs: number;
  readonly attribution: string;
  readonly licence: 'CC BY 3.0';
}

export const CATALOG: readonly Programme[] = [
  {
    id: 'big-buck-bunny',
    title: 'Big Buck Bunny',
    line: 'A gentle giant has had enough. 10 minutes.',
    streamUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    durationMs: 634_580,
    creditsPositionMs: 496_000,
    attribution: '© Blender Foundation | peach.blender.org',
    licence: 'CC BY 3.0',
  },
  {
    id: 'tears-of-steel',
    title: 'Tears of Steel',
    line: 'Amsterdam, some years from now. 12 minutes.',
    streamUrl: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
    durationMs: 734_000,
    creditsPositionMs: 584_000,
    attribution: '© Blender Foundation | mango.blender.org',
    licence: 'CC BY 3.0',
  },
];

export function programmeById(id: string): Programme | undefined {
  return CATALOG.find((p) => p.id === id);
}
