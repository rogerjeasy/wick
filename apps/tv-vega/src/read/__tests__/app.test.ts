/**
 * "Read to me" in the app (ResidentApp.tsx, watch/WatchScreen.tsx). Neither
 * is rendered here — no view in this app is — so what they decide is in
 * reading.ts, remoteKeys.ts and filmVolume.ts, tested there, and this holds
 * them to using exactly that: read as source, the way
 * family/__tests__/apart.test.ts reads the app.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const code = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('ResidentApp.tsx — read to me', () => {
  const app = code('../../ResidentApp.tsx');

  it('makes one reader, with the platform’s player, her asking sent like any event, and the film it may turn down', () => {
    expect(app).toMatch(/new Reader\(\{/);
    expect(app).toMatch(/createPlayer: createSpeechPlayer,/);
    expect(app).toMatch(/ask: \(cardId\) => void store\.enqueueOutbound\(\{ t: 'read', cardId, at: Date\.now\(\) \}\),/);
    expect(app).toMatch(/return lowerFilm\(film, \(\) => filmPlayer\.current === film\);/);
  });

  it('hands the reader the server’s answer as it comes', () => {
    expect(app).toMatch(/store\.onSpeech\(\(cardId, url\) => reader\.speech\(cardId, url\)\)/);
  });

  it('tells the reader which card is on screen: none while the door camera is over it, while Wick is behind another app, or where reading cannot work', () => {
    expect(app).toMatch(/const readingCard = readable && onScreen && card !== null && liveFor === null \? card\.id : undefined;/);
    expect(app).toMatch(/reader\.showing\(readingCard\);/);
  });

  it('lets the reading go when the app is closed', () => {
    expect(app).toMatch(/return \(\) => reader\.stop\(\);/);
  });

  it('works out whose Play is from the pure rule: the card’s, or — over a film the card holds, once it has been asked — the film’s again', () => {
    expect(app).toMatch(/const holdsFilm = watching !== null && breakController\.holdsProgramme\(card \?\? undefined\);/);
    expect(app).toMatch(/const playReads = playIsTheCards\(\{ card: readingCard, holdsFilm, askedFor \}\);/);
  });

  it('gives both screens the same three things for a key: whether a card is up, whose Play is, and whether a reading is under way', () => {
    const handler = app.slice(app.indexOf('useTVEventHandler((event) => {'), app.indexOf('\n  });', app.indexOf('useTVEventHandler((event) => {')));

    expect(app).toMatch(/keysNow\.current = \{ cardVisible: card !== null, playReads, reading, card: readingCard \};/);
    expect(app).toMatch(/const reading = readingState !== 'idle';/);
    expect(handler).toMatch(/const at = keysNow\.current;\s*const command = readCommand\(event, at\);/);
    expect(app).toMatch(/cardVisible=\{card !== null\}\s*playReads=\{playReads\}\s*reading=\{reading\}/);
    expect(app).toMatch(/held=\{holdsFilm\}/);
  });

  it('remembers that Play has asked for this showing of this card, and forgets it when the card leaves the screen', () => {
    const handler = app.slice(app.indexOf('useTVEventHandler((event) => {'), app.indexOf('\n  });', app.indexOf('useTVEventHandler((event) => {')));

    expect(handler).toMatch(/if \(command === 'toggle' && at\.card !== undefined\) setAskedFor\(at\.card\);/);
    expect(app).toMatch(/setAskedFor\(\(asked\) => \(asked !== null && asked !== readingCard \? null : asked\)\);/);
  });

  it('does not hand the reader a key the idle screen takes: the idle rule is asked as it stood when the key arrived, before it is moved on', () => {
    const handler = app.slice(app.indexOf('useTVEventHandler((event) => {'), app.indexOf('\n  });', app.indexOf('useTVEventHandler((event) => {')));

    expect(handler).toMatch(/if \(command && !blocksHome\(idleNow\.current\)\) \{\s*reader\.press\(command\);/);
    expect(handler.indexOf('reader.press(command)')).toBeGreaterThan(-1);
    expect(handler.indexOf('reader.press(command)')).toBeLessThan(handler.indexOf('idleOnKey(idleNow.current, event, now)'));
  });

  it('is told by the reader how it stands, so a key knows whether a reading is under way', () => {
    expect(app).toMatch(/onChange: setReadingState,/);
  });

  it('is told of the film’s player, so the film can be turned down and put back', () => {
    expect(app).toMatch(/onPlayer=\{handleFilmPlayer\}/);
    expect(app).toMatch(/filmPlayer\.current = player;/);
  });

  it('draws the mark of the Play key with the card — only where reading can work, and not while the door camera is over the card', () => {
    const layer = app.slice(app.indexOf('{card && !liveFor ? ('), app.indexOf('{liveFor ? ('));

    expect(layer).toMatch(/<CardRenderer\b/);
    expect(layer).toMatch(/\{readable \? <ReadHint cardType=\{card\.card\.type\} language=\{language\} \/> : null\}/);
    expect(layer.indexOf('<ReadHint')).toBeGreaterThan(layer.indexOf('<CardRenderer'));
  });

  it('never starts a reading by itself: only the key does — or the media session’s Play/Pause, which is that key heard another way', () => {
    // The second is handleMediaRead, given only what watch/mediaSession.ts decides a command says to a reading:
    // a toggle only for the Play/Pause command, by the key's own rule (mediaSession.test.ts).
    expect(app.match(/reader\.press\(/g)).toHaveLength(2);
    expect(app).toMatch(/const handleMediaRead = React\.useCallback\(\s*\(command: ReadCommand\) => \{/);
    expect(app).not.toMatch(/reader\.speech\((?!cardId, url\))/);
  });
});

describe('WatchScreen.tsx — the film under a card that is read', () => {
  const screen = code('../../watch/WatchScreen.tsx');

  it('leaves Play alone while it is the card’s, and takes it back when it is the film’s again — by the same rule the app uses', () => {
    expect(screen).toMatch(/watchCommand\(event, \{ cardVisible: latest\.current\.cardVisible, playReads: latest\.current\.playReads, reading: latest\.current\.reading \}\)/);
  });

  it('says which player the film has, when it has one and when it has let it go', () => {
    expect(screen).toMatch(/latest\.current\.onPlayer\?\.\(p\);/);
    expect(screen).toMatch(/latest\.current\.onPlayer\?\.\(null\);/);
  });

  it('does not touch the volume itself: the reading does, and puts it back', () => {
    expect(screen).not.toMatch(/\.volume\b/);
  });
});

describe('speechPlayer.ts — the platform’s player, for one reading', () => {
  const player = code('../speechPlayer.ts');

  it('is an AudioPlayer for speech, as the simulator was seen to play one', () => {
    expect(player).toMatch(/new AudioPlayer\(AudioContentType\.CONTENT_TYPE_SPEECH, AudioUsageType\.USAGE_MEDIA\)/);
    expect(player).toMatch(/from '@amazon-devices\/react-native-w3cmedia'/);
  });

  it('is the only place that names the audio player: everything else is handed one', () => {
    for (const file of ['../reading.ts', '../../ResidentApp.tsx', '../../watch/WatchScreen.tsx', '../ReadHint.tsx', '../hintPlace.ts']) {
      expect(code(file), file).not.toMatch(/\bAudioPlayer\b|AudioContentType|AudioUsageType/);
    }
  });
});
