/**
 * A Strands Model that replies with a fixed script and records what it was
 * sent. Test-only: lives under __tests__ and never ships.
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
} from '@strands-agents/sdk';

export class ScriptedModel extends Model<BaseModelConfig> {
  readonly seen: Message[][] = [];
  #config: BaseModelConfig = { modelId: 'scripted' };

  constructor(private readonly reply: string | (() => never)) {
    super();
  }

  updateConfig(config: BaseModelConfig): void {
    this.#config = { ...this.#config, ...config };
  }

  getConfig(): BaseModelConfig {
    return this.#config;
  }

  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.seen.push([...messages]);
    if (typeof this.reply === 'function') this.reply();
    yield new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'assistant' });
    yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' });
    yield new ModelContentBlockDeltaEvent({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: this.reply as string } });
    yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' });
    yield new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: 'endTurn' });
  }
}
