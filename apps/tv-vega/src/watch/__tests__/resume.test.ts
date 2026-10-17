import { describe, expect, it } from 'vitest';
import { FilmPositions, RESUME_AFTER_MS, keptPosition } from '../resume.js';

const MIN = 60_000;
const FILM = { durationMs: 10 * MIN, creditsPositionMs: 9 * MIN };

describe('where she stopped a film, so it goes on from there', () => {
  it('keeps a place in the middle of the film', () => {
    expect(keptPosition(4 * MIN, FILM.durationMs, FILM.creditsPositionMs)).toBe(4 * MIN);
  });

  it('does not keep the first minute: starting again is no loss', () => {
    expect(keptPosition(RESUME_AFTER_MS - 1, FILM.durationMs, FILM.creditsPositionMs)).toBeUndefined();
  });

  it('forgets a film she watched to the credits, or to its last two minutes when it has none', () => {
    expect(keptPosition(9 * MIN, FILM.durationMs, FILM.creditsPositionMs)).toBeUndefined();
    expect(keptPosition(8.5 * MIN, FILM.durationMs, undefined)).toBeUndefined();
    expect(keptPosition(7 * MIN, FILM.durationMs, undefined)).toBe(7 * MIN);
  });

  it('keeps nothing it cannot read', () => {
    expect(keptPosition(Number.NaN, FILM.durationMs, undefined)).toBeUndefined();
    expect(keptPosition(4 * MIN, 0, undefined)).toBe(4 * MIN);
  });
});

describe('FilmPositions', () => {
  it('goes on from where each film was stopped, and from the start once it was finished', () => {
    const positions = new FilmPositions();
    positions.stopped('bbb', 4 * MIN, FILM.durationMs, FILM.creditsPositionMs);
    positions.stopped('sintel', 2 * MIN, FILM.durationMs, FILM.creditsPositionMs);
    expect(positions.startAt('bbb')).toBe(4 * MIN);
    expect(positions.startAt('sintel')).toBe(2 * MIN);
    expect(positions.startAt('tears')).toBe(0);

    positions.stopped('bbb', 9.5 * MIN, FILM.durationMs, FILM.creditsPositionMs);
    expect(positions.startAt('bbb')).toBe(0);
  });

  it('is kept where the television can keep it, and survives a store that refuses', () => {
    let kept = '';
    const store = { read: () => kept, write: (text: string) => void (kept = text) };
    new FilmPositions(store).stopped('bbb', 4 * MIN, FILM.durationMs, FILM.creditsPositionMs);
    expect(new FilmPositions(store).startAt('bbb')).toBe(4 * MIN);

    const refusing = { read: () => { throw new Error('no'); }, write: () => { throw new Error('no'); } };
    const positions = new FilmPositions(refusing);
    positions.stopped('bbb', 4 * MIN, FILM.durationMs, FILM.creditsPositionMs);
    expect(positions.startAt('bbb')).toBe(4 * MIN);
    expect(new FilmPositions({ read: () => '{not json', write: () => {} }).startAt('bbb')).toBe(0);
  });
});
