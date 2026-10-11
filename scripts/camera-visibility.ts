/** Which recorded cameras a Ring token can and cannot see. Pure — no AWS, no Ring. Tested. */
export function cameraVisibility(
  recorded: readonly { readonly deviceId: string; readonly householdId: string }[],
  visibleIds: readonly string[],
): { readonly seen: typeof recorded; readonly unseen: typeof recorded } {
  const visible = new Set(visibleIds);
  return {
    seen: recorded.filter((r) => visible.has(r.deviceId)),
    unseen: recorded.filter((r) => !visible.has(r.deviceId)),
  };
}
