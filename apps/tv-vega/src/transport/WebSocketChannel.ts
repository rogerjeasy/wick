/**
 * Option B — API Gateway WebSocket. Zero library risk: RN ships a standard
 * WebSocket. Connection state lives in DynamoDB; catch-up is ours to implement.
 *
 * Reconnect: exponential backoff 1s -> 30s, full jitter. On open, always
 * reconcile by sending lastSeenCardId and receiving everything after it.
 */
// TODO(SP-5): implement, then benchmark against MqttChannel before choosing.
export {};
