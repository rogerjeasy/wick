/**
 * The video player the Vega app drives, standing on Android's.
 *
 * On Vega, `VideoPlayer` (@amazon-devices/react-native-w3cmedia) is an
 * object shaped like a web page's media element: set `src`, call `play()`,
 * read `currentTime`. The watch and live screens, and PlayerService — which
 * feeds the Natural-Break Engine — are written against that
 * (apps/tv-vega/src/player/PlayerService.ts `MediaElementLike`).
 *
 * Android's player (react-native-video, ExoPlayer underneath) is a
 * component instead: it is told what to do through props and says what
 * happened through callbacks. This class is the object between the two. The
 * screens set and call it as they do on Vega; the view (w3cmedia.tsx) reads
 * what it should be doing from here and reports back what the real player did.
 *
 * No React and no native module in this file, so it is tested as plain code.
 */
export type MediaEvent = 'play' | 'pause' | 'playing' | 'waiting' | 'ended' | 'error';

/** The media element's readiness levels this code reports. */
const HAVE_NOTHING = 0;
const HAVE_CURRENT_DATA = 2;
const HAVE_ENOUGH_DATA = 4;

/** What the native view can be asked to do that props cannot say. */
export interface VideoSurface {
  seek(seconds: number): void;
}

export class VideoPlayer {
  #src = '';
  #paused = true;
  #ended = false;
  #volume = 1;
  #currentTime = 0;
  #duration = Number.NaN;
  #readyState = HAVE_NOTHING;
  /** True from `play()` until the picture is actually moving: the next progress report says "playing". */
  #awaitingPicture = false;
  #surface: VideoSurface | undefined;
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #watchers = new Set<() => void>();

  // ---- what the screens use, as on Vega ---------------------------------

  async initialize(): Promise<void> {}

  async deinitialize(): Promise<void> {
    this.#src = '';
    this.#paused = true;
    this.#listeners.clear();
    this.#changed();
  }

  get src(): string {
    return this.#src;
  }

  set src(url: string) {
    this.#src = url;
    this.#ended = false;
    this.#currentTime = 0;
    this.#duration = Number.NaN;
    this.#readyState = HAVE_NOTHING;
    this.#changed();
  }

  async play(): Promise<void> {
    this.#paused = false;
    this.#ended = false;
    this.#awaitingPicture = true;
    this.#emit('play');
    this.#changed();
  }

  pause(): void {
    if (this.#paused) return;
    this.#paused = true;
    this.#emit('pause');
    this.#changed();
  }

  get paused(): boolean {
    return this.#paused;
  }

  get ended(): boolean {
    return this.#ended;
  }

  get readyState(): number {
    return this.#readyState;
  }

  get duration(): number {
    return this.#duration;
  }

  get currentTime(): number {
    return this.#currentTime;
  }

  /** A seek. The position is taken at once, so two quick presses skip twice. */
  set currentTime(seconds: number) {
    this.#currentTime = seconds;
    this.#ended = false;
    this.#surface?.seek(seconds);
  }

  get volume(): number {
    return this.#volume;
  }

  set volume(level: number) {
    this.#volume = level;
    this.#changed();
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  // ---- what the view uses ------------------------------------------------

  /** Called when `src`, `paused` or `volume` changes, so the view draws again. */
  watch(onChange: () => void): () => void {
    this.#watchers.add(onChange);
    return () => this.#watchers.delete(onChange);
  }

  attach(surface: VideoSurface | undefined): void {
    this.#surface = surface;
  }

  /** The stream is open and its length is known. */
  reportLoaded(durationSeconds: number): void {
    this.#duration = durationSeconds > 0 ? durationSeconds : Number.NaN;
    this.#readyState = HAVE_CURRENT_DATA;
  }

  /** The picture moved on. */
  reportProgress(seconds: number): void {
    this.#currentTime = seconds;
    if (this.#paused) return;
    this.#readyState = HAVE_ENOUGH_DATA;
    if (this.#awaitingPicture) {
      this.#awaitingPicture = false;
      this.#emit('playing');
    }
  }

  /** The player ran out of data, or has it again. */
  reportBuffering(buffering: boolean): void {
    if (!buffering) return;
    this.#readyState = HAVE_CURRENT_DATA;
    this.#awaitingPicture = true;
    this.#emit('waiting');
  }

  reportEnded(): void {
    this.#ended = true;
    this.#paused = true;
    this.#emit('ended');
    this.#changed();
  }

  reportError(): void {
    this.#emit('error');
  }

  #emit(type: MediaEvent): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener();
  }

  #changed(): void {
    for (const watcher of [...this.#watchers]) watcher();
  }
}
