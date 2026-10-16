/**
 * Her film's media session on Fire OS — the JavaScript side of the Android
 * module that holds it (android/app/src/main/java/com/wick/tv/media/FilmSessionModule.kt).
 *
 * Nothing here decides anything: what the session is told, and what a
 * command does, is media/filmSession.ts and the shared rules behind it.
 */
import { NativeEventEmitter, NativeModules } from 'react-native';
import type { FilmSessionNative, NativeCommand, NativeFilm } from './filmSession';

/** The event the module sends for each command (FilmSessionModule.EVENT). */
const FILM_COMMAND = 'WickFilmCommand';

interface WickFilmSessionModule {
  publish(film: NativeFilm): Promise<void>;
  release(): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const filmModule: WickFilmSessionModule | undefined = (NativeModules as { WickFilmSession?: WickFilmSessionModule }).WickFilmSession;

/** Absent only in a build without the module; the film then obeys the remote's keys alone. */
export const nativeFilmSession: FilmSessionNative | undefined = filmModule
  ? {
      publish: (film) => filmModule.publish(film),
      release: () => filmModule.release(),
      onCommand(listener) {
        const subscription = new NativeEventEmitter(filmModule).addListener(FILM_COMMAND, (event) => listener(event as NativeCommand));
        return () => subscription.remove();
      },
    }
  : undefined;
