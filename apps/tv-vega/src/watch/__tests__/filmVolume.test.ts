import { describe, expect, it } from 'vitest';
import { FILM_VOLUME_WHILE_READING, lowerFilm } from '../filmVolume.js';

const player = (volume: number) => ({ volume });

describe('lowerFilm — the film under a card that is being read aloud', () => {
  it('is turned down to about a third while the card is read', () => {
    const film = player(1);

    lowerFilm(film);

    expect(FILM_VOLUME_WHILE_READING).toBe(0.3);
    expect(film.volume).toBe(0.3);
  });

  it('is put back exactly as it was', () => {
    for (const before of [1, 0.8, 0.55, 0.31]) {
      const film = player(before);
      const restore = lowerFilm(film);

      restore();

      expect(film.volume).toBe(before);
    }
  });

  it('is never turned up: a film already quieter than that is left alone, and put back to the same', () => {
    for (const before of [0.3, 0.2, 0]) {
      const film = player(before);
      const restore = lowerFilm(film);
      expect(film.volume).toBe(before);

      restore();
      expect(film.volume).toBe(before);
    }
  });

  it('puts it back once: a second call changes nothing, even if the volume has been changed since', () => {
    const film = player(1);
    const restore = lowerFilm(film);
    restore();
    film.volume = 0.6;

    restore();

    expect(film.volume).toBe(0.6);
  });

  it('does nothing when there is no film', () => {
    expect(() => lowerFilm(null)()).not.toThrow();
    expect(() => lowerFilm(undefined)()).not.toThrow();
  });

  it('leaves a film alone that is no longer the one on screen: its player has been let go', () => {
    const film = player(1);
    let onScreen = true;
    const restore = lowerFilm(film, () => onScreen);
    onScreen = false;

    restore();

    expect(film.volume).toBe(0.3);
  });

  it('does not fail when the player will not take a volume — a player already torn down', () => {
    const dead = {
      get volume(): number {
        return 1;
      },
      set volume(_level: number) {
        throw new Error('player_deinitialized');
      },
    };

    expect(() => lowerFilm(dead)()).not.toThrow();
  });
});
