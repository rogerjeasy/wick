/**
 * S6 — The Rhythm. Pure builders for the atomic day-of-week/hour bucket
 * counters described in docs/WICK-TECHNICAL.md §8.2's three tables
 * (`tv_activity`, `door_activity`, `presence`).
 *
 * These were originally designed against Amazon Timestream, which §8.2
 * names as "purpose-built" for binned aggregates. Timestream for
 * LiveAnalytics turns out to reject `CreateDatabase` for this AWS account
 * with `AccessDeniedException: Only existing Timestream for LiveAnalytics
 * customers can access the service` — a 2024 platform restriction with no
 * IAM fix and no known turnaround time via AWS Support. Waiting on that
 * would burn real days of the one thing S6's baseline can't recover
 * (docs/WICK-TECHNICAL.md §4.5: "a five-week real baseline... is worth more
 * than any feature").
 *
 * So this targets the DynamoDB table that's already deployed and already
 * granted to both writers instead: one item per (dimension tuple, bucket),
 * incremented atomically with `ADD count`. A day-of-week/hour bucket is
 * exactly what the narrator's baseline query needs (§8.2: "binned by
 * day-of-week and hour") — DynamoDB just can't compute it lazily at query
 * time the way Timestream's `INTERPOLATE` could, so the binning happens at
 * write time instead. No baseline or z-score logic lives here; that's the
 * narrator's job once three weeks of buckets exist (§4.5).
 */

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** e.g. "TUE-06". Always UTC — every other timestamp in this repo is epoch ms UTC. */
export function dowHourBucket(at: number): string {
  const d = new Date(at);
  const dow = DOW[d.getUTCDay()];
  const hour = String(d.getUTCHours()).padStart(2, '0');
  return `${dow}-${hour}`;
}

export interface RhythmBucketKey {
  readonly pk: string;
  readonly sk: string;
}

export interface DoorActivityInput {
  readonly householdId: string;
  readonly deviceId: string;
  readonly subType: string;
  readonly measureName: 'motion' | 'button_press';
  readonly at: number;
}

/** dimensions: deviceId, subType, measureName — §8.2's `door_activity` table. */
export function buildDoorActivityKey(input: DoorActivityInput): RhythmBucketKey {
  return {
    pk: `HH#${input.householdId}`,
    sk: `RHYTHM#door_activity#${input.deviceId}#${input.subType}#${input.measureName}#${dowHourBucket(input.at)}`,
  };
}

export interface PresenceInput {
  readonly householdId: string;
  readonly personId: string;
  readonly measureName: 'arrival' | 'departure';
  readonly at: number;
}

/** dimensions: personId, measureName — §8.2's `presence` table. */
export function buildPresenceKey(input: PresenceInput): RhythmBucketKey {
  return {
    pk: `HH#${input.householdId}`,
    sk: `RHYTHM#presence#${input.personId}#${input.measureName}#${dowHourBucket(input.at)}`,
  };
}

export interface TvActivityInput {
  readonly householdId: string;
  readonly deviceId: string;
  readonly measureName: 'power_on' | 'foreground';
  readonly at: number;
}

/** dimensions: deviceId, measureName — §8.2's `tv_activity` table. */
export function buildTvActivityKey(input: TvActivityInput): RhythmBucketKey {
  return {
    pk: `HH#${input.householdId}`,
    sk: `RHYTHM#tv_activity#${input.deviceId}#${input.measureName}#${dowHourBucket(input.at)}`,
  };
}
