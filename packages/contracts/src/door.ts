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
  /**
   * One visit somebody said they would make (the family's expect_visit
   * tool): the moment, and how many minutes either side of it still count.
   * Like the pattern, it is a time and nothing more.
   */
  readonly expectedOnce?: { readonly at: number; readonly windowMin: number };
  /**
   * The member who put a regular visitor on the roster (the family's
   * add_regular_visitor tool). The roster is what the door's "this looks
   * like Maria" rests on, so an entry stands only while the person who
   * vouched for it is still allowed by the resident (door/roster.ts
   * stillWelcome). Absent on an entry the household's operator made.
   */
  readonly addedBy?: string;
}

export interface VisitorMatch {
  readonly personId: string;
  readonly name: string;
  readonly basis: 'schedule' | 'roster_face';
  readonly expectedToday: boolean;
  readonly confidence: number;
}

/**
 * "Ask Sarah to look" — the resident asks someone in the family circle to
 * look at the picture of whoever is at the door. One row per door card:
 * `HH#<household>` / `LOOK#<cardId>`, written by the Door agent's
 * askFamily.ts when the button is pressed and read by the family's
 * get_door_request / answer_door_request tools. It holds no picture and no
 * description: those stay on the card, and go when the card does (INV-3).
 */
export const DOOR_LOOK_SK_PREFIX = 'LOOK#';

/**
 * Everything a family member can answer when asked to look. Wick's own
 * sentences, chosen and never written: the answer is shown on the
 * resident's television under the family member's name, at the moment the
 * resident is deciding whether to open the door to a stranger. Words a
 * caller could write there are words anyone who got hold of a family
 * account, or talked an assistant round, could put in a daughter's mouth.
 *
 * Each reads on after "<name> says:". None tells the resident to open the
 * door: the most an answer does is say the visitor is known.
 */
export const DOOR_ANSWERS = {
  known: "It's all right, I know who that is.",
  dont_open: "Please don't open the door. I'll ring you now.",
  not_sure: "I can't tell who that is. I'll ring you now.",
} as const;
export type DoorAnswer = keyof typeof DOOR_ANSWERS;

export const isDoorAnswer = (key: unknown): key is DoorAnswer => typeof key === 'string' && Object.hasOwn(DOOR_ANSWERS, key);
