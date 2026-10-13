/**
 * Re-exports the transport contract from @wick/contracts.
 *
 * The implementation is a decision gate (SP-5): AWS IoT Core MQTT over WSS, or
 * API Gateway WebSocket. Build against this interface; swap the implementation.
 * See docs/WICK-TECHNICAL.md §4.1.
 */
import type { DeviceChannel } from '@wick/contracts';

export type { DeviceChannel, ChannelState, Unsubscribe } from '@wick/contracts';

/**
 * A channel that can ask the server again for the cards this television is
 * owed — the request each transport makes by itself whenever it connects.
 * The card channel asks once more when her language changes
 * (startCardChannel.ts), so the cards it holds come again in the new one.
 *
 * Optional, and kept here: the contract's DeviceChannel has no such call,
 * and a channel without it is simply not asked.
 */
export interface ReconcilingChannel extends DeviceChannel {
  /** Never rejects: a request that cannot be sent now is made at the next connection anyway. */
  reconcile?(): Promise<void>;
}
