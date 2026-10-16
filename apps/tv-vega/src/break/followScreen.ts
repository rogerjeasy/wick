/**
 * Wick coming on screen, or going behind another app — told to the
 * Natural-Break Engine and to the edge, at the same moment, every time.
 *
 * The engine's first rule is that nothing but the door is shown on a screen
 * she is not looking at (§3.4: TV_SETTLED → IDLE when Wick leaves the
 * screen). Vega stops an app's JavaScript only some seconds after it leaves
 * the screen (FL-022), and on Fire OS it may keep running for the door's
 * Headless JS task, so "the app is running" does not mean "she can see it".
 * Without this, a note could become due in those seconds and be counted as
 * one of its two showings on a screen nobody was looking at.
 *
 * Back on screen, the engine counts its twenty settled seconds again before
 * a note may come up (SETTLED_AFTER_MS), and the edge hears `fg`: that is
 * when the agent plane may look for a question to put to her
 * (services/edge-device/lambda/television-active.mjs). `bg` is said too, as
 * the browser television says it (apps/ops-console/tv.js); the edge records
 * nothing for it, by design.
 *
 * ResidentApp.tsx calls it from one effect on `useOnScreen()`.
 */
import type { DeviceEvent } from '@wick/contracts';
import type { BreakController } from './BreakController.js';

export function followScreen(
  engine: Pick<BreakController, 'setForeground'>,
  send: (event: DeviceEvent) => void,
  onScreen: boolean,
  at: number,
): void {
  engine.setForeground(onScreen, at);
  send({ t: 'app_lifecycle', state: onScreen ? 'fg' : 'bg', at });
}
