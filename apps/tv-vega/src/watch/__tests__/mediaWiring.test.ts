/**
 * The media session in the app (WatchScreen.tsx, ResidentApp.tsx,
 * family/FamilySeat.tsx). No view is rendered in these tests, so what they
 * decide is in mediaSession.ts, tested there, and this holds the screens to
 * using exactly that — read as source, as read/__tests__/app.test.ts does.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const code = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('WatchScreen.tsx — her film is the media session', () => {
  const screen = code('../WatchScreen.tsx');

  it('starts the session once the player is ready, tells it where the film is, and ends it as the film is let go', () => {
    expect(screen).toMatch(/session = startFilmSession\(\{ component, programme, command: \(command, deltaMs\) => obey\.current\(command, deltaMs\) \}\);/);
    expect(screen).toMatch(/session\?\.publish\(snapshot\);/);
    expect(screen).toMatch(/session\?\.end\(\);/);
  });

  it('decides each command by the pure rule, with what is on screen now, and moves the one player', () => {
    expect(screen).toMatch(/const outcome = mediaOutcome\(\s*command,\s*\{ cardVisible: now\.cardVisible, playReads: now\.playReads, reading: now\.reading, held: now\.held, suspended: now\.suspended \}/);
    expect(screen).toMatch(/moveFilm\(p, outcome\.film, \(\) => \{\s*resumeAfterCard\.current = false;\s*\}\);/);
    expect(screen).toMatch(/if \(outcome\.reader\) now\.onReadCommand\?\.\(outcome\.reader\);/);
  });

  it('lets a press heard twice — as the key and as the session’s command — count once', () => {
    expect(screen).toMatch(/echoes\.key\(event\.eventType, Date\.now\(\)\)/);
    expect(screen).toMatch(/if \(echoes\.echoes\(command, at\)\) console\.info\('media_command_echo', command\);\s*else act\(command, deltaMs\);/);
  });
});

describe('ResidentApp.tsx — what a command says to a reading', () => {
  const app = code('../../ResidentApp.tsx');

  it('is done by the one reader, as a key’s is', () => {
    expect(app).toMatch(/onReadCommand=\{handleMediaRead\}/);
    expect(app).toMatch(/reader\.press\(command\);\s*if \(command === 'toggle' && at\.card !== undefined\) setAskedFor\(at\.card\);/);
  });
});

describe('family/FamilySeat.tsx — no pause and no skip, by voice either', () => {
  const seat = code('../../family/FamilySeat.tsx');

  it('refuses every media command while the seat is open', () => {
    expect(seat).toMatch(/React\.useEffect\(\(\) => refuseFilmCommands\(refused\.current\), \[\]\);/);
  });

  it('never starts a session that obeys', () => {
    expect(seat).not.toMatch(/startFilmSession|mediaOutcome|moveFilm/);
  });
});

describe('mediaControls.ts and media/noFilm.ts — the only files that speak to the platform', () => {
  const controls = code('../mediaControls.ts');
  const noFilm = code('../../media/noFilm.ts');

  it('registers by itself, never by handing the player over (which would obey around the rules)', () => {
    expect(controls).toMatch(/mediaServer\(\)\.setHandlerForComponent\(handler, input\.component\);/);
    expect(controls + noFilm).not.toMatch(/setMediaControlFocus/);
  });

  it('says “no film” as a state: the platform refuses an empty list', () => {
    expect(noFilm).toMatch(/s\.updateMediaSessionStates\(\[NO_FILM\]\);/);
    expect(controls).toMatch(/handleGetSessionState: \(\) => Promise\.resolve\(\[last && !ended \? toState\(last\) : NO_FILM\]\)/);
    expect(controls + noFilm).not.toMatch(/updateMediaSessionStates\(\[\]\)/);
  });

  it('gives the film no start time: the platform cannot hold a zero instant and drops the whole state', () => {
    expect(controls).not.toMatch(/startTime/);
  });
});
