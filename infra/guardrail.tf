# ---------------------------------------------------------------------------
# The Bedrock Guardrail on Wick's agents (docs/WICK-TECHNICAL.md §20).
#
#   the family assistant (AgentCore, assistant.turn): on its model, input and output
#   the Sunday brief (AgentCore, brief.weekly):         ApplyGuardrail on the writer's
#                                                       paragraph and the suggestion,
#                                                       with contextual grounding against
#                                                       the week's counted facts
#
# The Guardian (services/policy) stays the gate of record for every string the
# family reads (INV-2). This is a second, model-side check: either may refuse.
# It refuses the things a care product must never do in words — advise on
# health or money, or guess how she feels — and it checks that a sentence
# about her week says only what the counted facts say.
# ---------------------------------------------------------------------------

resource "aws_bedrock_guardrail" "wick" {
  name        = "${local.prefix}-agents"
  description = "Wick's agents: no medical or financial advice, no guessing her mood, nothing beyond the counted facts."

  blocked_input_messaging   = "I can't help with that here."
  blocked_outputs_messaging = "I can't say that. Ask me what the house has seen this week."

  topic_policy_config {
    topics_config {
      name       = "medical-advice"
      type       = "DENY"
      definition = "Diagnosing, treating or advising on anyone's health, illness, medicine, symptoms or care needs."
      examples   = ["Should Mum change her tablets?", "Does she have dementia?", "What dose should she take?"]
    }
    topics_config {
      name       = "financial-advice"
      type       = "DENY"
      definition = "Advice or judgements about anyone's money, pension, benefits, bank accounts, debts or bills."
      examples   = ["Is Mum spending too much?", "Should she move her savings?"]
    }
    topics_config {
      name       = "guessing-her-mood"
      type       = "DENY"
      definition = "Guessing or reporting how the resident feels, her mood, mental state, loneliness or wellbeing, from what the house has seen."
      examples   = ["Is Mum depressed?", "She seems lonely this week.", "Was she sad on Tuesday?"]
    }
  }

  content_policy_config {
    filters_config {
      type            = "HATE"
      input_strength  = "HIGH"
      output_strength = "HIGH"
    }
    filters_config {
      type            = "INSULTS"
      input_strength  = "HIGH"
      output_strength = "HIGH"
    }
    filters_config {
      type            = "SEXUAL"
      input_strength  = "HIGH"
      output_strength = "HIGH"
    }
    filters_config {
      type            = "VIOLENCE"
      input_strength  = "HIGH"
      output_strength = "HIGH"
    }
    filters_config {
      type            = "MISCONDUCT"
      input_strength  = "HIGH"
      output_strength = "HIGH"
    }
    filters_config {
      # Prompt attacks are judged on input only; the output strength must be NONE.
      type            = "PROMPT_ATTACK"
      input_strength  = "HIGH"
      output_strength = "NONE"
    }
  }

  sensitive_information_policy_config {
    pii_entities_config {
      type   = "PHONE"
      action = "ANONYMIZE"
    }
    pii_entities_config {
      type   = "EMAIL"
      action = "ANONYMIZE"
    }
    pii_entities_config {
      type   = "ADDRESS"
      action = "ANONYMIZE"
    }
  }

  # Grounding: a sentence about her week must be supported by the facts it was
  # written from (the brief passes the fact lines as the grounding source, the
  # assistant the tools' own texts). 0.5, measured on the deployed guardrail
  # on 2026-10-16: faithful paraphrases of a week's facts scored 0.68 to 0.97,
  # and every sentence carrying something the facts did not say (a trip to
  # the shops, a mood, wrong counts) scored 0.0. At 0.75 the writer's honest
  # paragraphs were refused and every week fell back to the counted facts.
  contextual_grounding_policy_config {
    filters_config {
      type      = "GROUNDING"
      threshold = 0.5
    }
    filters_config {
      type      = "RELEVANCE"
      threshold = 0.5
    }
  }
}

# A published version: the agents use a fixed version, so an edit to the draft
# changes nothing until it is published here.
resource "aws_bedrock_guardrail_version" "wick" {
  guardrail_arn = aws_bedrock_guardrail.wick.guardrail_arn
  description   = "Published by Terraform."

  # A change to the guardrail publishes a new version; the agents read the
  # version number from their environment (agentcore.tf), so they follow.
  # The new version exists, and the agents are moved to it, before the old
  # one is deleted: never a moment when they name a version that is gone.
  lifecycle {
    replace_triggered_by  = [aws_bedrock_guardrail.wick]
    create_before_destroy = true
  }
}

output "agents_guardrail_id" {
  value = aws_bedrock_guardrail.wick.guardrail_id
}

output "agents_guardrail_version" {
  value = aws_bedrock_guardrail_version.wick.version
}
