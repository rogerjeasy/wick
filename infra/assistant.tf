# ---------------------------------------------------------------------------
# The family assistant as a Strands agent on AgentCore Runtime (spec §6).
#
#   family app ──POST /assistant/turn──▶ Wick server (App Runner, mcp.tf)
#                                          │ InvokeAgentRuntime, member token in the payload
#                                          ▼
#                    runtime kind "assistant.turn" (agentcore.tf, same container)
#                    services/agent/src/agents/assistant/
#                      ├─ GET /api/me with the token: whose conversation this is
#                      ├─ McpClient ── member token ──▶ Wick's MCP tools
#                      ├─ Claude Sonnet 4.5 + the Bedrock Guardrail (guardrail.tf)
#                      ├─ SessionManager ─ AgentCore Memory events (the conversation)
#                      └─ MemoryManager ── AgentCore Memory records (the member's own words)
#
# The memory below holds both. Its events expire after 30 days. The
# user-preference strategy turns a member's own words into records under
# /households/{home}/members/{member}: the agent writes their events with
# the member as the actor and the home as the session
# (services/agent/src/agents/assistant/identity.ts MEMBER_NAMESPACE_TEMPLATE
# is this template). Deleting an account deletes both (mcp-server
# assistant/forget.ts), so the Wick server may delete, and the runtime may not.
#
# New service type: the first apply of this file is a laptop apply by the
# user, checked as a plan first (infra/README.md).
# ---------------------------------------------------------------------------

locals {
  # Wick's MCP endpoint, for the agent's McpClient and its GET /api/me. From
  # the server's own public URL (variables.tf), not App Runner's resource: the
  # Wick server already depends on the runtime, and the other way round would
  # be a cycle. Empty until mcp_issuer_url is set: the turn then says it is
  # not set up and the family app uses /assistant/next.
  assistant_mcp_url = var.mcp_issuer_url != "" ? "${trimsuffix(var.mcp_issuer_url, "/")}/mcp" : ""
}

resource "aws_bedrockagentcore_memory" "assistant" {
  name                  = "${replace(local.prefix, "-", "_")}_assistant"
  description           = "Wick's family assistant: each member's conversation, and what they said in their own words."
  event_expiry_duration = 30
}

resource "aws_bedrockagentcore_memory_strategy" "member_words" {
  memory_id   = aws_bedrockagentcore_memory.assistant.id
  name        = "member_words"
  description = "What a family member says about how they like things done: never anything about the resident."
  type        = "USER_PREFERENCE"
  # {sessionId} is the home and {actorId} the member (identity.ts).
  namespace_templates = ["/households/{sessionId}/members/{actorId}"]
}

# --- The runtime: the model, the guardrail, the memory --------------------------

data "aws_iam_policy_document" "agents_runtime_assistant" {
  statement {
    sid = "AskTheAssistantsModel"
    # Strands' BedrockModel streams (ConverseStream), through the same
    # cross-region profile the stand-in and the Narrator use.
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/${local.narrative_model_profile}",
      "arn:aws:bedrock:*::foundation-model/${local.narrative_model}",
    ]
  }

  statement {
    sid       = "GuardTheAssistantsModel"
    actions   = ["bedrock:ApplyGuardrail"]
    resources = [aws_bedrock_guardrail.wick.guardrail_arn]
  }

  statement {
    sid = "KeepConversationsAndTheMembersOwnWords"
    # Events: the conversation's saved state (the session storage) and the
    # member's words (AgentCoreMemoryStore). Records: what the strategy made
    # of their words, read back before a question. No delete of a record:
    # that is the Wick server's, with an account.
    actions = [
      "bedrock-agentcore:CreateEvent",
      "bedrock-agentcore:GetEvent",
      "bedrock-agentcore:ListEvents",
      "bedrock-agentcore:DeleteEvent",
      "bedrock-agentcore:RetrieveMemoryRecords",
      "bedrock-agentcore:ListMemoryRecords",
    ]
    resources = [aws_bedrockagentcore_memory.assistant.arn]
  }
}

resource "aws_iam_role_policy" "agents_runtime_assistant" {
  name   = "${local.prefix}-agents-runtime-assistant"
  role   = aws_iam_role.agents_runtime.id
  policy = data.aws_iam_policy_document.agents_runtime_assistant.json
}

# --- The Wick server: invoke the turn, forget a deleted member ------------------

data "aws_iam_policy_document" "apprunner_assistant" {
  statement {
    sid     = "AskTheAssistantAgent"
    actions = ["bedrock-agentcore:InvokeAgentRuntime"]
    resources = [
      aws_bedrockagentcore_agent_runtime.agents.agent_runtime_arn,
      "${aws_bedrockagentcore_agent_runtime.agents.agent_runtime_arn}/*",
    ]
  }

  statement {
    sid = "ForgetADeletedMember"
    # DELETE /api/account (mcp-server accounts/myData.ts, assistant/forget.ts).
    actions = [
      "bedrock-agentcore:ListEvents",
      "bedrock-agentcore:DeleteEvent",
      "bedrock-agentcore:ListMemoryRecords",
      "bedrock-agentcore:DeleteMemoryRecord",
      "bedrock-agentcore:BatchDeleteMemoryRecords",
    ]
    resources = [aws_bedrockagentcore_memory.assistant.arn]
  }
}

resource "aws_iam_role_policy" "apprunner_assistant" {
  name   = "${local.prefix}-apprunner-assistant"
  role   = aws_iam_role.apprunner_instance.id
  policy = data.aws_iam_policy_document.apprunner_assistant.json
}

output "assistant_memory_id" {
  value = aws_bedrockagentcore_memory.assistant.id
}
