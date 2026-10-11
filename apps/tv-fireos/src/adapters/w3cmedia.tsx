/**
 * Stands in for `@amazon-devices/react-native-w3cmedia` on Fire OS: the
 * `VideoPlayer` object the screens drive (videoPlayer.ts) and the view that
 * shows its picture, which here is ExoPlayer through react-native-video.
 *
 * The view does what the player object says — its source, whether it is
 * paused, how loud — and tells the object what the real player did.
 */
import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
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
    <Video
      ref={video}
      source={{ uri: videoPlayer.src }}
      paused={videoPlayer.paused}
      volume={videoPlayer.volume}
      resizeMode={ResizeMode.CONTAIN}
      style={style}
      controls={false}
      // The remote's focus belongs to the card's buttons, never the picture.
      focusable={false}
      progressUpdateInterval={PROGRESS_INTERVAL_MS}
      onLoad={(loaded) => videoPlayer.reportLoaded(loaded.duration)}
      onProgress={(progress) => videoPlayer.reportProgress(progress.currentTime)}
      onBuffer={(buffer) => videoPlayer.reportBuffering(buffer.isBuffering)}
      onEnd={() => videoPlayer.reportEnded()}
      onError={() => videoPlayer.reportError()}
    />
  );
}
