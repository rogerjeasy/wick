/**
 * The screen reader is told of each card once. Read to me (reading.ts) is
 * Wick's voice, and speaks only when she presses Play; this is the
 * platform's own reader, VoiceView, which she turned on herself.
 *
 * When VoiceView is on, a card that comes on screen is announced — what it
 * says and what she can press, the same words Play would read
 * (packages/contracts speech.ts speechTextOf) — once for each time it
 * comes on screen. The same card drawn again at the next look is not
 * announced again; a card that left and came back is. A card already on
 * screen when the reader is turned on is announced then. Nothing is said
 * while the reader is off: the reader is the platform's, and this only
 * hands it a sentence.
 *
 * Pure, and imports nothing of the platform.
 */

export interface Announcer {
  /**
   * What is on screen now, by name — a card's id — or null for nothing, and
   * whether the screen reader is on. True when it is to be announced now.
   */
  shown(what: string | null, screenReader: boolean): boolean;
}

export function announcer(): Announcer {
  let showing: string | null = null;
  let announced = false;
  return {
    shown(what, screenReader) {
      if (what !== showing) {
        showing = what;
        announced = false;
      }
      if (what === null || !screenReader || announced) return false;
      announced = true;
      return true;
    },
  };
}
