/**
 * A Strands Model that answers each call with the next turn of a script —
 * a sentence, a tool call (how Strands' structured output arrives), or a
 * failure — and records what it was sent. Test-only: lives under __tests__
 * and never ships. scriptedModel.ts is the one-reply version.
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

export type Turn = string | { readonly tool: string; readonly input: Record<string, unknown> } | Error;

export class TurnsModel extends Model<BaseModelConfig> {
  /** Every call's messages, as text, in order. */
  readonly seen: string[] = [];
  /** Every call's options: the system prompt and the tools it was offered. */
  readonly options: (StreamOptions | undefined)[] = [];
  #config: BaseModelConfig = { modelId: 'turns' };
  #next = 0;

  constructor(private readonly turns: readonly Turn[]) {
    super();
  }

  updateConfig(config: BaseModelConfig): void {
    this.#config = { ...this.#config, ...config };
  }

  getConfig(): BaseModelConfig {
    return this.#config;
  }

  get calls(): number {
    return this.#next;
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.seen.push(messages.flatMap((m) => m.content.map((b) => (b.type === 'textBlock' ? b.text : ''))).join('\n'));
    this.options.push(options);
    const turn = this.turns[this.#next];
    this.#next += 1;
    if (turn === undefined) throw new Error('the script has no more turns');
    if (turn instanceof Error) throw turn;

    yield new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'assistant' });
    if (typeof turn === 'string') {
      yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' });
      yield new ModelContentBlockDeltaEvent({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: turn } });
      yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' });
      yield new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: 'endTurn' });
      return;
    }
    yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: turn.tool, toolUseId: `tool-${this.#next}` } });
    yield new ModelContentBlockDeltaEvent({ type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(turn.input) } });
    yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' });
    yield new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: 'toolUse' });
  }
}

/** The tool Strands' structured output asks the model to call (tools/structured-output-tool.js). */
export const STRUCTURED_OUTPUT_TOOL = 'strands_structured_output';
