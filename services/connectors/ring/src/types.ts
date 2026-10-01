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
   * This device IS a chime Wick can sound: `audio.supported_actions` contains
   * `chime.play` (Ring docs, Chimes → Identifying a Chime). A camera's audio
   * block is present-but-null (FL-006); a chime is a separate device.
   */
  readonly chime: boolean;
  readonly maxResolution?: number;
}

export interface RingDevice {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  readonly reportedAt?: number;
  /** `status.audio.snooze.active`. Only a chime reports it; a snoozed chime must not be played. */
  readonly snoozed?: boolean;
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

/** One of the app's audio slots on a chime (`configurations.audio.customizable_slots[]`). */
export interface ChimeSlot {
  readonly event: string;
  readonly disabled: boolean;
  readonly audioRef: string;
  readonly audioName: string;
}

/** What happened when Wick asked one chime to play. */
export type ChimeOutcome = 'rang' | 'snoozed' | 'offline' | 'no_audio' | 'failed';
