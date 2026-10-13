/**
 * The audio player the Vega app asks for, standing on Android's — for
 * "Read to me" (packages/contracts/src/speech.ts): a card read aloud when
 * she asks.
 *
 * On Vega, `AudioPlayer` (@amazon-devices/react-native-w3cmedia) is an
 * object: make one, `initialize()`, give it `src`, `play()`, and it says
 * `playing`, `ended` or `error`. The shared code makes one for each reading
 * (apps/tv-vega/src/read/speechPlayer.ts) and uses exactly that much of it.
 *
 * Android's player (react-native-video, ExoPlayer underneath) is a
 * component: it plays only while it is on the screen. So there is an unseen
 * view (AudioHost.tsx), put up once beside the app (Root.tsx), and a stage
 * between the two — a player made ready stands on it, the view draws one
 * silent, sizeless `<Video>` for each that has an address, and tells the
 * object what the real player did. This file is the object and the stage.
 *
 * Where the view is not on the screen nothing can be played: the player
 * says so (`available`), which is how the shared code knows not to offer
 * reading at all, and making one ready fails — quietly, on her television.
 *
 * No React and no native module here, so it is tested as plain code. It has
 * not been heard: none of this has run on a device.
 */

/** Vega's names for what is being played, with Vega's own numbers. Android is told neither. */
export enum AudioContentType {
  CONTENT_TYPE_NONE = 0,
  CONTENT_TYPE_SPEECH = 1,
  CONTENT_TYPE_MUSIC = 2,
  CONTENT_TYPE_MOVIE = 3,
  CONTENT_TYPE_SONIFICATION = 4,
}

export enum AudioUsageType {
  USAGE_NONE = 0,
  USAGE_MEDIA = 1,
}

/** Where the players that are ready stand, for the unseen view to draw. */
class AudioStage {
  #views = 0;
  readonly #players = new Set<AudioPlayer>();
  readonly #watchers = new Set<() => void>();

  /** The unseen view has come on the screen. Returns what to call when it leaves. */
  mount(): () => void {
    this.#views += 1;
    let mounted = true;
    return () => {
      if (!mounted) return;
      mounted = false;
      this.#views -= 1;
    };
  }

  /** Whether there is a view to play through. */
  get hosted(): boolean {
    return this.#views > 0;
  }

  players(): AudioPlayer[] {
    return [...this.#players];
  }

  /** Called whenever what the view should draw has changed. */
  watch(onChange: () => void): () => void {
    this.#watchers.add(onChange);
    return () => {
      this.#watchers.delete(onChange);
    };
  }

  add(player: AudioPlayer): void {
    this.#players.add(player);
    this.changed();
  }

  remove(player: AudioPlayer): void {
    if (this.#players.delete(player)) this.changed();
  }

  changed(): void {
    for (const watcher of [...this.#watchers]) watcher();
  }
}

export const audioStage = new AudioStage();

let made = 0;

export class AudioPlayer {
  /** Whether a card can be read aloud here: only while the unseen view is on the screen. */
  static get available(): boolean {
    return audioStage.hosted;
  }

  /** Its own name among the view's children: two readings are two views, never one reused. */
  readonly key: string;
  #src = '';
  #paused = true;
  #volume = 1;
  #onStage = false;
  /** True from `play()` until the view reports sound: that report says "playing". */
  #awaitingSound = false;
  readonly #listeners = new Map<string, Set<() => void>>();

  // What is being played, and why, is something Vega is told and Android is not.
  constructor(_content?: AudioContentType, _usage?: AudioUsageType) {
    made += 1;
    this.key = `reading-${made}`;
  }

  // ---- what the shared code uses, as on Vega -----------------------------

  async initialize(): Promise<void> {
    if (!audioStage.hosted) throw new Error('audio_view_not_on_screen');
    this.#onStage = true;
    audioStage.add(this);
  }

  async deinitialize(): Promise<void> {
    this.#src = '';
    this.#paused = true;
    this.#awaitingSound = false;
    this.#listeners.clear();
    this.#onStage = false;
    audioStage.remove(this);
  }

  get src(): string {
    return this.#src;
  }

  set src(url: string) {
    this.#src = url;
    this.#changed();
  }

  async play(): Promise<void> {
    this.#paused = false;
    this.#awaitingSound = true;
    this.#changed();
  }

  pause(): void {
    if (this.#paused) return;
    this.#paused = true;
    this.#awaitingSound = false;
    this.#changed();
  }

  get paused(): boolean {
    return this.#paused;
  }

  get volume(): number {
    return this.#volume;
  }

  set volume(level: number) {
    this.#volume = Math.max(0, Math.min(1, level));
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

  // ---- what the view uses --------------------------------------------------

  /** The real player is making sound. Said as "playing" once for each `play()`. */
  reportPlaying(): void {
    if (this.#paused || !this.#src || !this.#awaitingSound) return;
    this.#awaitingSound = false;
    this.#emit('playing');
  }

  reportEnded(): void {
    if (!this.#onStage) return;
    this.#paused = true;
    this.#awaitingSound = false;
    this.#emit('ended');
    this.#changed();
  }

  reportError(): void {
    this.#emit('error');
  }

  #emit(type: 'playing' | 'ended' | 'error'): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener();
  }

  #changed(): void {
    if (this.#onStage) audioStage.changed();
  }
}
