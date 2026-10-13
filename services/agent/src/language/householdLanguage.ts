/**
 * The language a household's television speaks (packages/contracts
 * language.ts) — read when a card is sent, and never remembered from an
 * earlier one.
 *
 * It used to be remembered for a minute. That was wrong, and was seen to be:
 * her yes to the language question changes the household's row at once, her
 * television's own words change with it — and for the rest of that minute
 * every card sent still went out in the language she had just left. A card
 * in English under Spanish buttons is half a sentence in each language, the
 * one thing this feature must never show her; and the same going back.
 *
 * So there is no memory here at all, and no clock: each send reads the one
 * attribute, as it is so this instant (a consistent read — she may have
 * answered a moment ago, on another television). What that costs is one
 * small `GetItem` a send (store/household.ts loadHouseholdLanguage), made
 * beside work the send does anyway wherever there is any (egress.ts): the
 * door's first card writes its row while it is read.
 *
 * One thing is kept: two sends that ask at the same moment — a card and its
 * patch in the same tick — share the read that is already on its way. It is
 * forgotten the instant it answers; nothing outlives the read itself.
 *
 * And a read that fails is English, not an error: a card is never held up,
 * and never lost, for want of its language.
 *
 * What this cannot close: the read and the push are two steps, so a card
 * whose language was read an instant before her answer still arrives in the
 * old one. Nothing stale is stored by it — the row is the English card
 * whichever language was read — and her television asks for its cards again
 * when its language changes, which the edge answers in the language as it
 * is then (edge-device language.mjs). egress.ts says what that means for a
 * note's own text.
 */
import { DEFAULT_LANGUAGE, type HouseholdLanguage } from '@wick/contracts';

export interface LanguageReader {
  /** The household's language, as it is now. Never throws: English when it cannot be read. */
  readonly of: (householdId: string) => Promise<HouseholdLanguage>;
}

export function languageReader(input: {
  /** One read of the household's row. Always asked for what is so this instant. */
  readonly read: (householdId: string, options: { readonly consistent: true }) => Promise<HouseholdLanguage>;
  readonly log?: (line: Record<string, unknown>) => void;
}): LanguageReader {
  const { read, log = (line) => console.error(JSON.stringify(line)) } = input;
  /** Reads on their way, and nothing else: an entry is gone the moment its read answers. */
  const underWay = new Map<string, Promise<HouseholdLanguage>>();

  const ask = async (householdId: string): Promise<HouseholdLanguage> => {
    try {
      return await read(householdId, { consistent: true });
    } catch (err) {
      // Why, and never for whom.
      log({ level: 'error', msg: 'household_language_unread', reason: (err as { name?: unknown } | undefined)?.name?.toString() ?? 'error' });
      return DEFAULT_LANGUAGE;
    }
  };

  return {
    of(householdId) {
      // Two sends at the same moment make one read.
      const shared = underWay.get(householdId);
      if (shared) return shared;
      const started = ask(householdId).finally(() => underWay.delete(householdId));
      underWay.set(householdId, started);
      return started;
    },
  };
}
