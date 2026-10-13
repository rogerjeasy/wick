/**
 * The platform's audio player, for one reading (read/reading.ts) — and the
 * only file that names it. Everything else is handed a `SpeechPlayer`, so
 * no test ever touches the real module.
 *
 * On Vega it is `AudioPlayer` from `@amazon-devices/react-native-w3cmedia`,
 * made for speech as it was seen to play an https MP3 on the simulator
 * (2026-10-13). On Fire OS the same names are the adapter's, over
 * react-native-video (apps/tv-fireos/src/adapters/audioPlayer.ts).
 */
import { AudioContentType, AudioPlayer, AudioUsageType } from '@amazon-devices/react-native-w3cmedia';
import type { SpeechPlayer } from './reading.js';

export function createSpeechPlayer(): SpeechPlayer {
  const player = new AudioPlayer(AudioContentType.CONTENT_TYPE_SPEECH, AudioUsageType.USAGE_MEDIA);
  return {
    initialize: () => player.initialize(),
    deinitialize: () => player.deinitialize(),
    on: (type, listener) => player.addEventListener(type, listener),
    load: (url) => {
      player.src = url;
    },
    play: () => player.play(),
    pause: () => player.pause(),
  };
}

/**
 * Whether a card can be read aloud here at all. Where it cannot, the mark
 * of the Play key is not drawn and Play does what it did before. A
 * platform's player may say so itself (`available`): the Fire OS one does,
 * until its unseen view is on the screen to play through.
 */
export function canRead(): boolean {
  return typeof AudioPlayer === 'function' && (AudioPlayer as { readonly available?: boolean }).available !== false;
}
