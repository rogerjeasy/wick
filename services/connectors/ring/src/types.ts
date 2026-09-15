/**
 * Shapes the Ring Partner API actually returns, as verified against the live
 * API on 2026-09-15 — not as inferred from the endpoint table.
 *
 * The API speaks JSON:API: every response is `{ data, included?, meta? }`, ids
 * are opaque `ava1.ring.…` strings, and everything interesting hangs off
 * `attributes` or is sideloaded into `included` by (type, id). See FL-005.
 */

export interface RingCapabilities {
  /** Motion detection with configurable zones, when present. */
  readonly motion: boolean;
  /** Snapshot / image enhancement support. */
  readonly image: boolean;
  /**
   * Chime Controls — what M1 "Just a moment" needs.
   *
   * On the Playground device this is `audio.supported_actions: null`, which is
   * why the Door Card has to be able to render without its middle button.
   */
  readonly chime: boolean;
  readonly maxResolution?: number;
}

export interface RingDevice {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  readonly reportedAt?: number;
  readonly capabilities: RingCapabilities;
}

export interface RingHistoryEvent {
  readonly id: string;
  readonly deviceId: string;
  /** Epoch ms. The window a recorded frame can be pulled from. */
  readonly start: number;
  readonly end?: number;
  /** Ring's own label, e.g. 'on_demand', 'motion', 'ding'. */
  readonly eventType: string;
  readonly detections: readonly string[];
}

/** Where a retrievable frame lives. The URL is presigned and short-lived. */
export interface RingImage {
  readonly url: string;
  readonly capturedAt: number;
  readonly fetchedAt: number;
}
