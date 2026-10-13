/**
 * Whose television this is, from the token it was handed when it was
 * connected (packages/contracts/src/familyTelevision.ts).
 *
 * The one decision the app's top makes (App.tsx): the resident's television,
 * with everything that is hers — the card channel, the card service, the
 * Natural-Break Engine, what she watches — or a family member's own, which
 * has none of that and only asks the Wick server what that member may see
 * (family/FamilyApp.tsx). The card service asks the same question before it
 * holds a connection (headless/CardService.ts).
 *
 * A token that names no kind is the resident's, as every token was before
 * there were two. Any kind this build does not know is treated as not hers:
 * nothing of the resident's runs on a guess, and the server refuses a
 * television it does not know.
 */
import type { DeviceToken } from '@wick/contracts';

export type TelevisionMode = 'resident' | 'family';

export function televisionMode(token: DeviceToken): TelevisionMode {
  const kind: unknown = token.kind;
  return kind === undefined || kind === null ? 'resident' : 'family';
}
