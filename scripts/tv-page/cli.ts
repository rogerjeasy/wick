/** `npm run tv:build` — see build.ts. Kept apart so that importing build.ts in a test builds nothing. */
import { main } from './build.js';

await main();
