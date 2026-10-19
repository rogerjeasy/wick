/**
 * The id a person is filed under, made from their name, and what counts as
 * a name written in another script.
 *
 * "Maria" is "maria"; "Mary-Jo O'Neil" is "mary-jo-o-neil" (the roster's key,
 * `PER#<id>`). A name in another script has no letters a–z to make an id
 * from: "Мария" came out as "", which the roster refuses, so a household
 * whose carer is written in Cyrillic could not add her. Now a name with
 * letters of another script gets, after whatever a–z slug it has, a short
 * fingerprint of the whole name: "Мария" is "u-" and sixteen hex digits,
 * "Анна Cash" is "cash-u-…" — never plain "cash", which would also be
 * "Мария Cash". The same name is always the same id, and two names that
 * differ are not.
 *
 * Pure and dependency-free: the television and the Lambdas read this file as
 * well as the servers, so no `node:crypto`. The fingerprint is for telling
 * names apart, not for keeping anything secret.
 */

/** The letters of a name, folded as the Guardian folds text: compatibility forms, no accents, lower case. */
function folded(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** 64 bits of two FNV-1a runs, as 16 hex digits. */
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9747b28c;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** "Maria" -> "maria"; "Mary-Jo O'Neil" -> "mary-jo-o-neil"; "Мария" -> "u-" and a fingerprint. */
export function personIdFor(name: string): string {
  const plain = folded(name);
  const slug = plain.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // A letter of another script (Cyrillic, Greek, Han…) that the slug dropped: this name is not only what
  // the slug says. A Latin letter the slug cannot hold (ø, ł, ß) keeps the id it has always had: a roster
  // already holds those, and finding "Søren" again must find his entry, not file a second one.
  const hasOtherLetters = /(?!\p{Script=Latin})\p{L}/u.test(plain);
  if (!hasOtherLetters) return slug;
  const print = `u-${fingerprint(plain.normalize('NFC').replace(/\s+/g, ' ').trim())}`;
  return slug ? `${slug}-${print}` : print;
}
