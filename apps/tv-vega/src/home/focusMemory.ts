/**
 * Where she was on the home screen: the item the focus goes back to when a
 * card, her mantelpiece or the idle screen has gone — the film she was on,
 * the light's pill if she opened the card about her light from it, the
 * waiting row, the mantelpiece's pill.
 *
 * The rule: the memory records only a focus she made.
 *
 * An item saying "I have the focus" is not always her doing. When something
 * takes the remote, the home's items stop being focusable one after another
 * in the order they are drawn, and the platform hands the focus along the
 * ones that still are before it reaches what took the remote; when the home
 * gets the remote back, the platform may set the focus down on the first
 * thing it finds before it puts it where it was told. Every one of those is
 * reported exactly as her own D-pad press would be. Believed, they left the
 * focus on the third film after a card she had answered from the first
 * (seen on the Vega simulator, 2026-10-14).
 *
 * So a report counts only when the home is within the remote's reach and
 * has been for a moment — longer than the platform takes to settle the
 * focus, shorter than anyone takes to see the screen and press. Anything
 * else is not hers and is not remembered. The cost is small and on the
 * safe side: a move she makes in that first half second is not written
 * down, and the focus would return to where she was before it.
 *
 * Pure: the items are names, `now` is passed in, and HomeScreen.tsx says
 * what happened.
 */

/** How long after the home comes into reach a reported focus is still the platform's, not hers. */
export const FOCUS_SETTLE_MS = 500;

export interface HomeFocus {
  /** The item she last chose, by name. Undefined until she has chosen one. */
  readonly item: string | undefined;
  /** When the home came within the remote's reach; null while it is out of it. */
  readonly reachableSince: number | null;
}

export const HOME_FOCUS_START: HomeFocus = { item: undefined, reachableSince: null };

/** Whether a focus reported now is one she made. */
export function isHerFocus(at: { readonly reachable: boolean; readonly sinceReachableMs: number }): boolean {
  return at.reachable && at.sinceReachableMs >= FOCUS_SETTLE_MS;
}

/**
 * The home is within the remote's reach, or is not — said every time the
 * screen is drawn. Only the change counts: the moment runs from when it
 * came into reach, not from each drawing.
 */
export function reachChanged(focus: HomeFocus, reachable: boolean, now: number): HomeFocus {
  if (!reachable) return focus.reachableSince === null ? focus : { ...focus, reachableSince: null };
  return focus.reachableSince === null ? { ...focus, reachableSince: now } : focus;
}

/** An item says it has the focus. Remembered only if it is hers. */
export function focusReported(focus: HomeFocus, item: string, now: number): HomeFocus {
  const reachable = focus.reachableSince !== null;
  const sinceReachableMs = focus.reachableSince === null ? 0 : now - focus.reachableSince;
  return isHerFocus({ reachable, sinceReachableMs }) && focus.item !== item ? { ...focus, item } : focus;
}

/**
 * Where the focus is put when the home has the remote: the item she last
 * chose, while it is still on the screen; otherwise where the focus starts
 * — the film she last watched, or the first.
 */
export function focusOnReturn(focus: HomeFocus, here: readonly string[], start: string): string {
  return focus.item !== undefined && here.includes(focus.item) ? focus.item : start;
}
