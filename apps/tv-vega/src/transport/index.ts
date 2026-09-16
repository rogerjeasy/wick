/**
 * Re-exports the transport contract from @wick/contracts, plus the one
 * factory that is allowed to pick between the two concrete implementations.
 * See docs/WICK-TECHNICAL.md §4.1 and the plan's Scope decisions for why both
 * exist and how the choice is made at runtime rather than build time.
 */
export type { DeviceChannel, ChannelState, Unsubscribe } from '@wick/contracts';
export { createDeviceChannel, type DeviceChannelConfig } from './createDeviceChannel.js';
