/**
 * The one look anything takes at a picture before it is sent to her
 * television (packages/contracts mantel.ts).
 *
 * Amazon Rekognition's DetectModerationLabels is asked about the bytes
 * themselves, before anything is stored: a picture that is refused is
 * never written anywhere. Wick refuses a picture when Rekognition is at
 * least eighty per cent sure of something in one of four of its top-level
 * categories — Explicit, Violence, Visually Disturbing, Hate Symbols — and
 * lets the others through: a glass of wine at Christmas and a grandchild on
 * a beach are pictures for a mantelpiece.
 *
 * It FAILS CLOSED. Nothing else on this path looks at the picture, so a
 * picture that could not be checked — Rekognition erred, or took more than
 * two seconds — is a picture that is not sent.
 *
 * Nothing is logged of a picture but a count: never its bytes, never a
 * label's name, never whose it was. What a family member's picture was
 * refused for is nobody's to read in a log.
 *
 * The taxonomy is Rekognition's content moderation version 7
 * (docs.aws.amazon.com/rekognition/latest/dg/moderation-api.html, read
 * 2026-10-13): three levels, each label returned with its `ParentName` and
 * `TaxonomyLevel`, and a top-level label returned beside the ones under it.
 */
import { DetectModerationLabelsCommand } from '@aws-sdk/client-rekognition';

/** What Rekognition says of a label. Named fields only: this is all that is read. */
export interface ModerationLabel {
  readonly Name?: string | undefined;
  readonly Confidence?: number | undefined;
  readonly ParentName?: string | undefined;
  readonly TaxonomyLevel?: number | undefined;
}

/** A RekognitionClient's send, injected so the exact request is tested without AWS. */
export type RekognitionSend = (
  command: DetectModerationLabelsCommand,
  options?: { readonly abortSignal?: AbortSignal },
) => Promise<{ readonly ModerationLabels?: readonly ModerationLabel[] | undefined }>;

/**
 * `pass`: checked, and nothing to refuse. `refuse`: checked, and not a
 * picture Wick will send. `unchecked`: it could not be checked — which is
 * a refusal too, said differently, because it may pass in a moment.
 */
export type ModerationVerdict = 'pass' | 'refuse' | 'unchecked';

/** Looks at a picture's bytes. Never throws: what cannot be checked is `unchecked`. */
export type Moderation = (bytes: Uint8Array) => Promise<ModerationVerdict>;

/** Rekognition's top-level categories a picture is refused for. */
export const REFUSED_CATEGORIES = ['Explicit', 'Violence', 'Visually Disturbing', 'Hate Symbols'] as const;
/** How sure Rekognition has to be, in per cent. */
export const MODERATION_REFUSE_AT = 80;
/** How long Rekognition is waited for. */
export const MODERATION_TIMEOUT_MS = 2000;
/** Rekognition's own default: low enough that a label comes back with the categories above it. */
const MIN_CONFIDENCE = 50;

/**
 * Every label under those four, by name — so that one returned without the
 * category above it (below `MinConfidence`, say) is still placed.
 */
const UNDER_REFUSED: ReadonlySet<string> = new Set([
  ...REFUSED_CATEGORIES,
  // Explicit
  'Explicit Nudity', 'Exposed Male Genitalia', 'Exposed Female Genitalia', 'Exposed Buttocks or Anus', 'Exposed Female Nipple', 'Explicit Sexual Activity', 'Sex Toys',
  // Violence
  'Weapons', 'Graphic Violence', 'Weapon Violence', 'Physical Violence', 'Self-Harm', 'Blood & Gore', 'Explosions and Blasts',
  // Visually Disturbing
  'Death and Emaciation', 'Emaciated Bodies', 'Corpses', 'Crashes', 'Air Crash',
  // Hate Symbols
  'Nazi Party', 'White Supremacy', 'Extremist',
]);

/** The top-level categories Wick lets through: a label under one of these is placed, and passes. */
const LET_THROUGH: ReadonlySet<string> = new Set([
  'Non-Explicit Nudity of Intimate parts and Kissing',
  'Swimwear or Underwear',
  'Drugs & Tobacco',
  'Alcohol',
  'Rude Gestures',
  'Gambling',
]);

/**
 * Whether a set of labels refuses a picture. Each label is judged by its
 * own confidence and placed by its name or, failing that, by walking up
 * the parents Rekognition returned beside it. A confident label that
 * cannot be placed at all refuses the picture: an unknown is not a pass.
 */
export function verdictOf(labels: readonly ModerationLabel[] | undefined): Exclude<ModerationVerdict, 'unchecked'> {
  const all = labels ?? [];
  const parentOf = new Map(all.flatMap((label) => (label.Name ? [[label.Name, label.ParentName ?? ''] as const] : [])));

  const placed = (label: ModerationLabel): 'refused' | 'let_through' | 'unknown' => {
    let name = label.Name ?? '';
    // Three levels: three steps up are all there can be.
    for (let step = 0; step < 4 && name; step += 1) {
      if (UNDER_REFUSED.has(name)) return 'refused';
      if (LET_THROUGH.has(name)) return 'let_through';
      name = parentOf.get(name) ?? (step === 0 ? (label.ParentName ?? '') : '');
    }
    // A top-level label of a category this file has not heard of is not one of the four.
    return label.TaxonomyLevel === 1 || (!label.ParentName && label.TaxonomyLevel === undefined) ? 'let_through' : 'unknown';
  };

  for (const label of all) {
    if ((label.Confidence ?? 0) < MODERATION_REFUSE_AT) continue;
    if (placed(label) !== 'let_through') return 'refuse';
  }
  return 'pass';
}

export function createRekognitionModeration(send: RekognitionSend, timeoutMs: number = MODERATION_TIMEOUT_MS): Moderation {
  return async (bytes) => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(Object.assign(new Error('moderation timed out'), { name: 'ModerationTimeout' }));
      }, timeoutMs);
    });
    try {
      const answer = await Promise.race([
        send(new DetectModerationLabelsCommand({ Image: { Bytes: bytes }, MinConfidence: MIN_CONFIDENCE }), { abortSignal: abort.signal }),
        late,
      ]);
      const verdict = verdictOf(answer.ModerationLabels);
      // A count, and nothing that says what was seen or whose it was.
      if (verdict === 'refuse') console.log(JSON.stringify({ level: 'info', msg: 'photo_refused', labels: answer.ModerationLabels?.length ?? 0 }));
      return verdict;
    } catch (err) {
      // The error's name only: its message can carry an account id or an ARN.
      console.error(JSON.stringify({ level: 'error', msg: 'photo_not_checked', err: err instanceof Error ? err.name : 'unknown' }));
      return 'unchecked';
    } finally {
      clearTimeout(timer);
    }
  };
}
