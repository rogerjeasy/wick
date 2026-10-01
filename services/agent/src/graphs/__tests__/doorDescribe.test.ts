import { describe, it, expect } from 'vitest';
import { DESCRIBE_NODES, buildDescribeAgent, runDescribeGraph } from '../doorDescribe.js';
import { ScriptedModel } from './scriptedModel.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('door describe graph — a Strands Agent on the frame, then the validator', () => {
  it('sends the frame to the model as an image, and keeps a valid sentence', async () => {
    const model = new ScriptedModel('PERSON: yes\nA man in a delivery uniform, holding a parcel.');

    const run = await runDescribeGraph(JPEG, { model });

    expect(run.path).toEqual([DESCRIBE_NODES.describe, DESCRIBE_NODES.validate]);
    expect(run.result.candidate).toEqual({ description: 'A man in a delivery uniform, holding a parcel.', confidence: 0.9, personVisible: true });
    expect(run.result.reason).toBe('ok');

    const sent = model.seen[0]!.flatMap((m) => m.content);
    expect(sent.some((b) => b.type === 'imageBlock')).toBe(true);
  });

  it('declines on UNCLEAR — silence beats a wrong description', async () => {
    const run = await runDescribeGraph(JPEG, { model: new ScriptedModel('UNCLEAR') });
    expect(run.result).toMatchObject({ candidate: null, reason: 'model declined: unclear frame' });
  });

  it('rejects a sentence the validator refuses, whatever the prompt said', async () => {
    const run = await runDescribeGraph(JPEG, { model: new ScriptedModel('PERSON: yes\nSomeone who seems to be waiting patiently.') });
    expect(run.result.candidate).toBeNull();
    expect(run.result.reason).toMatch(/^rejected by validator/);
  });

  it('never throws when the model fails — Phase 1 simply stands', async () => {
    const model = new ScriptedModel(() => { throw new Error('ThrottlingException'); });
    const run = await runDescribeGraph(JPEG, { model });
    expect(run.result.candidate).toBeNull();
    expect(run.result.reason).toMatch(/^model:/);
  });

  it('gives the vision agent no tools — one with roster access could name a stranger', () => {
    expect(buildDescribeAgent(new ScriptedModel('x')).tools).toEqual([]);
  });
});
