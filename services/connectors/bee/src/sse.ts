/**
 * SSE consumer for /v1/stream.
 * The 120s idle timeout will fight a long-lived consumer — expect heartbeat +
 * reconnect, and write it up (SP-6).
 */
export {};
