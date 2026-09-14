/**
 * Re-exports the transport contract from @wick/contracts.
 *
 * The implementation is a decision gate (SP-5): AWS IoT Core MQTT over WSS, or
 * API Gateway WebSocket. Build against this interface; swap the implementation.
 * See docs/WICK-TECHNICAL.md §4.1.
 */
export type { DeviceChannel, ChannelState, Unsubscribe } from '@wick/contracts';
