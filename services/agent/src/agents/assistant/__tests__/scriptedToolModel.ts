/**
 * A Strands Model that plays a script: each call to it takes the next step
 * — a sentence, or tool calls — and it records what it was shown. Test
 * only: lives under __tests__ and never ships.
 */
import {
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';

export type Step =
  | { readonly say: string }
  | { readonly call: readonly { readonly name: string; readonly input?: Record<string, unknown>; readonly id?: string }[]; readonly say?: string }
  | { readonly waitMs: number; readonly then: Step }
  | { readonly fail: string };

export interface Seen {
  readonly messages: Message[];
  readonly system: string;
  readonly tools: string[];
}

let ids = 0;

export class ScriptedToolModel extends Model<BaseModelConfig> {
  readonly seen: Seen[] = [];
  #config: BaseModelConfig = { modelId: 'scripted-tools' };
  readonly #script: Step[];

  constructor(script: readonly Step[]) {
    super();
    this.#script = [...script];
  }

  /** Steps not yet played: a test can see that the model was not asked again. */
  get left(): number {
    return this.#script.length;
  }

  updateConfig(config: BaseModelConfig): void {
    this.#config = { ...this.#config, ...config };
  }

  getConfig(): BaseModelConfig {
    return this.#config;
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const system = typeof options?.systemPrompt === 'string' ? options.systemPrompt : JSON.stringify(options?.systemPrompt ?? '');
    this.seen.push({ messages: messages.map((m) => m), system, tools: (options?.toolSpecs ?? []).map((t) => t.name) });
    let step = this.#script.shift();
    if (!step) throw new Error('the script has no more steps');
    while ('waitMs' in step) {
      await new Promise((resolve) => setTimeout(resolve, step && 'waitMs' in step ? step.waitMs : 0));
      step = step.then;
    }
    if ('fail' in step) throw new Error(step.fail);

    yield new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'assistant' });
    if (step.say !== undefined) {
      yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' });
      yield new ModelContentBlockDeltaEvent({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: step.say } });
      yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' });
    }
    const calls = 'call' in step ? step.call : [];
    for (const call of calls) {
      ids += 1;
      yield new ModelContentBlockStartEvent({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: call.name, toolUseId: call.id ?? `tooluse_${ids}` },
      });
      yield new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(call.input ?? {}) },
      });
      yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' });
    }
    yield new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: calls.length ? 'toolUse' : 'endTurn' });
  }
}
