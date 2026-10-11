/**
 * Stands in for `@amazon-devices/react-native-w3cmedia` on Fire OS: the
 * `VideoPlayer` object the screens drive (videoPlayer.ts) and the view that
 * shows its picture, which here is ExoPlayer through react-native-video.
 *
 * The view does what the player object says — its source, whether it is
 * paused, how loud — and tells the object what the real player did.
 */
import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Video, { ResizeMode, type VideoRef } from 'react-native-video';
import { VideoPlayer } from './videoPlayer';

export { VideoPlayer };

/** How often the position is reported. The Natural-Break Engine samples once a second; this keeps a seek's arithmetic fresh. */
const PROGRESS_INTERVAL_MS = 250;

export interface KeplerVideoViewProps {
  readonly videoPlayer: VideoPlayer;
  readonly style?: StyleProp<ViewStyle>;
  /** Vega's name for how the picture fits. Wick only ever asks for "fit". */
  readonly scalingmode?: string;
}

export function KeplerVideoView({ videoPlayer, style }: KeplerVideoViewProps): React.JSX.Element | null {
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const video = React.useRef<VideoRef>(null);

  React.useEffect(() => videoPlayer.watch(redraw), [videoPlayer]);
  React.useEffect(() => {
    videoPlayer.attach({ seek: (seconds) => video.current?.seek(seconds) });
    return () => videoPlayer.attach(undefined);
  }, [videoPlayer]);

  if (!videoPlayer.src) return null;
  return (
    // Android hands a key press to whatever holds focus, and to nothing if
    // nothing does: with only a picture on screen the remote would be dead
    // (seen on the Android TV emulator — play/pause and OK never arrived).
    // So the picture's frame holds focus while it is all there is. A card's
    // button asks for focus when it appears and takes it; when the card
    // goes, focus comes back here. Vega delivers key presses to the app
    // whatever is focused, which is why the shared screens never needed this.
    <View style={style} focusable hasTVPreferredFocus>
      <Video
        ref={video}
        source={{ uri: videoPlayer.src }}
        paused={videoPlayer.paused}
        volume={videoPlayer.volume}
        resizeMode={ResizeMode.CONTAIN}
        style={StyleSheet.absoluteFill}
        controls={false}
        // The player's own view never takes the remote: its frame, above, does.
        focusable={false}
        progressUpdateInterval={PROGRESS_INTERVAL_MS}
        onLoad={(loaded) => videoPlayer.reportLoaded(loaded.duration)}
        onProgress={(progress) => videoPlayer.reportProgress(progress.currentTime)}
        onBuffer={(buffer) => videoPlayer.reportBuffering(buffer.isBuffering)}
        onEnd={() => videoPlayer.reportEnded()}
        onError={() => videoPlayer.reportError()}
      />
    </View>
  );
}
