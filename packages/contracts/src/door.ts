/**
 * Ring-originated events and the Door agent's output.
 * See docs/WICK-TECHNICAL.md §5.2, §7.1, Appendix B.
 */

/** Verified against the Ring Partner API webhook documentation (2026-09-14). */
export type RingEventType =
  | 'motion_detected'
  | 'button_press'
  | 'device_added'
  | 'device_removed'
  | 'device_online'
  | 'device_offline'
  | 'app_integration_added'
  | 'app_integration_removed'
  | 'subscription_activated'
  | 'subscription_deactivated';

export interface RingEvent {
  readonly requestId: string;
  readonly type: RingEventType;
  /** e.g. "human" on motion_detected. Ring's taxonomy is coarse — see FRICTION.md. */
  readonly subType?: string;
  readonly deviceId: string;
  readonly componentIds?: readonly number[];
  readonly occurredAt: number;
  readonly correlationId: string;
}

/** A person the household has explicitly added. Schedule-based by default (D3). */
export interface RosterEntry {
  readonly personId: string;
  readonly name: string;
  readonly photoRef?: string;
  /** Cron-ish expectation, e.g. "TUE,FRI 09:00±30m". Used instead of biometrics. */
  readonly expectedPattern?: string;
}

export interface VisitorMatch {
  readonly personId: string;
  readonly name: string;
  readonly basis: 'schedule' | 'roster_face';
  readonly expectedToday: boolean;
  readonly confidence: number;
}
