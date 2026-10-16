/**
 * The stand-in doorbell: somebody arriving at a demo home's door.
 *
 * A demo home (services/mcp-server accounts/demo.ts) has no Ring doorbell,
 * so whoever tries Wick would never see what Wick is for: the door card on
 * the resident's television, with the picture and the sentence about who is
 * there. From the family app, a member of a demo home can make one of a
 * fixed list of stand-in visitors arrive (`POST /api/demo/doorbell`). The
 * Wick server hands that to the Door agent, which takes it through its own
 * path — the roster, the timeline, the vision model looking at the picture,
 * the television — with only the Ring parts stood in for
 * (services/agent agents/door/demoDoor.ts). It never reaches Ring.
 *
 * Labelled everywhere: the family app calls it a stand-in doorbell, the
 * door card's headline says so (agents/door/index.ts), and every row it
 * writes carries `simulated`, like the rest of the demo home. It runs in a
 * demo home and nowhere else, checked by the server and again by the agent.
 *
 * The pictures were made with an image model, of nobody real
 * (docs/demo-door/NOTICE.md), and are served from the project's published
 * pages so the television can load them like any picture from the door.
 */

/** The event's source. Only the Wick server's role can invoke the Door agent with one (infra/agent.tf). */
export const DEMO_DOOR_SOURCE = 'wick.demo-door';
export const DEMO_DOOR_DETAIL_TYPE = 'demo.doorbell';

/** Where the stand-in pictures are published (docs/demo-door, GitHub Pages). */
export const DEMO_DOOR_PICTURES_URL = 'https://rogerjeasy.github.io/wick/demo-door/';

export const DEMO_VISITOR_KEYS = ['carer', 'parcel', 'stranger', 'nobody', 'arranged'] as const;
export type DemoVisitorKey = (typeof DEMO_VISITOR_KEYS)[number];

export interface DemoVisitor {
  readonly key: DemoVisitorKey;
  /** What the family app calls them. */
  readonly label: string;
  /** What a Ring doorbell would have sent for them (Appendix B): a press, or a person seen moving. */
  readonly eventType: 'button_press' | 'motion_detected';
  readonly subType?: 'human';
  /** The file, in docs/demo-door and beside the Door agent's bundle. */
  readonly picture: string;
  readonly pictureUrl: string;
}

const visitor = (key: DemoVisitorKey, label: string, eventType: DemoVisitor['eventType'], picture = `${key}.jpg`): DemoVisitor => ({
  key,
  label,
  eventType,
  ...(eventType === 'motion_detected' ? { subType: 'human' as const } : {}),
  picture,
  pictureUrl: `${DEMO_DOOR_PICTURES_URL}${picture}`,
});

const VISITORS: Readonly<Record<DemoVisitorKey, DemoVisitor>> = {
  // The demo home's regular visitor (accounts/demoHome.ts DEMO_VISITOR). The door matches her only inside her usual time.
  carer: visitor('carer', 'Maria, the carer', 'button_press'),
  parcel: visitor('parcel', 'A parcel delivery', 'button_press'),
  stranger: visitor('stranger', 'Somebody she does not know', 'button_press'),
  // Ring saw a person move, and the picture shows nobody: the card's headline is corrected (door/index.ts).
  nobody: visitor('nobody', 'Nobody there, only movement', 'motion_detected'),
  // Whoever a member arranged to come (errand.ts arrange_visit), ringing now: arrange one a few minutes ahead and
  // ring this, and the door matches them by the time as it would anyone expected. Somebody at the door with
  // something for the house: the delivery's picture, made already, and described by the vision step as it is.
  arranged: visitor('arranged', 'The visitor you arranged', 'button_press', 'parcel.jpg'),
};

export const isDemoVisitorKey = (value: unknown): value is DemoVisitorKey =>
  typeof value === 'string' && (DEMO_VISITOR_KEYS as readonly string[]).includes(value);

export const demoVisitor = (key: DemoVisitorKey): DemoVisitor => VISITORS[key];

/** The id of one ring: made by the family app (its Idempotency-Key) or by the server. */
const RING_ID = /^[A-Za-z0-9_-]{16,64}$/;
export const isDemoRingId = (value: unknown): value is string => typeof value === 'string' && RING_ID.test(value);

/**
 * What the Wick server hands the Door agent. The household is the one in the
 * caller's verified token (INV-8), put there by the server; the agent checks
 * again that it is a demo home before anything is done.
 */
export interface DemoDoorEvent {
  readonly householdId: string;
  readonly visitor: DemoVisitorKey;
  readonly ringId: string;
  readonly occurredAt: number;
  readonly correlationId: string;
}

export function demoDoorEventOf(detail: unknown): DemoDoorEvent | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined;
  const { householdId, visitor: key, ringId, occurredAt, correlationId } = detail as Record<string, unknown>;
  if (typeof householdId !== 'string' || !householdId) return undefined;
  if (!isDemoVisitorKey(key) || !isDemoRingId(ringId)) return undefined;
  if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return undefined;
  if (typeof correlationId !== 'string' || !correlationId) return undefined;
  return { householdId, visitor: key, ringId, occurredAt, correlationId };
}
