/**
 * Option A — AWS IoT Core, MQTT over WSS.
 *
 * Materially better if it works: persistent sessions with QoS 1 deliver cards
 * queued while the television was off, on reconnect — the "card is waiting"
 * requirement solved at the transport layer rather than in application code.
 *
 * Unproven inside Vega's RN 0.83 fork. Timebox the spike to four hours; if it
 * fights at all, take WebSocketChannel and move on the same day.
 */
// TODO(SP-5): verify mqtt.js over WSS connects and survives a reconnect cycle.
export {};
