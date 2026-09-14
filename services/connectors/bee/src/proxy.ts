/**
 * Bee local proxy client — 127.0.0.1:8787 (or ~/.bee/proxy.sock).
 * Only /v1/* forwards. Default idle timeout 120s.
 *
 *   GET  /v1/me · /v1/changes · /v1/facts · /v1/todos · /v1/daily · /v1/conversations
 *   POST /v1/search/conversations[/neural]
 *   GET  /v1/stream   (SSE)
 */
export {};
