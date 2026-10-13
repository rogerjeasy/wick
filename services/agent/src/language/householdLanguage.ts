/**
 * The language a household's television speaks (packages/contracts
 * language.ts), remembered for a minute.
 *
 * Everything sent to her television asks this first (egress.ts), the door's
 * headline included — and the headline has about a second. So the read
 * (store/household.ts loadHouseholdLanguage) is made once a minute for a
 * household, not once a card: English or not, what a send costs is a look
 * in this map.
 *
 * A minute is also how long a television may go on being sent the language
 * she has just left, by a process that has not heard. The one place that
 * cannot wait asks for what is so now (`fresh`): a home screen told whole,
 * which is how every television learns the language in the first place.
 *
 * And a read that fails is English, not an error: a card is never held up,
 * and never lost, for want of its language.
 */
import { DEFAULT_LANGUAGE, type HouseholdLanguage } from '@wick/contracts';

export const LANGUAGE_CACHE_MS = 60_000;
/** More households than one process sends to in a minute; past it, the one read longest ago makes room. */
export const LANGUAGE_CACHE_MAX = 500;

export interface LanguageCache {
  /** The household's language. Never throws: English when it cannot be read. */
  readonly of: (householdId: string, options?: { readonly fresh?: boolean }) => Promise<HouseholdLanguage>;
}

export function languageCache(input: {
  readonly read: (householdId: string, options?: { readonly consistent?: boolean }) => Promise<HouseholdLanguage>;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly max?: number;
  readonly log?: (line: Record<string, unknown>) => void;
}): LanguageCache {
  const { read, now = Date.now, ttlMs = LANGUAGE_CACHE_MS, max = LANGUAGE_CACHE_MAX, log = (line) => console.error(JSON.stringify(line)) } = input;
  const known = new Map<string, { readonly language: HouseholdLanguage; readonly until: number }>();
  const reading = new Map<string, Promise<HouseholdLanguage>>();

  const learn = async (householdId: string, fresh: boolean): Promise<HouseholdLanguage> => {
    try {
      const language = await (fresh ? read(householdId, { consistent: true }) : read(householdId));
      // Last read, last out.
      known.delete(householdId);
      known.set(householdId, { language, until: now() + ttlMs });
      while (known.size > max) known.delete(known.keys().next().value as string);
      return language;
    } catch (err) {
      // Why, and never for whom.
      log({ level: 'error', msg: 'household_language_unread', reason: (err as { name?: unknown } | undefined)?.name?.toString() ?? 'error' });
      return DEFAULT_LANGUAGE;
    }
  };

  return {
    of(householdId, options = {}) {
      if (options.fresh) return learn(householdId, true);
      const held = known.get(householdId);
      if (held && now() < held.until) return Promise.resolve(held.language);
      // Two sends at once make one read.
      const under = reading.get(householdId);
      if (under) return under;
      const started = learn(householdId, false).finally(() => reading.delete(householdId));
      reading.set(householdId, started);
      return started;
    },
  };
}
