/**
 * Wrapper over @amazon-devices/react-native-w3cmedia.
 *
 * Owning playback is what makes the Natural-Break Engine possible — this is not
 * incidental. The player is the only source of the position/credits signal that
 * decides when Wick is allowed to speak.
 *
 * Out-of-process playback (kepler-player-client/server) is deliberately deferred:
 * it survives UI crashes but is not worth the complexity in v1. See §3.6.
 */
// TODO(S2): emit PlaybackSnapshot at 1Hz and on every state change.
// TODO(M1): duck to -6dB via keplerscript-audio-lib for spoken cards. Never mute.
export {};
