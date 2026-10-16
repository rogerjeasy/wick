/**
 * Calling the assistant on AgentCore Runtime: one InvokeAgentRuntime per
 * turn, in the member's own runtime session (`assistant-<hash>`, identity.ts
 * in the agent), so one member's conversation runs in one microVM and never
 * shares it with anyone else's.
 *
 * The payload carries the member's token — the agent calls Wick's tools
 * with it — so it is never logged, here or by the route (turn.ts): a
 * failure is reported by its error's name only.
 *
 * The same shape as the agent plane's own invoker (services/agent/src/
 * runtime/invoke.ts), whose session is the household; this one's is the
 * member's.
 */
import type { InvokeAgentRuntimeCommandInput } from '@aws-sdk/client-bedrock-agentcore';
import type { AgentTurnPayload, AssistantAgent } from './turn.js';

/**
 * The agent's own turn is twenty seconds (services/agent/src/agents/
 * assistant/turn.ts); a cold microVM and the reading of the answer come on
 * top. Inside the family app's thirty (apps/sim-alexa/surface.js
 * REQUEST_LIMITS_MS.assistant), so the app hears the 503 and falls back.
 */
export const ASSISTANT_RUNTIME_TIMEOUT_MS = 26_000;

export interface AssistantRuntimeReply {
  readonly statusCode?: number | undefined;
  readonly response?: { transformToString(): Promise<string> } | undefined;
}

export type AssistantRuntimeSend = (
  input: InvokeAgentRuntimeCommandInput & { payload: Uint8Array },
  options?: { readonly abortSignal?: AbortSignal },
) => Promise<AssistantRuntimeReply>;

export interface AssistantRuntimeTarget {
  readonly send: AssistantRuntimeSend;
  readonly runtimeArn: string;
  /** The deployed runtime version: a new one means a fresh microVM at the member's next question. */
  readonly version?: string;
  readonly timeoutMs?: number;
}

/** Rejects with `agentcore_timeout` the moment `signal` aborts, whatever `work` is doing. */
function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const giveUp = () => reject(new Error('agentcore_timeout'));
    if (signal.aborted) return giveUp();
    signal.addEventListener('abort', giveUp, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', giveUp));
  });
}

export function agentCoreAssistant(target: AssistantRuntimeTarget): AssistantAgent {
  return {
    async invoke(sessionId: string, payload: AgentTurnPayload): Promise<unknown> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? ASSISTANT_RUNTIME_TIMEOUT_MS);
      try {
        const version = target.version ? `-v${target.version.replace(/[^A-Za-z0-9]/g, '')}` : '';
        const out = await beforeDeadline(target.send({
          agentRuntimeArn: target.runtimeArn,
          runtimeSessionId: `${sessionId}${version}`,
          contentType: 'application/json',
          accept: 'application/json',
          payload: new TextEncoder().encode(JSON.stringify(payload)),
        }, { abortSignal: controller.signal }), controller.signal);

        const status = out.statusCode ?? 200;
        if (status < 200 || status >= 300) throw new Error(`agentcore_${status}`);
        const text = (await beforeDeadline(out.response?.transformToString() ?? Promise.resolve(''), controller.signal)) ?? '';
        return text ? (JSON.parse(text) as unknown) : {};
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
