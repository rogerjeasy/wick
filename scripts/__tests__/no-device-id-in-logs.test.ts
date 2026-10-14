/**
 * AGENTS.md INV-1: a television's id is how a refresh is asked for. Where its
 * row keeps no secret (the Vega Virtual Device) the id alone is enough to be
 * handed a token, and a log is read by more people, and kept longer, than the
 * table. So no log line, anywhere Wick runs, carries one.
 *
 * Read from the source, the way a reviewer would: every call to a logger
 * (`console.*`, and the `log` / `say` functions the services pass around)
 * whose arguments name a device id. A Ring camera's id is another thing, and
 * is named `ringDeviceId`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SOURCES = ['services', 'apps', 'packages'];
const SKIP = /(^|\/)(node_modules|__tests__|dist|\.build|android|ios)(\/|$)/;
const CODE = /\.(ts|tsx|mjs|js)$/;
const LOGGER = /\b(console\.(log|error|warn|info|debug)|log|say)\s*\(/g;
const NAMES_A_DEVICE = /(?<![A-Za-z])(deviceId|device_id|clientId)\b/;

function sources(): string[] {
  return SOURCES.flatMap((dir) =>
    (readdirSync(path.join(root, dir), { recursive: true }) as string[])
      .map((file) => path.join(dir, file))
      .filter((file) => CODE.test(file) && !SKIP.test(file.split(path.sep).join('/'))),
  );
}

/** Each logger call in the source, from its name to its closing parenthesis. */
function loggerCalls(source: string): { line: number; text: string }[] {
  const calls: { line: number; text: string }[] = [];
  for (const match of source.matchAll(LOGGER)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push({ line: source.slice(0, match.index).split('\n').length, text: source.slice(match.index, end + 1) });
  }
  return calls;
}

describe('no television id in a log (AGENTS.md INV-1)', () => {
  it('finds the logger calls it is looking through', () => {
    expect(loggerCalls("console.log(JSON.stringify({ msg: 'x', deviceId }));\nlog({ a: f(b) });")).toEqual([
      { line: 1, text: "console.log(JSON.stringify({ msg: 'x', deviceId }))" },
      { line: 2, text: 'log({ a: f(b) })' },
    ]);
    expect(NAMES_A_DEVICE.test('{ deviceId }')).toBe(true);
    expect(NAMES_A_DEVICE.test('{ ringDeviceId }')).toBe(false);
  });

  it('is in none of them', () => {
    const found = sources().flatMap((file) =>
      loggerCalls(readFileSync(path.join(root, file), 'utf8'))
        .filter((call) => NAMES_A_DEVICE.test(call.text))
        .map((call) => `${file}:${call.line}`),
    );
    expect(found).toEqual([]);
  });
});
