/**
 * Replaces apps/tv-vega/src/headless/launchCardService.ts on Fire OS.
 *
 * On Vega this starts the background card service by opening the app's own
 * `pkg://` address. Android has no such address, and Fire OS's background
 * door alert is a separate piece of work
 * (docs/superpowers/specs/2026-10-11-tv-fireos-design.md §6), so there is
 * nothing to start: Wick shows its cards while it is on screen.
 *
 * Same exports as the file it replaces; src/__tests__/parity.test.ts holds
 * that to be so.
 */
export const CARD_SERVICE_URI = '';

/** Never throws, like the original. */
export async function launchCardService(_openURL: (uri: string) => Promise<unknown>): Promise<void> {}
