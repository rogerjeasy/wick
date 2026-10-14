import { RuleTester, type Rule } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import plugin from '../../eslint/index.js';
import { alarmHueOfRgb, parseColour, parseNamedColour } from '../../eslint/colour.js';
import { alarmHue } from '../constraints.js';

// RuleTester looks for the test framework's hooks on itself.
(RuleTester as unknown as { afterAll: typeof afterAll }).afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const rule = (name: string): Rule.RuleModule => {
  const found = plugin.rules?.[name];
  if (!found) throw new Error(`no rule ${name}`);
  return found as Rule.RuleModule;
};

describe('min-font-size', () => {
  tester.run('min-font-size', rule('min-font-size'), {
    valid: [
      'const s = StyleSheet.create({ body: { fontSize: 32 } });',
      'const s = { title: { fontSize: 48 } };',
      "const s = { body: { fontSize: fontSize('body') } };",
      'const s = { body: { fontSize: scaled(24) } }; // not a literal: not ours to judge',
      'const s = { lineHeight: 12, padding: 8 };',
      { code: 'const s = { caption: { fontSize: 24 } };', options: [{ min: 24 }] },
      'const s = { [key]: 12 };',
    ],
    invalid: [
      { code: 'const s = StyleSheet.create({ caption: { fontSize: 24 } });', errors: [{ messageId: 'tooSmall' }] },
      { code: "const s = { 'fontSize': 18 };", errors: [{ messageId: 'tooSmall' }] },
      { code: 'const s = { fontSize: 20 as const };', errors: [{ messageId: 'tooSmall' }] },
      { code: '<Text style={{ fontSize: 16 }}>Hi</Text>;', errors: [{ messageId: 'tooSmall' }] },
      { code: 'const s = { body: { fontSize: 32 } };', options: [{ min: 36 }], errors: [{ messageId: 'tooSmall' }] },
    ],
  });
});

describe('no-alarm-colour', () => {
  tester.run('no-alarm-colour', rule('no-alarm-colour'), {
    valid: [
      "const s = { color: '#F4F1EA', backgroundColor: '#12100E' };",
      "const s = { accent: '#E8B75D' }; // amber",
      "const s = { color: '#A08070' }; // a desaturated clay",
      "const s = { color: 'rgba(0, 0, 0, 0.6)' };",
      "const label = 'red'; // a word, not a colour",
      "const s = { color: 'white' };",
      "const msg = 'Press #f00 to continue'; // not a whole colour",
      "const s = { color: 'coral' }; // hue 16deg: orange, not red",
    ],
    invalid: [
      { code: "const s = { color: '#FF0000' };", errors: [{ messageId: 'alarm' }] },
      { code: "const s = { color: '#f00' };", errors: [{ messageId: 'alarm' }] },
      { code: "const s = { borderColor: '#E53935CC' };", errors: [{ messageId: 'alarm' }] },
      { code: "const s = { backgroundColor: 'rgb(198, 40, 40)' };", errors: [{ messageId: 'alarm' }] },
      { code: "const s = { tintColor: 'rgba(255,59,48,0.9)' };", errors: [{ messageId: 'alarm' }] },
      { code: "const s = { color: 'crimson' };", errors: [{ messageId: 'alarm' }] },
      { code: "const s = { color: `#8B0000` };", errors: [{ messageId: 'alarm' }] },
      { code: '<Icon color="red" />;', errors: [{ messageId: 'alarm' }] },
      { code: "<Icon color={'tomato'} />;", errors: [{ messageId: 'alarm' }] },
      { code: "const ERROR = '#FF453A';", errors: [{ messageId: 'alarm' }] },
    ],
  });

  it('agrees with the runtime check on every colour of a 4096-colour sweep', () => {
    const steps = Array.from({ length: 16 }, (_, i) => i * 17);
    let reds = 0;
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const hex = '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
          const runtime = alarmHue(hex);
          const lint = alarmHueOfRgb(...(parseColour(hex) as [number, number, number]));
          expect(lint).toBe(runtime);
          if (runtime !== null) reds += 1;
        }
      }
    }
    // The sweep did find reds, so agreement is not two functions that never fire.
    expect(reds).toBeGreaterThan(50);
  });

  it('reads short hex, alpha hex, rgb() and named colours as the same channels', () => {
    expect(parseColour('#f00')).toEqual([255, 0, 0]);
    expect(parseColour('#F00A')).toEqual([255, 0, 0]);
    expect(parseColour('#ff000080')).toEqual([255, 0, 0]);
    expect(parseColour('rgb(255, 0, 0)')).toEqual([255, 0, 0]);
    expect(parseColour('rgba(255 0 0 / 50%)')).toEqual([255, 0, 0]);
    expect(parseNamedColour('Red')).toEqual([255, 0, 0]);
    expect(parseColour('red')).toBeNull();
    expect(parseColour('#12345')).toBeNull();
  });
});

describe('max-actions', () => {
  tester.run('max-actions', rule('max-actions'), {
    valid: [
      "<CalmCard headline='Hi' actions={[a, b, c]} onAction={f} />;",
      '<CalmCard actions={actions} />; // not written out: the render-time check covers it',
      '<CalmCard actions={[a, b, ...rest]} />;',
      '<Menu actions={[a, b, c, d]} />; // not a calm card',
      { code: '<Sheet actions={[a, b]} />;', options: [{ components: ['Sheet'], max: 2 }] },
    ],
    invalid: [
      { code: '<CalmCard actions={[a, b, c, d]} />;', errors: [{ messageId: 'tooMany' }] },
      { code: '<TwoPhaseCard actions={[a, b, c, d] as const} />;', errors: [{ messageId: 'tooMany' }] },
      { code: '<ui.CalmCard actions={[a, b, c, d, e]} />;', errors: [{ messageId: 'tooMany' }] },
      { code: '<Sheet actions={[a, b, c]} />;', options: [{ components: ['Sheet'], max: 2 }], errors: [{ messageId: 'tooMany' }] },
    ],
  });
});

describe('no-auto-dismiss', () => {
  tester.run('no-auto-dismiss', rule('no-auto-dismiss'), {
    valid: [
      // A timer in a component that renders no calm card.
      `function Clock() { useEffect(() => { const t = setInterval(tick, 1000); return () => clearInterval(t); }, []); return <Text />; }`,
      // A calm card with no timer.
      `function Door({ onAction }) { return <CalmCard headline="At the door" actions={[]} onAction={onAction} />; }`,
      // Two components in one file: the timer belongs to the other one.
      `function Door() { return <CalmCard />; }
       function Poller() { useEffect(() => { setTimeout(poll, 5000); }, []); return null; }`,
      // A module-level timer is not a component's.
      `setTimeout(warmUp, 0); function Door() { return <CalmCard />; }`,
      // Someone else's setTimeout.
      `function Door() { scheduler.setTimeout(f, 10); return <CalmCard />; }`,
    ],
    invalid: [
      {
        code: `function Door({ onDismiss }) {
          useEffect(() => { const t = setTimeout(onDismiss, 8000); return () => clearTimeout(t); }, []);
          return <CalmCard headline="At the door" actions={[]} onAction={onDismiss} />;
        }`,
        errors: [{ messageId: 'timer' }],
      },
      {
        code: `const Note = () => { window.setInterval(rotate, 3000); return <TwoPhaseCard />; };`,
        errors: [{ messageId: 'timer' }],
      },
      {
        code: `class Door extends React.Component {
          componentDidMount() { setTimeout(() => this.props.onDismiss(), 5000); }
          render() { return <CalmCard />; }
        }`,
        errors: [{ messageId: 'timer' }],
      },
      {
        code: `function Sheet() { setTimeout(close, 10); return <Sheet />; }`,
        options: [{ components: ['Sheet'] }],
        errors: [{ messageId: 'timer' }],
      },
    ],
  });
});

describe('the recommended config', () => {
  it('turns on all four rules as errors, under the plugin’s own name', () => {
    expect(plugin.configs.recommended.plugins?.['vega-calm-ui']).toBe(plugin);
    expect(plugin.configs.recommended.rules).toEqual({
      'vega-calm-ui/max-actions': 'error',
      'vega-calm-ui/min-font-size': 'error',
      'vega-calm-ui/no-alarm-colour': 'error',
      'vega-calm-ui/no-auto-dismiss': 'error',
    });
  });
});
