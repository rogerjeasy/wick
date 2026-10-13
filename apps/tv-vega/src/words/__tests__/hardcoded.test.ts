/**
 * A sentence the resident's television says must come from the words table
 * (words/words.ts), or it stays English when she has chosen another
 * language — and nothing else would notice. This reads the source the way
 * family/__tests__/apart.test.ts does, and fails on a sentence written
 * straight into a component.
 *
 * What it looks for, in every runtime file outside the places listed below:
 *
 *   1. text written between JSX tags;
 *   2. a string given, as it stands or behind a condition, as a JSX child or
 *      to a prop that is shown or spoken (SHOWN_PROPS) — and to a property
 *      of those names in an object (a button's `label`);
 *   3. anywhere at all, a string shaped like a sentence: it starts with a
 *      capital and holds at least two words.
 *
 * What it cannot catch — so these are still looked for by eye:
 *
 *   - a single word that is not written in JSX or under one of those names
 *     (`return 'Open'` from a helper, a word in a list);
 *   - a sentence that starts with a small letter, or is put together from
 *     single words (`'Light ' + state`);
 *   - words handed to a prop this does not know to be shown;
 *   - anything formatted rather than written: a date or a number put into
 *     words by `Intl`, which speaks the language it is asked for;
 *   - words that come from outside this app's source: a programme's line and
 *     attribution (packages/contracts programmes.ts), words in a picture;
 *   - the places left out below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Left out, each for its own reason:
 *   - __tests__: never shipped;
 *   - words: the table itself;
 *   - family: a family member's own television stays English, and its words
 *     are mostly the server's;
 *   - notify: the toasts are posted by the background service, a process
 *     that is never told the home's language (notify/doorToast.ts).
 */
const LEFT_OUT = ['__tests__', 'words', 'family', 'notify'];

/** Props whose string is shown on the screen or spoken by the screen reader. */
const SHOWN_PROPS = new Set(['headline', 'detail', 'label', 'title', 'notice', 'placeholder', 'accessibilityLabel', 'accessibilityHint']);

function runtimeFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return LEFT_OUT.includes(entry) ? [] : runtimeFiles(path);
    return /\.tsx?$/.test(entry) && !entry.endsWith('.d.ts') ? [path] : [];
  });
}

const hasLetter = (text: string): boolean => /\p{L}/u.test(text);

/** Where a value is put into a template: it stands for a word. */
const HOLE = '\u0000';

/**
 * A capital (or an opening ¿ ¡) — or a value put in first, as in
 * `${title} will not play` — and then at least two words, of which a value
 * put in counts as one: `Paused — ${title}` is a sentence.
 */
function sentenceShaped(text: string): boolean {
  if (!new RegExp(`^[¿¡]?(\\p{Lu}|${HOLE})`, 'u').test(text.trim())) return false;
  const words = text.match(new RegExp(`(?<![\\p{L}\\p{N}_-])\\p{L}[\\p{L}’']+(?![\\p{L}\\p{N}_-])|${HOLE}`, 'gu')) ?? [];
  // At least one of them written here: two values side by side are not a sentence of this app's.
  return words.length >= 2 && words.some((word) => word !== HOLE) && /\s/.test(text.trim());
}

/**
 * Shaped like a sentence, and not one: what goes before a token in a
 * request's header.
 */
const NOT_WORDS = new Set([`Bearer ${HOLE}`]);

/** What a string or template says by itself, without the values put into it. */
function writtenText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(HOLE);
  return undefined;
}

/** The strings an expression can come to: through a condition, `&&`, `||`, `??` and brackets. */
function stringsOf(node: ts.Expression): ts.Node[] {
  if (ts.isParenthesizedExpression(node)) return stringsOf(node.expression);
  if (ts.isConditionalExpression(node)) return [...stringsOf(node.whenTrue), ...stringsOf(node.whenFalse)];
  if (ts.isBinaryExpression(node)) return [...stringsOf(node.left), ...stringsOf(node.right)];
  return writtenText(node) === undefined ? [] : [node];
}

/** Never shown to anyone: what an error is called, and what is written to the log. */
function isForTheLog(node: ts.Node): boolean {
  for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
    if (ts.isNewExpression(up) && /Error$/.test(up.expression.getText())) return true;
    if (ts.isCallExpression(up) && /^console\./.test(up.expression.getText())) return true;
    if (ts.isThrowStatement(up)) return true;
  }
  return false;
}

export function hardCoded(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Map<number, string>();
  const note = (node: ts.Node, said: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.set(node.getStart(source), `${relative(SRC, file)}:${line} ${said.split(HOLE).join('{…}').replace(/\s+/g, ' ').trim()}`);
  };
  const noteShown = (expression: ts.Expression): void => {
    for (const string of stringsOf(expression)) {
      const said = writtenText(string)!;
      if (hasLetter(said)) note(string, said);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;

    if (ts.isJsxText(node)) {
      if (hasLetter(node.text)) note(node, node.text);
    } else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      noteShown(node.expression);
    } else if (ts.isJsxAttribute(node) && SHOWN_PROPS.has(node.name.getText(source)) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) noteShown(node.initializer);
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) noteShown(node.initializer.expression);
    } else if (ts.isPropertyAssignment(node) && SHOWN_PROPS.has(node.name.getText(source))) {
      noteShown(node.initializer);
    } else {
      const said = writtenText(node);
      if (said !== undefined && sentenceShaped(said) && !NOT_WORDS.has(said) && !isForTheLog(node)) note(node, said);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found.values()];
}

describe('the scan itself — it sees what it is meant to see', () => {
  const scan = (text: string, file = 'Some.tsx'): string[] => hardCoded(join(SRC, file), text).map((line) => line.replace(/^\S+ /, ''));

  it('sees text written between tags', () => {
    expect(scan('const a = <Text style={s}>Open</Text>;')).toEqual(['Open']);
  });

  it('sees a string given as a child or to a prop that is shown or spoken, also behind a condition', () => {
    expect(scan("const a = <Text>{ready ? 'Open' : `Starting ${title}…`}</Text>;")).toEqual(['Open', 'Starting {…}…']);
    expect(scan('const a = <CalmCard headline="Hello." actions={x} />;')).toEqual(['Hello.']);
    expect(scan("const a = <Image accessibilityLabel={`${name}'s photo`} />;")).toEqual(["{…}'s photo"]);
    expect(scan("const BACK = [{ id: 'back', label: 'Back', kind: 'primary' }];", 'some.ts')).toEqual(['Back']);
  });

  it('sees a sentence wherever it is written', () => {
    expect(scan("export const line = (on: boolean) => (on ? 'Light on' : 'Light out');", 'some.ts')).toEqual(['Light on', 'Light out']);
    expect(scan('const said = `A note from ${name} is waiting.`;', 'some.ts')).toEqual(['A note from {…} is waiting.']);
    // A value first, or one word and a value: still a sentence.
    expect(scan('const notice = failed ? `${title} will not play just now.` : `Paused — ${title}`;', 'some.ts')).toEqual(['{…} will not play just now.', 'Paused — {…}']);
  });

  it('leaves alone what is not words for her: names of things, values put together, the log, a type', () => {
    expect(scan('const a = <Pressable accessibilityRole="button" accessibilityLabel="" resizeMode="cover" />;')).toEqual([]);
    expect(scan('const a = <Image accessibilityLabel={`${programme.title}. ${programme.line}`} />;')).toEqual([]);
    expect(scan("const a = <Text>{say('home.question')}</Text>;")).toEqual([]);
    expect(scan("throw new Error('Not paired yet');\nconsole.error('Card channel failed', err);", 'some.ts')).toEqual([]);
    expect(scan("const headers = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };", 'some.ts')).toEqual([]);
    expect(scan("type A = 'Light on' | 'Light out';", 'some.ts')).toEqual([]);
    expect(scan('const url = `${base}/live/sessions/${id}`;\nconst key = `${card.id}:${n}`;\nconst both = `${a} ${b}`;', 'some.ts')).toEqual([]);
  });
});

describe("the resident's television — every sentence it owns comes from the words table", () => {
  it('writes no sentence straight into a component or a helper', () => {
    const found = runtimeFiles().flatMap((file) => hardCoded(file, readFileSync(file, 'utf8')));

    expect(found).toEqual([]);
  });

  it('reads every file the app is made of, but for the places left out on purpose', () => {
    const files = runtimeFiles().map((file) => relative(SRC, file));

    for (const read of ['ResidentApp.tsx', 'home/HomeScreen.tsx', 'home/light.ts', 'home/waiting.ts', 'cards/WeekCard.tsx', 'cards/doorDetail.ts', 'watch/WatchScreen.tsx', 'live/liveClient.ts', 'pairing/PairingScreen.tsx']) {
      expect(files).toContain(read);
    }
    expect(files.filter((file) => /^(family|notify|words)\//.test(file) || file.includes('__tests__'))).toEqual([]);
  });
});
