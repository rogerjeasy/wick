import { describe, expect, it } from 'vitest';
import {
  MANTEL_EACH_FOR_MS,
  MANTEL_FULL_NOTICE,
  MANTEL_IDLE_AFTER_MS,
  MANTEL_SK_PREFIX,
  MANTEL_URL_TTL_SEC,
  MAX_CARD_ACTIONS,
  MAX_MANTEL,
  MAX_PHOTOS_A_DAY,
  MAX_PHOTO_BYTES,
  PHOTO_ACTIONS,
  PHOTO_SK_PREFIX,
  PHOTO_STATES,
  PHOTO_STATE_TAG,
  isPhotoId,
  looksLikeJpeg,
  photoCardId,
  photoCardWords,
  photoIdOfCardId,
  photoObjectKey,
  photoSeenText,
  readHomeState,
  readMantelItems,
} from '../index.js';

describe('a picture for the mantelpiece', () => {
  it('has an id that is safe in a key, a card id and an object’s name', () => {
    expect(isPhotoId('p_8Jk2-xQ9a')).toBe(true);
    for (const not of ['', 'a/b', '../x', 'a b', 'a#b', 'x'.repeat(65), 7, undefined]) expect(isPhotoId(not)).toBe(false);
  });

  it('names its card by the picture, so the press says which without the television holding anything', () => {
    expect(photoCardId('p_1')).toBe('photo-p_1');
    expect(photoIdOfCardId('photo-p_1')).toBe('p_1');
    for (const not of ['photo-', 'photo-a/b', 'note-p_1', 'photo', 7, undefined]) expect(photoIdOfCardId(not)).toBeUndefined();
  });

  it('is kept under the household it was sent to, and nowhere a request could name', () => {
    expect(photoObjectKey('hh_1', 'p_1')).toBe('photos/hh_1/p_1.jpg');
    expect(PHOTO_SK_PREFIX).toBe('PHOTO#');
    expect(MANTEL_SK_PREFIX).toBe('MANTEL#');
  });

  it('says who it is from in Wick’s own words, and offers two answers that both put it away', () => {
    expect(photoCardWords('Sarah Hughes')).toEqual({
      headline: 'A picture from Sarah.',
      actions: [
        { id: PHOTO_ACTIONS.keep, label: 'Keep it', kind: 'primary' },
        { id: PHOTO_ACTIONS.thanks, label: 'Thank you', kind: 'secondary' },
      ],
    });
    expect(photoCardWords('Sarah').actions.length).toBeLessThanOrEqual(MAX_CARD_ACTIONS);
  });

  it('tells the family one thing whichever she pressed: kept and not kept must look the same', () => {
    expect(photoSeenText('Margaret')).toBe('Margaret has seen your picture.');
    expect(photoSeenText('Margaret')).not.toMatch(/kept|keep|thank/i);
  });

  it('has room for twelve, and says so plainly when it is full', () => {
    expect(MAX_MANTEL).toBe(12);
    expect(MANTEL_FULL_NOTICE).toBe('Your mantelpiece is full. Take one down, then you can keep this.');
  });

  it('marks the object with where it stands, so the bucket can let go of what she did not keep', () => {
    expect(PHOTO_STATE_TAG).toBe('state');
    expect(PHOTO_STATES).toEqual({ sent: 'sent', kept: 'kept', gone: 'gone' });
  });

  it('bounds what a member can send: a small picture, a few a day', () => {
    expect(MAX_PHOTO_BYTES).toBe(1_500_000);
    expect(MAX_PHOTOS_A_DAY).toBe(6);
  });

  it('knows a JPEG by its first bytes and its last, whatever it was called', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    expect(looksLikeJpeg(jpeg)).toBe(true);
    expect(looksLikeJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 0xff, 0xd9]))).toBe(false);
    expect(looksLikeJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBe(false);
    expect(looksLikeJpeg(new Uint8Array([0xff, 0xd8]))).toBe(false);
  });

  it('gives a picture’s address a short life, waits before filling an idle screen, and changes slowly', () => {
    expect(MANTEL_URL_TTL_SEC).toBe(3600);
    expect(MANTEL_IDLE_AFTER_MS).toBe(3 * 60_000);
    expect(MANTEL_EACH_FOR_MS).toBe(20_000);
  });
});

describe('the home screen is told how many things are on the mantelpiece — and nothing of what they are', () => {
  it('carries a count when there is something, through the bus between the edge and the agent plane', () => {
    expect(readHomeState({ light: 'on', mantel: 3 })).toEqual({ light: 'on', mantel: 3 });
  });

  it('says nothing for none, and drops anything that is not a small whole number', () => {
    for (const not of [0, -1, 1.5, 13, '3', null]) expect(readHomeState({ light: 'on', mantel: not })).toEqual({ light: 'on' });
  });
});

describe('what the television is handed when she opens the mantelpiece', () => {
  it('keeps the well-formed things, in order, and no more than the mantelpiece holds', () => {
    const item = { photoId: 'p_1', fromName: 'Sarah', keptAt: 1_700_000_000_000, url: 'https://photos.example/p_1.jpg?sig=x' };
    expect(readMantelItems([item])).toEqual([item]);
    expect(readMantelItems(Array.from({ length: 20 }, (_, i) => ({ ...item, photoId: `p_${i}` })))).toHaveLength(MAX_MANTEL);
  });

  it('drops anything that is not a picture’s id, a name, a time and an https address', () => {
    const item = { photoId: 'p_1', fromName: 'Sarah', keptAt: 1_700_000_000_000, url: 'https://photos.example/p_1.jpg' };
    for (const bad of [
      { ...item, url: 'http://photos.example/p_1.jpg' },
      { ...item, url: 'javascript:alert(1)' },
      { ...item, photoId: 'a/b' },
      { ...item, fromName: '' },
      { ...item, keptAt: 'yesterday' },
      null,
      'p_1',
    ]) {
      expect(readMantelItems([bad])).toEqual([]);
    }
    expect(readMantelItems('nothing')).toEqual([]);
  });
});
