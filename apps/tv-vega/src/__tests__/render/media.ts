/**
 * The television's media player, stood in for — for tests only.
 *
 * `@amazon-devices/react-native-w3cmedia` is a native module. A render test
 * hands it this instead:
 *
 *   vi.mock('@amazon-devices/react-native-w3cmedia', () => import('../../__tests__/render/media.js'));
 *
 * A player here plays nothing. It remembers what it was asked — the address
 * it was given, whether it was started and let go — and a test says what the
 * platform would have said back (`emit('playing')`, `emit('error')`).
 * `KeplerVideoView` is a host component like the rest of the platform
 * (platform.ts): the test reads which player it was handed.
 */

export const KeplerVideoView = 'KeplerVideoView';

/** Every player made since the last `resetMedia`, in the order they were made. */
export const players: VideoPlayer[] = [];

export class VideoPlayer {
  src = '';
  volume = 1;
  initialized = false;
  playing = false;
  released = false;
  readonly #listeners = new Map<string, (() => void)[]>();

  constructor() {
    players.push(this);
  }

  initialize(): Promise<void> {
    this.initialized = true;
    return Promise.resolve();
  }

  deinitialize(): Promise<void> {
    this.released = true;
    this.playing = false;
    return Promise.resolve();
  }

  play(): Promise<void> {
    this.playing = true;
    return Promise.resolve();
  }

  pause(): void {
    this.playing = false;
  }

  addEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((l) => l !== listener));
  }

  /** What the platform says of the picture: 'playing', 'error', 'ended'. Call inside `act`. */
  emit(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
}

/** The audio player Read to me speaks through (read/speechPlayer.ts): the same stand-in, for speech. */
export class AudioPlayer extends VideoPlayer {
  constructor(
    readonly contentType?: string,
    readonly usage?: string,
  ) {
    super();
  }
}

export const AudioContentType = { CONTENT_TYPE_SPEECH: 'speech' } as const;
export const AudioUsageType = { USAGE_MEDIA: 'media' } as const;

export function resetMedia(): void {
  players.length = 0;
}
