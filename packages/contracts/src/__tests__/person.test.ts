import { describe, expect, it } from 'vitest';
import { personIdFor } from '../person.js';

describe('personIdFor', () => {
  it('is the name as a slug for a name in the letters a–z, as it always was', () => {
    expect(personIdFor('Maria')).toBe('maria');
    expect(personIdFor("Mary-Jo O'Neil")).toBe('mary-jo-o-neil');
    expect(personIdFor('  Anna   Cash ')).toBe('anna-cash');
  });

  it('takes accents off, as the Guardian does', () => {
    expect(personIdFor('José Álvarez')).toBe('jose-alvarez');
  });

  it('keeps the id a Latin letter the slug cannot hold has always had', () => {
    expect(personIdFor('Søren')).toBe('s-ren');
    expect(personIdFor('Łukasz')).toBe('ukasz');
  });

  it('makes an id for a name with no letters a–z at all, and never an empty one', () => {
    for (const name of ['Мария', 'Μαρία', '玛丽亚', 'ماريا', 'מרים', 'मारिया', '마리아', 'マリア']) {
      const id = personIdFor(name);
      expect(id).toMatch(/^u-[0-9a-f]{16}$/);
    }
  });

  it('is the same id for the same name, however it is spaced or cased', () => {
    expect(personIdFor('Мария')).toBe(personIdFor('  мария '));
    expect(personIdFor('Мария Иванова')).toBe(personIdFor('Мария   Иванова'));
  });

  it('tells different names apart', () => {
    const ids = ['Мария', 'Анна', 'Мария Иванова', 'Мария Петрова', 'Μαρία', '玛丽亚', '玛丽'].map(personIdFor);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the Latin part of a mixed name in view, with the whole name behind it', () => {
    const id = personIdFor('Анна Smith');
    expect(id).toMatch(/^smith-u-[0-9a-f]{16}$/);
    expect(id).not.toBe(personIdFor('Мария Smith'));
    expect(id).not.toBe(personIdFor('Smith'));
  });

  it('makes ids that are safe in a key: letters, digits and hyphens', () => {
    for (const name of ['Мария', 'Анна Smith', "Мария-Ивановна O'Neil", '玛丽亚 Cash']) {
      expect(personIdFor(name)).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
