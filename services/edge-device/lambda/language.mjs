/**
 * The television speaks her language, the edge's half
 * (packages/contracts/src/language.ts).
 *
 * Three things happen here.
 *
 * Her answer. The organiser can ask for another language; nothing changes
 * until she answers the question on her own television. The television
 * sends only which card and which button, and the card's id names the
 * language (`language-<language>`) — so, as with the Circle card, the
 * update is conditional: only the question still open, and only about that
 * same language, can be answered. A television cannot choose a language it
 * was not asked about, or answer twice. English is the absence of a
 * language on the household's row, so going back to it takes the attribute
 * away. "No" leaves the language as it was and closes the question — and
 * is kept, because her no is an answer too: which language she said no to,
 * and when, in the same write. The Wick server reads that and does not let
 * the same language be asked for again for a week (contracts
 * LANGUAGE_ASK_AGAIN_AFTER_MS); the edge only records it. A yes takes an
 * earlier no off the record.
 *
 * What the edge itself sends. A reply to the television that just spoke
 * (INV-2's accepted exception) — the cards it is owed, the Light card, a
 * page of "What Sarah sees", the home screen's line — is put into her
 * language once, where the two send functions are handed in
 * (`inHerLanguage`), so no send site can forget. Wick's own sentences come
 * from the phrasebook (phrasebook.generated.mjs, a copy of
 * packages/contracts/src/phrasebook). Free text — a note, the door's
 * description, the week's paragraph — is in her language only where the
 * agent plane already translated it and kept it beside the stored card
 * (`tr_<language>`, services/agent egress.ts).
 *
 * And what it never does: the edge never asks a translator, and never
 * writes a translated word anywhere. A stored card is the English it was
 * written in — which is what a note's reply is copied from, and what every
 * family tool reads.
 *
 * This plain .mjs Lambda can't import TS; the names below are inlined from
 * packages/contracts/src/language.ts, and language.test.ts holds them to it.
 *
 * Pure: device-event.mjs owns the DynamoDB client.
 */

export const LANGUAGES = ['en', 'es'];
export const DEFAULT_LANGUAGE = 'en';
/** The attributes on the household's META row. `language` is absent for English. */
export const HOUSEHOLD_LANGUAGE_ATTRS = {
  language: 'language',
  asked: 'languageAsked',
  askedBy: 'languageAskedBy',
  askedAt: 'languageAskedAt',
  declined: 'languageDeclined',
  declinedAt: 'languageDeclinedAt',
  // Written by the Wick server when the organiser takes a question back; named here only so the copy stays whole.
  takenBack: 'languageTakenBack',
  takenBackAt: 'languageTakenBackAt',
};
export const LANGUAGE_ACTIONS = { yes: 'yes', no: 'no' };

const CARD_PREFIX = 'language-';
const META_SK = 'META';
const FREE_FIELDS = ['transcript', 'description', 'text'];

const isLanguage = (value) => typeof value === 'string' && LANGUAGES.includes(value);

/** Which language a question's card asks about (contracts languageOfCardId). */
export function languageOfCardId(cardId) {
  if (typeof cardId !== 'string' || !cardId.startsWith(CARD_PREFIX)) return undefined;
  const language = cardId.slice(CARD_PREFIX.length);
  return isLanguage(language) ? language : undefined;
}

/** The household's language, from its own row: English unless the row names another. */
export function languageOfMeta(item) {
  const language = item?.[HOUSEHOLD_LANGUAGE_ATTRS.language]?.S;
  return isLanguage(language) ? language : DEFAULT_LANGUAGE;
}

/** The same, from the rows the home screen is read from (light.mjs homeRange), which end at that row. */
export function languageOfRows(items) {
  return languageOfMeta((items ?? []).find((item) => item.sk?.S === META_SK));
}

/**
 * GetItem input for the language alone, when no other read has already
 * brought the row. A consistent read, always: her television asks for its
 * cards again the moment its language changes, and this is the read that
 * answers — it must say what she has just chosen, not what a replica last
 * heard.
 */
export function languageRead({ table, householdId }) {
  return {
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: META_SK } },
    // `language` is a word DynamoDB keeps for itself.
    ProjectionExpression: '#language',
    ExpressionAttributeNames: { '#language': HOUSEHOLD_LANGUAGE_ATTRS.language },
    ConsistentRead: true,
  };
}

/** Her press on the question's card: which language, and yes or no — or undefined for any other card or press. */
export function languagePress(cardId, action) {
  const language = languageOfCardId(cardId);
  if (!language) return undefined;
  if (action !== LANGUAGE_ACTIONS.yes && action !== LANGUAGE_ACTIONS.no) return undefined;
  return { language, answer: action };
}

/**
 * UpdateItem input recording her answer on the household's row — one
 * conditional write, so nothing of an answer is ever on record for a
 * question that was not open. An update, never a delete: the row is the
 * household's own, and the edge's roles hold no DeleteItem.
 *
 *   yes  the language is set (taken away, for English), the question is
 *        closed, and an earlier no is taken off the record;
 *   no   the language is left as it was, the question is closed, and the
 *        no is kept: which language, and when (`at`, this server's clock).
 */
export function languageAnswerUpdate({ table, householdId, language, answer, at }) {
  if (!isLanguage(language)) throw new Error(`${language} is not a language Wick speaks`);
  if (answer !== LANGUAGE_ACTIONS.yes && answer !== LANGUAGE_ACTIONS.no) throw new Error(`${answer} is not an answer`);

  const question = { '#asked': HOUSEHOLD_LANGUAGE_ATTRS.asked, '#askedBy': HOUSEHOLD_LANGUAGE_ATTRS.askedBy, '#askedAt': HOUSEHOLD_LANGUAGE_ATTRS.askedAt };
  const said = { '#declined': HOUSEHOLD_LANGUAGE_ATTRS.declined, '#declinedAt': HOUSEHOLD_LANGUAGE_ATTRS.declinedAt };
  const target = {
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: META_SK } },
    // Only the question still open, and only about this language.
    ConditionExpression: '#asked = :language',
  };

  if (answer === LANGUAGE_ACTIONS.no) {
    if (typeof at !== 'number' || !Number.isFinite(at)) throw new Error('her no needs the moment it was given');
    return {
      ...target,
      UpdateExpression: 'SET #declined = :language, #declinedAt = :at REMOVE #asked, #askedBy, #askedAt',
      ExpressionAttributeNames: { ...question, ...said },
      ExpressionAttributeValues: { ':language': { S: language }, ':at': { N: String(at) } },
    };
  }

  const cleared = 'REMOVE #asked, #askedBy, #askedAt, #declined, #declinedAt';
  return {
    ...target,
    UpdateExpression: language === DEFAULT_LANGUAGE ? cleared.replace('REMOVE ', 'REMOVE #language, ') : `SET #language = :language ${cleared}`,
    ExpressionAttributeNames: { '#language': HOUSEHOLD_LANGUAGE_ATTRS.language, ...question, ...said },
    ExpressionAttributeValues: { ':language': { S: language } },
  };
}

/** Where the agent plane keeps a stored card's free text in her language (services/agent egress.ts translationAttribute). */
export const translationAttribute = (language) => `tr_${language}`;

/**
 * A stored card's free text in her language, by field — or undefined when
 * the row holds none. Read, never made: the edge does not translate.
 */
export function freeOfRow(item, language) {
  const raw = item?.[translationAttribute(language)]?.S;
  if (typeof raw !== 'string') return undefined;
  let kept;
  try {
    kept = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof kept !== 'object' || kept === null) return undefined;
  const free = Object.fromEntries(FREE_FIELDS.filter((field) => typeof kept[field] === 'string' && kept[field].trim().length > 0).map((field) => [field, kept[field]]));
  return Object.keys(free).length > 0 ? free : undefined;
}

/**
 * The two ways the edge answers a television, with her language put in.
 *
 * Wrapped once per event (device-event.mjs), so every card and every
 * control message goes through here whichever part of the code sends it. An
 * English household is handed on exactly what was handed in — the same
 * object, untouched.
 *
 * The language is found with as little reading as can be:
 *   - a home message carries it (light.mjs homeState, from the household's
 *     row read a moment before), so none is needed for it;
 *   - a caller that has just read the home's rows hands them over
 *     (`{ rows }`);
 *   - otherwise it is read once, the first time a card is sent, and kept
 *     for the rest of the event. An event that sends nothing reads nothing.
 *
 * A stored card comes with its row (`{ row }`): the free text the agent
 * plane translated is taken from beside it. A card built on the spot has
 * none.
 *
 * And nothing here can cost her a card: a language that cannot be read, or
 * a phrasebook that fails, sends the English.
 *
 * It is also the one place a picture's card is given its address
 * (packages/contracts mantel.ts): minted now, for the television being
 * answered, by `pictureAddress` — after the phrasebook has had the card, in
 * every language, English included. An address that arrived with the card
 * is never passed on; a card no address can be minted for goes without one.
 * Nothing here stores anything, so the address is in no row.
 *
 * @param {object} input
 * @param {(card: object) => Promise<boolean>} input.sendCard
 * @param {(control: object) => Promise<boolean>} input.sendControl
 * @param {() => Promise<string>} input.readLanguage  the household's language, from its row
 * @param {{ cardIn: Function, patchIn: Function, homeIn: Function }} input.phrasebook
 * @param {(photoId: string) => string | undefined} [input.pictureAddress]  a short-lived address for one of this household's pictures (mantel.mjs)
 */
export function inHerLanguage({ sendCard, sendControl, readLanguage, phrasebook, pictureAddress, log = (line) => console.error(JSON.stringify(line)) }) {
  /** What this event knows of the household's language; nothing until it has to. */
  let known;

  const learn = (language) => {
    known = Promise.resolve(isLanguage(language) ? language : DEFAULT_LANGUAGE);
  };
  const language = () => {
    known ??= Promise.resolve()
      .then(readLanguage)
      .then(
        (read) => (isLanguage(read) ? read : DEFAULT_LANGUAGE),
        (err) => {
          log({ level: 'error', msg: 'household_language_unread', reason: err?.name });
          return DEFAULT_LANGUAGE;
        },
      );
    return known;
  };
  /** In her language, or — should the phrasebook fail — as it was. */
  const said = (original, translate) => {
    try {
      return translate();
    } catch (err) {
      log({ level: 'error', msg: 'phrasebook_failed', reason: err?.name });
      return original;
    }
  };

  /** A picture's card with an address minted for this sending; every other card exactly as it is. */
  const framed = (queued) => {
    const card = queued?.card;
    if (card?.type !== 'PHOTO') return queued;
    let photoUrl;
    try {
      photoUrl = pictureAddress?.(card.photoId);
    } catch (err) {
      // Why, and never which picture.
      log({ level: 'error', msg: 'picture_address_failed', reason: err?.name });
    }
    const minted = typeof photoUrl === 'string' && photoUrl.length > 0;
    // Nothing to add and nothing to take away: the card as it was handed in.
    if (!minted && !('photoUrl' in card)) return queued;
    const words = Object.fromEntries(Object.entries(card).filter(([name]) => name !== 'photoUrl'));
    return { ...queued, card: minted ? { ...words, photoUrl } : words };
  };

  /** The card in her language: the stored English as it is, or put through the phrasebook with the free text kept beside it. */
  const worded = async (queued, from) => {
    if (from.rows) learn(languageOfRows(from.rows));
    const spoken = await language();
    if (spoken === DEFAULT_LANGUAGE) return queued;
    return said(queued, () => ({ ...queued, card: phrasebook.cardIn(spoken, queued.card, freeOfRow(from.row, spoken)) }));
  };

  return {
    async sendCard(queued, from = {}) {
      return sendCard(framed(await worded(queued, from)));
    },

    /**
     * The card as her television shows it, without sending it: the very
     * words `sendCard` would send. For "Read to me" (speech.mjs), which
     * reads what is on her screen — so it is made here, by the same step,
     * and cannot come to differ. No picture's address: a reading has no use
     * for one.
     */
    cardAsShown: (queued, from = {}) => worded(queued, from),

    /** The household's language, as this event knows it (read once, at most). */
    language,

    async sendControl(control) {
      if (control?.t === 'home') {
        const named = control.home?.language;
        // A home told whole says everything: no language named means English, from here on.
        if (control.whole || isLanguage(named)) learn(named);
        const spoken = await language();
        if (spoken === DEFAULT_LANGUAGE) return sendControl(control);
        return sendControl(said(control, () => ({ ...control, home: phrasebook.homeIn(spoken, control.home) })));
      }
      if (control?.t === 'patch') {
        const spoken = await language();
        if (spoken === DEFAULT_LANGUAGE) return sendControl(control);
        return sendControl(said(control, () => ({ ...control, patch: phrasebook.patchIn(spoken, control.patch) })));
      }
      // A revoke carries no words.
      return sendControl(control);
    },
  };
}
