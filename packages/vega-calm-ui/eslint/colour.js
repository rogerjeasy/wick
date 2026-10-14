// @ts-check
/**
 * Colour parsing for the `no-alarm-colour` rule.
 *
 * The hue arithmetic is the same as `alarmHue` in src/constraints.ts, which
 * the components use at render time. It is repeated here so the ESLint
 * plugin runs in plain Node with nothing compiled; a test holds the two to
 * the same answer on every colour of a 4096-colour sweep.
 */

/**
 * The hue of an sRGB colour in degrees if it is a saturated red, else null.
 * @param {number} r 0-255
 * @param {number} g 0-255
 * @param {number} b 0-255
 * @returns {number | null}
 */
export function alarmHueOfRgb(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null; // grey

  let hue;
  if (max === r) hue = (60 * ((g - b) / (max - min)) + 360) % 360;
  else if (max === g) hue = 60 * ((b - r) / (max - min)) + 120;
  else hue = 60 * ((r - g) / (max - min)) + 240;

  const saturated = (max - min) / max > 0.35;
  const isRed = hue >= 345 || hue <= 12;
  return saturated && isRed ? hue : null;
}

/**
 * CSS / React Native named colours that are reds or near-reds, by their hex
 * value. Only these are worth knowing by name: every other named colour is
 * either not red or not something anyone types into a TV style. Each still
 * goes through the hue check, so a name here is reported only if its value
 * really is a saturated red.
 * @type {Readonly<Record<string, string>>}
 */
const NAMED = {
  red: '#ff0000',
  darkred: '#8b0000',
  maroon: '#800000',
  crimson: '#dc143c',
  firebrick: '#b22222',
  indianred: '#cd5c5c',
  tomato: '#ff6347',
  salmon: '#fa8072',
  lightcoral: '#f08080',
  orangered: '#ff4500',
  coral: '#ff7f50',
};

/**
 * A colour written as `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(...)` or
 * `rgba(...)`, as its three channels. Null for anything else.
 * @param {string} text
 * @returns {[number, number, number] | null}
 */
export function parseColour(text) {
  const s = text.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    const digits = /** @type {string} */ (hex[1]);
    const full = digits.length <= 4 ? [...digits].map((d) => d + d).join('') : digits;
    const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    return /** @type {[number, number, number]} */ (channels);
  }

  const fn = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(s);
  if (fn) {
    const channels = [fn[1], fn[2], fn[3]].map((c) => Math.min(255, Number(c)));
    return /** @type {[number, number, number]} */ (channels);
  }

  return null;
}

/**
 * The colour a named-colour keyword stands for, if it is one this module knows.
 * @param {string} text
 * @returns {[number, number, number] | null}
 */
export function parseNamedColour(text) {
  const value = NAMED[text.trim().toLowerCase()];
  return value ? parseColour(value) : null;
}
