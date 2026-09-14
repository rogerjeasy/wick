/**
 * WickEdge — API Gateway HTTP API (Ring webhooks), WebSocket API (device),
 * and their Lambdas.
 *
 * The Ring receiver must ACK inside 5 seconds; give it a tight timeout and
 * reserved concurrency so a downstream problem can never delay the ACK.
 */
export {};
