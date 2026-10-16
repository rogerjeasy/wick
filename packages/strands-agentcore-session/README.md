# @wick/strands-agentcore-session

AgentCore Memory session storage for the Strands TypeScript SDK: a
`SnapshotStorage` that keeps a Strands agent's session in Amazon Bedrock
AgentCore Memory, so a conversation survives a cold start of the AgentCore
Runtime microVM and a new browser.

This is the code of Wick's open-source pull request to
[aws/bedrock-agentcore-sdk-typescript](https://github.com/aws/bedrock-agentcore-sdk-typescript)
(branch [`rogerjeasy:feat/strands-session-storage`](https://github.com/rogerjeasy/bedrock-agentcore-sdk-typescript/tree/feat/strands-session-storage)),
which answers that repository's issues #160 and #214. It is kept here, with
its tests, until the upstream module is released; then Wick imports it from
`bedrock-agentcore/memory/strands` instead. Events written by either copy are
readable by the other.

Wick's family assistant (`services/agent/src/agents/assistant/`) uses it: one
session per member per home (`assistant-<sha256(home:member)>`), under the
agent's own actor id, so what the session storage writes and what the
long-term memory strategy reads never mix.

```ts
import { SessionManager } from '@strands-agents/sdk';
import { createAgentCoreMemorySessionStorage } from '@wick/strands-agentcore-session';

new SessionManager({ sessionId, storage: createAgentCoreMemorySessionStorage({ memoryId, actorId: 'wick-assistant' }) });
```

The runtime role needs `bedrock-agentcore:CreateEvent`, `ListEvents` and
`DeleteEvent` on the memory. Licensed Apache-2.0, like the upstream SDK.
