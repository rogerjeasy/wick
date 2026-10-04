/**
 * The demo account: one click, and a visitor is a guest with a home of
 * their own to try Wick on. No email, no password, no code to confirm.
 *
 * It exists so that someone judging or trying Wick does not have to give an
 * email address to see it. It is a switch (`AppDeps.demoAccounts`), off
 * unless the deployment turns it on.
 *
 * What a guest is, and is not:
 *
 *   - A person like any other. INV-8 and INV-9 hold unchanged: their token
 *     is for their own demo home and nothing else, and they read nothing
 *     until the resident of that home presses Allow on its television —
 *     which, for a demo, is the virtual one.
 *   - Not in Cognito. A guest has nothing to sign in with, so there is
 *     nothing to keep there. Wick names them itself (`guest_<random>`), and
 *     the account is only as lasting as the browser that holds its link.
 *   - Never a way in to a real account. The one-click path acts only for a
 *     browser with no session, or a guest's own; someone signed in to a real
 *     account is shown the ordinary Approve page.
 *
 * And it cannot be used to fill the table: guests are made at a bounded
 * rate, counted here.
 */
import type { Identity } from './identity.js';

export const GUEST_ID_PREFIX = 'guest_';
export const GUEST_NAME = 'Guest';
/** The person the demo home is set up around — the product's own Margaret. */
export const DEMO_RESIDENT_NAME = 'Margaret';
export const DEMO_HOME_NAME = 'Demo home';

/** Generous for a hackathon's judges, far too few to be worth abusing. */
export const DEMO_ACCOUNTS_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

export function isGuest(userId: string): boolean {
  return userId.startsWith(GUEST_ID_PREFIX);
}

export function newGuest(id: string): Identity {
  return { userId: `${GUEST_ID_PREFIX}${id}`, email: '', name: GUEST_NAME };
}

export interface DemoLimiter {
  /** True if one more guest may be made now; counts it if so. */
  take(): boolean;
}

/**
 * A fixed one-hour window, held in this process. The server runs as one
 * instance (infra/mcp.tf), so this process's count is the deployment's.
 */
export function createDemoLimiter(now: () => number, limit: number = DEMO_ACCOUNTS_PER_HOUR): DemoLimiter {
  let windowStart = now();
  let made = 0;
  return {
    take() {
      const at = now();
      if (at - windowStart >= HOUR_MS) {
        windowStart = at;
        made = 0;
      }
      if (made >= limit) return false;
      made += 1;
      return true;
    },
  };
}
