/**
 * Everything Wick itself says to the resident, in Spanish.
 *
 * Written by hand, one whole sentence at a time, against the English each
 * builder writes — the builder is named above its sentences, and a coverage
 * test beside each set of builders runs them and fails if one of their
 * sentences is not here (phrasebookCoverage.test.ts).
 *
 * How it is written:
 *
 *   - Plain, warm, neutral Spanish. She is "usted", always. The only "tú"
 *     is her own voice, in a reply she can send her family.
 *   - A name's gender is not known, so no sentence needs one: "Sarah ya
 *     puede ver la película con usted", never "Sarah está lista".
 *   - What she consents by says exactly what the English says, no more and
 *     no less: the Circle card (AGENTS.md INV-9), "Shall I tell Sarah?"
 *     (INV-10), "Start the film" and what it shares, the light, "What Sarah
 *     sees", the visit, and that Wick calls nobody.
 *   - A button stays a button: about as long as the English, and never
 *     much past twenty-six characters (phrasebook.test.ts).
 *   - "Wick" and a film's title are never translated.
 *
 * In the English, `{first}` is a first name (or "the family", "your
 * family", "Someone"), `{name}` a name of several words, `{names}` a list
 * of first names, `{day}` a weekday, `{time}` a clock time, `{part}` "this
 * morning", `{parts}` "mornings", `{date}` "Sunday 18 October", `{n}` a
 * count, `{title}` a film (engine.ts). In the Spanish, `{key}` puts the
 * value where it goes; `{key|cap}` is a person or a title at the start of a
 * sentence ("Su familia", where a name is left as it is); `{day|pl}` is
 * "los sábados"; `{time|las}` is "las 9:02" or "la 1:05"; and
 * `{names?ha:han}` goes by how many there are.
 */
import { compile, type Entry, type Lexicon, type Slot } from './engine.js';

/** A sentence, and optionally a shorter way of saying it for when the long way would not fit the card. */
const s = (en: string, to: string, short?: string): Entry => (short === undefined ? { en, to } : { en, to, short });
/** A button's label. */
const b = (en: string, to: string): Entry => ({ en, to, button: true });

const NOBODY_YET = 'Todavía no ha respondido nadie.';
const EVERYONE_ASKED = 'Wick ya se lo ha pedido a todos los que puede, y todavía pueden responder.';

/** By the builder that writes the English. A sentence several builders write is under `shared`. */
export const ES_CATALOGUE: Readonly<Record<string, readonly Entry[]>> = {
  shared: [
    b('Not now', 'Ahora no'),
    b('All right', 'De acuerdo'),
    b('OK', 'Entendido'),
    // The door card's notice (agent askFamily.ts) and the Reach card's headline (contracts reach.ts, edge reach.mjs).
    s('There is nobody Wick can ask just now.', 'Ahora mismo no hay nadie a quien Wick pueda pedírselo.'),
    // The home screen and the Light card (contracts light.ts lookedInWords, edge light.mjs, mcp-server lookIn.ts).
    s('{first} looked in {part}.', '{first|cap} ha preguntado por usted {part}.'),
  ],

  // What a family member answers about the door, shown as "<name> says: …" (mcp-server answer_door_request.ts).
  'packages/contracts/src/door.ts': [
    s("{first} says: It's all right, I know who that is.", '{first|cap} dice: Está bien, sé quién es.'),
    s("{first} says: Please don't open the door. I'll ring you now.", '{first|cap} dice: Por favor, no abra la puerta. Ahora mismo llamo por teléfono.'),
    s("{first} says: I can't tell who that is. I'll ring you now.", '{first|cap} dice: No distingo quién es. Ahora mismo llamo por teléfono.'),
  ],

  // Hold for Sarah: the offer and every state of the request (also edge reach.mjs, word for word).
  'packages/contracts/src/reach.ts': [
    s('Ask {first} to ring you?', '¿Pedir a {first} que le llame?'),
    s('{first} will be told only that you would like a call.', 'A {first} solo se le dirá que usted desea una llamada.'),
    // Wick places no call and names no service (AGENTS.md, "A request to be rung").
    s('Wick does not call for help: in an emergency, use the telephone.', 'Wick no llama para pedir ayuda: en una emergencia, use el teléfono.'),
    b('Yes, ask {first}', 'Sí, pedírselo a {first}'),
    b('Just say hello', 'Solo saludar'),
    b('No, not now', 'No, ahora no'),
    s('When you have allowed someone in your family circle, you can ask them here to ring you.', 'Cuando haya aceptado a alguien en su círculo familiar, podrá pedirle aquí que le llame.'),
    b('Thank you', 'Gracias'),
    s('{first} says: I’m ringing you now.', '{first|cap} dice: Ya estoy llamando por teléfono.'),
    s('{first} says: I’ll ring you within the hour.', '{first|cap} dice: Llamaré por teléfono en menos de una hora.'),
    s('{first} says: Hello to you too.', '{first|cap} dice: Hola, igualmente.'),
    s('{first} has been told you said hello.', 'Se le ha dicho a {first} que usted manda saludos.'),
    s('Nobody has answered yet.', NOBODY_YET),
    s('{names} has been asked, and can still answer.', 'Ya se le ha pedido a {names}, y todavía puede responder.', EVERYONE_ASKED),
    s('{names} have been asked, and can still answer.', 'Ya se les ha pedido a {names}, y todavía pueden responder.', EVERYONE_ASKED),
    s('Everyone Wick can ask has been asked, and can still answer.', EVERYONE_ASKED),
    s('Wick will tell you here if {first} does.', 'Wick se lo dirá aquí si {first} responde.'),
    s('Wick will tell you here if one of them does.', 'Wick se lo dirá aquí si alguien responde.'),
    s('{first} has been asked to ring you.', 'Se ha pedido a {first} que le llame.'),
    s('If {first} has not answered in three minutes, Wick will ask {first2}.', 'Si {first} no ha respondido en tres minutos, Wick se lo pedirá a {first2}.'),
    s('Wick will tell you here when {first} answers.', 'Wick se lo dirá aquí cuando {first} responda.'),
    s('{first} has been asked to ring you as well.', 'También se ha pedido a {first} que le llame.'),
    s('{names} has not answered yet.', '{names|cap} todavía no ha respondido.', NOBODY_YET),
    s('{names} have not answered yet.', '{names|cap} todavía no han respondido.', NOBODY_YET),
    s('If nobody has answered in three minutes, Wick will ask {first}.', 'Si nadie ha respondido en tres minutos, Wick se lo pedirá a {first}.'),
    s('Wick will tell you here when somebody answers.', 'Wick se lo dirá aquí cuando alguien responda.'),
    s('Nobody asked before {first} has answered yet.', 'De las personas a quienes se pidió antes que a {first}, ninguna ha respondido todavía.'),
  ],

  // The visit, witnessed: the door's reading, put to her — and the sentence the family would be told if she disputes it.
  'packages/contracts/src/visit.ts': [
    s('Is this right?', '¿Es correcto?'),
    s('{name} was here on {day} from {time} to {time2}.', '{name|cap} estuvo aquí el {day} de {time} a {time2}.'),
    s('{name} came on {day} at {time}.', '{name|cap} vino el {day} a {time|las}.'),
    b('Yes, that’s right', 'Sí, es correcto'),
    b('No, that’s not right', 'No, no es correcto'),
    s('Wick noted that {name} was here on {day} from {time} to {time2}.', 'Wick anotó que {name} estuvo aquí el {day} de {time} a {time2}.'),
    s('Wick noted that {name} came on {day} at {time}.', 'Wick anotó que {name} vino el {day} a {time|las}.'),
    s('That is not right.', 'Eso no es correcto.'),
  ],

  // The question at the credits and its three answers: her buttons (edge watch-together.mjs), and what the family member chose (mcp-server answer_watch_together.ts).
  'packages/contracts/src/watch.ts': [
    s('What did you think of it?', '¿Qué le pareció?'),
    b('I loved it.', 'Me encantó.'),
    b('It was all right.', 'Estuvo bien.'),
    b('Not really for me.', 'No fue muy de mi gusto.'),
    s('{first} says: “I loved it.”', '{first|cap} dice: “Me encantó.”'),
    s('{first} says: “It was all right.”', '{first|cap} dice: “Estuvo bien.”'),
    s('{first} says: “Not really for me.”', '{first|cap} dice: “No fue muy de mi gusto.”'),
  ],

  'services/agent/src/agents/door/index.ts': [
    s("Someone's at the front door.", 'Hay alguien en la puerta de entrada.'),
    s('Movement at the front door.', 'Movimiento en la puerta de entrada.'),
    s('The doorbell rang.', 'Ha sonado el timbre.'),
    b('Watch live', 'Ver en vivo'),
    // The press is the consent: the picture goes to the people she allows, for this one card (askFamily.ts).
    b('Ask {first} to look', 'Pedir a {first} que mire'),
    b('Ring the hallway chime', 'Tocar timbre del pasillo'),
  ],

  'services/agent/src/agents/door/actions.ts': [
    s('The hallway chime rang.', 'Ha sonado el timbre del pasillo.'),
    s('The hallway chime is snoozed, so it stayed quiet.', 'El timbre del pasillo está silenciado, así que no ha sonado.'),
    s("The hallway chime didn't answer.", 'El timbre del pasillo no ha respondido.'),
    s('The hallway chime has no sound set up for Wick.', 'El timbre del pasillo no tiene ningún sonido configurado para Wick.'),
    s("There's no hallway chime Wick can reach.", 'No hay ningún timbre del pasillo al que Wick tenga acceso.'),
  ],

  'services/agent/src/agents/door/askFamily.ts': [
    s('{first} has been asked to look.', 'Se ha pedido a {first} que mire.'),
  ],

  // "Shall I tell Sarah?" (INV-10): the question and its two buttons. The sentence itself is below.
  'services/agent/src/agents/tell/ask.ts': [
    s('Shall I tell {first}?', '¿Se lo digo a {first}?'),
    b('Tell {first}', 'Decírselo a {first}'),
    b('Keep it to myself', 'Me lo guardo'),
  ],

  // The very sentence that would be told: every lasting wording the detector can write.
  'services/agent/src/rhythm/different.ts': [
    s('{name} usually comes on {day} {parts}.', '{name|cap} suele venir los {day|pl} {parts}.'),
    s('There was no visit on {day}.', 'El {day} no hubo visita.'),
    s('Someone came to the door in the night, at {time} on {day}.', 'Alguien vino a la puerta por la noche, el {day} a {time|las}.'),
    s('Nobody had come at night in the {n} weeks before.', 'En las {n} semanas anteriores no había venido nadie por la noche.'),
    s('Nobody had come to the door by {time} on {day}.', 'El {day}, a {time|las}, todavía no había venido nadie a la puerta.'),
    s('By that time on a {day} there are usually about {n}.', 'Un {day} a esa hora, lo habitual es alrededor de {n}.'),
    s('Fewer people than usual had come to the door by {time} on {day}: {n}.', 'El {day}, hasta {time|las}, había venido a la puerta menos gente de lo habitual: {n}.'),
    s('The door was busier than usual on {day}: {n} callers by {time}.', 'El {day} hubo más movimiento de lo habitual en la puerta: {n} personas hasta {time|las}.'),
  ],

  'services/agent/src/agents/narrator/weekCard.ts': [
    b('What {first} sees', 'Lo que ve {first}'),
  ],

  // The buttons under a note: what she can answer. Her own voice, to her family.
  'services/mcp-server/src/tools/send_note_to_tv.ts': [
    b('Thanks for letting me know!', '¡Gracias por avisarme!'),
    b("I'll call you soon.", 'Llamaré pronto.'),
    b('Not right now.', 'Ahora mismo no.'),
    b('Yes, please do.', 'Sí, por favor.'),
    b("Yes, that's fine.", 'Sí, está bien.'),
    b("I'd love that.", 'Me encantaría.'),
    b('Another day would be better.', 'Mejor otro día.'),
    b('A bit later would be better.', 'Mejor un poco más tarde.'),
    b('No, thank you.', 'No, gracias.'),
    b('Thank you!', '¡Gracias!'),
    b('Please call me.', 'Llámame, por favor.'),
    b("I'm fine, thank you.", 'Estoy bien, gracias.'),
    b('Thinking of you too.', 'Yo también pienso en ti.'),
    b("That's lovely to hear.", 'Qué alegría saberlo.'),
  ],

  // Watch together: the invitation (invite_to_watch.ts), "… is ready" (join_watch_together.ts), the film called off
  // (withdraw_watch_invitation.ts), and what the family member answered (answer_watch_together.ts). The day and the
  // hour are watchSession.ts whenInWords.
  'services/mcp-server/src/tools/invite_to_watch.ts and the three tools beside it': [
    s('{first} would like to watch a film with you.', '{first|cap} desea ver una película con usted.'),
    s('{title}, on {date} at {time}.', '{title|cap}, el {date} a {time|las}.'),
    s('{first} would watch along from home and see the film as you play it.', '{first|cap} vería la película desde su propia casa, tal como usted la reproduzca.'),
    s('You hold the remote.', 'Usted tiene el control remoto.'),
    b('Yes, let’s.', 'Sí, veámosla.'),
    b('Not this time.', 'Esta vez no.'),
    s('{first} is ready to watch {title} with you.', '{first|cap} ya puede ver {title} con usted.'),
    // The press on "Start the film" is the consent: this says what it shares (AGENTS.md, "Where a film has got to").
    s(
      'From when you start it, {first} sees the film as you play it: where you pause, it pauses for {first2} too.',
      'Desde que usted la inicie, {first} verá la película tal como usted la reproduce: donde usted haga una pausa, también se pausará para {first2}.',
    ),
    s('Only this film, and only this time.', 'Solo esta película, y solo esta vez.'),
    b('Start the film', 'Iniciar la película'),
    s('{first} cannot make the film after all.', 'Al final, {first} no puede ver la película.'),
    s('{title}, on {date} at {time}, is off.', '{title|cap}, el {date} a {time|las}, no tendrá lugar.'),
    s('{first} can ask you again for another time.', '{first|cap} puede volver a pedírselo para otro momento.'),
    s('About {title}, which you watched together.', 'Sobre {title}, que ustedes vieron en compañía.'),
  ],

  // The Circle card (INV-9): one press allows a person, and this is what it allows.
  'services/mcp-server/src/accounts/circle.ts': [
    s('{name} would like to join your family circle.', '{name|cap} desea unirse a su círculo familiar.'),
    s('{name} would like to be a neighbour you can ask.', '{name|cap} desea ser alguien del vecindario a quien usted pueda recurrir.'),
    s('If you allow it, {first} can send you notes here and see what you choose to share.', 'Si usted acepta, {first} podrá enviarle notas aquí y ver lo que usted decida compartir.'),
    s('You can change what is shared at any time.', 'Puede cambiar lo que se comparte en cualquier momento.'),
    s('If you allow it, you can ask {first} to look at who is at your door, or to ring you.', 'Si usted acepta, podrá pedir a {first} que mire quién está en su puerta, o que le llame.'),
    s('{first} will not see your week, your day or your notes.', '{first|cap} no verá su semana, su día ni sus notas.'),
    b('Allow {first}', 'Aceptar a {first}'),
    b('No, thank you', 'No, gracias'),
  ],

  // A wave: Wick's own sentence, naming the television it came from, and her two buttons.
  'services/mcp-server/src/accounts/familyTvWave.ts': [
    s('A wave to you from {first}’s television.', 'Un saludo con la mano para usted, desde el televisor de {first}.'),
    b('Wave back', 'Devolver el saludo'),
  ],

  // The light in the window, as she sees her own: it says one thing, and the card says so.
  'services/edge-device/lambda/light.mjs': [
    s('Your light is on.', 'Su luz está encendida.'),
    s('{first} can see that your day has begun, and nothing more: not when, and not what you watch.', '{first|cap} puede ver que su día ha empezado, y nada más: ni cuándo, ni lo que usted ve.'),
    b('Leave it on', 'Dejarla encendida'),
    b('Put it out for today', 'Apagarla por hoy'),
    s('Your light is out for today.', 'Su luz está apagada por hoy.'),
    s('{first} cannot tell whether you put it out or it has not been lit yet.', '{first|cap} no puede saber si usted la apagó o si todavía no se ha encendido.'),
    s('It lights again tomorrow.', 'Mañana se enciende de nuevo.'),
    b('Leave it out', 'Dejarla apagada'),
    b('Light it again', 'Encenderla de nuevo'),
  ],

  // "What Sarah sees": one thing the family can see per page, who can see it, and what is never shared.
  'services/edge-device/lambda/sharing.mjs': [
    s('When someone comes to your front door.', 'Cuando alguien viene a su puerta de entrada.'),
    s('Who visits you, by name, like Maria.', 'Quién viene de visita, por su nombre, como Maria.'),
    s('A short summary of your week.', 'Un breve resumen de su semana.'),
    s('Your appointments, in summary.', 'Sus citas, en resumen.'),
    s('{n} of {n2}.', '{n} de {n2}.'),
    s('You’re keeping this private.', 'Usted mantiene esto en privado.'),
    s('{first} can see this.', '{first|cap} puede ver esto.'),
    s('Nobody can see this yet: you have not allowed anyone.', 'Todavía nadie puede ver esto: usted no ha aceptado a nadie.'),
    s(
      'Never shared, whatever you choose: your health, money, relationships, where you go, or your words.',
      'Nunca se comparte, elija lo que elija: su salud, su dinero, sus relaciones, adónde va ni sus palabras.',
    ),
    b('Share it again', 'Compartir de nuevo'),
    b('Keep this private', 'Mantener en privado'),
    b('Next', 'Siguiente'),
    b('Done', 'Listo'),
  ],

  // The question at the credits.
  'services/edge-device/lambda/watch-together.mjs': [
    s('That was {title}, with {first}.', 'Ha terminado {title}, con {first}.'),
  ],
};

/** The nouns a builder uses where there is no one name: in a sentence, and at the start of one. */
const NOUNS: readonly (readonly [english: string, within: string, first: string])[] = [
  ['the family', 'la familia', 'La familia'],
  ['The family', 'la familia', 'La familia'],
  ['your family', 'su familia', 'Su familia'],
  ['Your family', 'su familia', 'Su familia'],
  ['Someone', 'alguien', 'Alguien'],
];

const DAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const PARTS_OF_TODAY = ['esta mañana', 'esta tarde', 'esta noche'];
/** mornings, afternoons, evenings (five until ten), nights. */
const PARTS_OF_A_DAY = ['por la mañana', 'por la tarde', 'a última hora de la tarde', 'por la noche'];

/** A name is never touched. Only the noun standing in for one is translated. */
function person(english: string, startsSentence: boolean): string {
  const noun = NOUNS.find(([word]) => word === english);
  return noun ? (startsSentence ? noun[2] : noun[1]) : english;
}

const plain = (form: string | undefined, word: string | undefined): string | undefined => (form === undefined ? word : undefined);

/** Spanish for the values a sentence carries, in the forms the catalogue above asks for. */
export const spanishWords: Lexicon = (slot: Slot, form) => {
  if (slot.kind === 'person' || slot.kind === 'people') {
    if (form !== undefined && form !== 'cap') return undefined;
    if (slot.kind === 'person') return person(slot.text, form === 'cap');
    const list = slot.list.map((name, i) => person(name, form === 'cap' && i === 0));
    // "y" stays "y" before any name: a name is not respelt, and neither is the word beside it.
    return list.length <= 1 ? list[0] : `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}`;
  }
  switch (slot.kind) {
    case 'day': {
      const day = DAYS[slot.index];
      if (form === undefined || day === undefined) return day;
      // "los martes", "los sábados": only Saturday and Sunday change in the plural.
      return form === 'pl' ? (day.endsWith('s') ? day : `${day}s`) : undefined;
    }
    case 'time': {
      const clock = `${slot.hour}:${String(slot.minute).padStart(2, '0')}`;
      if (form === undefined) return clock;
      // "a las 9:02", but "a la 1:05": one o'clock is singular.
      return form === 'las' ? `${slot.hour === 1 ? 'la' : 'las'} ${clock}` : undefined;
    }
    case 'part':
      return plain(form, PARTS_OF_TODAY[slot.index]);
    case 'parts':
      return plain(form, PARTS_OF_A_DAY[slot.index]);
    case 'date': {
      const [day, month] = [DAYS[slot.weekday], MONTHS[slot.month]];
      return day === undefined || month === undefined ? undefined : plain(form, `${day} ${slot.day} de ${month}`);
    }
    case 'count':
      return plain(form, slot.text);
    case 'title': {
      if (form !== undefined && form !== 'cap') return undefined;
      // The builders' word for a film whose title is not to hand.
      return slot.text === 'the film' ? (form === 'cap' ? 'La película' : 'la película') : slot.text;
    }
  }
};

export const SPANISH = compile(Object.values(ES_CATALOGUE).flat(), spanishWords);
