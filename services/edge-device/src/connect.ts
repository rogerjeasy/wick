/**
 * WebSocket connect.
 *
 *   - verify the device-bound JWT (RS256), check the deviceId denylist
 *   - reconcile: client sends lastSeenCardId, we replay everything after it
 *   - rotate the token on each successful connect
 *
 * See docs/WICK-TECHNICAL.md §4.1, §4.2.
 */
export {};
