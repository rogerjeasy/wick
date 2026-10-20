/**
 * The icons' pictures, stood in for in a render test — for tests only.
 * `require` of a PNG only resolves in the Vega bundler, so a test that
 * draws an icon hands it this instead:
 *
 *   vi.mock('../../icons/iconSources.generated.js', () => import('../../__tests__/render/icons.js'));
 *
 * Each picture is then an address that names it, so a test can tell which
 * icon was drawn.
 */
import { ICON_NAMES, ICON_SIZES_DP } from '../../icons/icons.js';

export const ICON_SOURCES: Readonly<Record<string, { readonly uri: string }>> = Object.fromEntries(
  ICON_NAMES.flatMap((name) => ['ink', 'ground'].flatMap((tone) => ICON_SIZES_DP.map((dp) => [`${name}-${tone}-${dp}`, { uri: `icon:${name}-${tone}-${dp}` }]))),
);
