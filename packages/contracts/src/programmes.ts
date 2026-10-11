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
 * They are served from Wick's own origin (infra/programmes.tf), from one
 * 720p HLS encode made by scripts/publish-programmes.sh. `durationMs` and
 * `creditsPositionMs` are measured from that encode (frame by frame,
 * 2026-10-02), not taken from a published running time. `creditsPositionMs`
 * is the same field Content Personalization reports to the platform (§3.3):
 * the moment the story is over and Wick may speak.
 *
 * The list lives here, not in the television app, because two screens play
 * from it: the television (apps/tv-vega/src/catalog) and, when the resident
 * has said yes to watching together, the family member's player beside it
 * (watch.ts).
 *
 * Three, never four (Principle 6) — the television's test holds the list to it.
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

/** `terraform output -raw programmes_origin` in infra/. */
export const PROGRAMMES_ORIGIN = 'https://d112ix5w6an39e.cloudfront.net';

const programme = (p: Omit<Programme, 'streamUrl' | 'licence'>): Programme => ({
  ...p,
  streamUrl: `${PROGRAMMES_ORIGIN}/${p.id}/index.m3u8`,
  licence: 'CC BY 3.0',
});

export const PROGRAMMES: readonly Programme[] = [
  programme({
    id: 'big-buck-bunny',
    title: 'Big Buck Bunny',
    line: '10 minutes',
    durationMs: 596_458,
    creditsPositionMs: 490_000,
    attribution: '© Blender Foundation | peach.blender.org',
  }),
  programme({
    id: 'sintel',
    title: 'Sintel',
    line: '15 minutes',
    durationMs: 888_000,
    creditsPositionMs: 744_000,
    attribution: '© Blender Foundation | durian.blender.org',
  }),
  programme({
    id: 'tears-of-steel',
    title: 'Tears of Steel',
    line: '12 minutes',
    durationMs: 734_167,
    creditsPositionMs: 588_000,
    attribution: '© Blender Foundation | mango.blender.org',
  }),
];

export function programmeById(id: string): Programme | undefined {
  return PROGRAMMES.find((p) => p.id === id);
}
