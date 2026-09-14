/**
 * Snapshot   POST /v1/devices/{id}/media/image/download
 * Live       POST /v1/devices/{id}/media/streaming/whep/sessions  (application/sdp)
 * RTSP alt   rtsps://video.rtsp.amazonvision.com:322/v1/devices/{id}/stream
 * Clip       POST /v1/devices/{id}/media/video/download
 * Chime      POST /v1/devices/{id}/media/audio/playback           <- M1, "Just a moment"
 *
 * Multi-module cameras: append ?component_id=N.
 * All server-to-server. Ring blocks browser and TV origins entirely.
 */
export {};
