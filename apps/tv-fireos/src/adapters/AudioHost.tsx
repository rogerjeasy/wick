/**
 * The unseen view a reading is played through on Fire OS (audioPlayer.ts):
 * react-native-video plays only while it is on the screen, so one silent,
 * sizeless `<Video>` is drawn here for each player that has an address.
 * Put up once, beside the app (Root.tsx).
 *
 * `disableFocus`: on Android a player asks the system for the sound when it
 * starts, and the one that had it — the film — is paused for it.
 * react-native-video's own prop for not asking is this one (its
 * ReactExoplayerView `requestAudioFocus` returns at once when it is set).
 * The door's card is read over a film that goes on playing, so the reading
 * must not take the sound from it. (`mixWithOthers` is the iOS name for the
 * same wish, and does nothing here.)
 *
 * It never takes the remote and shows nothing. And it has not been heard:
 * this has not run on a device.
 */
import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import Video from 'react-native-video';
import { audioStage } from './audioPlayer';

/** How often the player says where it has got to. The first such report is "playing". */
const PROGRESS_INTERVAL_MS = 250;

export function AudioHost(): React.JSX.Element {
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    const stopWatching = audioStage.watch(redraw);
    const leave = audioStage.mount();
    return () => {
      leave();
      stopWatching();
    };
  }, []);

  return (
    <View style={styles.unseen} pointerEvents="none" importantForAccessibility="no-hide-descendants">
      {audioStage
        .players()
        .filter((player) => player.src)
        .map((player) => (
          <Video
            key={player.key}
            source={{ uri: player.src }}
            paused={player.paused}
            volume={player.volume}
            disableFocus
            playInBackground={false}
            controls={false}
            focusable={false}
            style={styles.unseen}
            progressUpdateInterval={PROGRESS_INTERVAL_MS}
            onPlaybackStateChanged={(state) => {
              if (state.isPlaying) player.reportPlaying();
            }}
            onProgress={() => player.reportPlaying()}
            onEnd={() => player.reportEnded()}
            onError={() => player.reportError()}
          />
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  unseen: {
    position: 'absolute',
    width: 0,
    height: 0,
  },
});
