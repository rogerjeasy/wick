# infra — Terraform

All of Wick's AWS infrastructure, in one Terraform root. Terraform >= 1.10
(CI uses 1.16.2), AWS provider ~> 6.0, region `us-east-1`.

There are two exceptions to "all of it": the S3 bucket that holds the state
(`bootstrap/bootstrap.sh`, because something has to hold the state before
state exists), and the values inside the secrets, which are put there by the
scripts below and never pass through Terraform.

## Files

| File | Holds |
|---|---|
| `versions.tf` | Provider constraints, the S3 backend (native locking), default tags |
| `variables.tf` | Every input, with what it is for, and its default |
| `images.tf` | Which image each container service runs: the two SSM parameters `/wick/images/agents` and `/wick/images/mcp-server`, written after each push |
| `main.tf` | Caller identity, naming locals (`wick`, or `wick-home` for the `home` environment) |
| `core.tf` | The memory plane: the DynamoDB table, the EventBridge bus and its catch-all log, the media bucket (INV-3), the Ring secrets |
| `edge.tf` | The edge HTTP API and the Ring Lambdas: webhook, token, link, authorize, hourly refresh, a household's own link |
| `status.tf` | `GET /status`, the ops console's health page |
| `pairing.tf` | Television pairing (`/pair/*`) and the device-token signing key |
| `transport.tf` | The televisions' WebSocket API and its three Lambdas |
| `iot.tf` | The televisions' MQTT channel: IoT Core custom authorizer and two topic rules |
| `agent.tf` | The door path: EventBridge rule → `agent-door-event` Lambda, its retries and dead letters |
| `card-action.tf` | The card presses the agent plane carries out, and the rules that bring them |
| `reach.tf` | Hold for Sarah's three-minute timers (EventBridge Scheduler) |
| `narrator.tf` | The weekly narrative, Sunday 20:00 UTC |
| `live.tf` | Watch live: `agent-live` and the `live-bridge` container Lambda |
| `agentcore.tf` | The agent plane on Bedrock AgentCore Runtime, its two ECR repositories, the live-view CloudFront |
| `mcp.tf` | The Wick server (MCP + family app API) on App Runner, and its ECR repository |
| `accounts.tf` | Family accounts in Cognito |
| `push.tf` | Web Push keys |
| `photos.tf` | The mantelpiece's own bucket |
| `speech.tf` | Read to me (Amazon Polly) |
| `programmes.tf` | The bucket and CloudFront the films play from |
| `sim-alexa.tf` | The family app (static files on S3 + CloudFront) |
| `ops-console.tf` | The status dashboard and the virtual television (S3 + CloudFront) |
| `alarms.tf` | What pages someone: the SNS topic, every alarm, the dead-letter queue, the platform log groups' retention |
| `github-oidc.tf` | CI's deploy role, assumed by OIDC (no AWS keys in GitHub) |
| `outputs.tf` | The URLs the Ring console needs, and the rest a person or a script reads |
| `bootstrap/` | `bootstrap.sh`, `generate-pairing-key.sh`, `generate-push-keys.sh`, `put-ring-secret.sh` |

## A new deployment, in order

Every command runs from the repository root with `AWS_PROFILE` set. The
order matters: each step needs what the one before made.

```bash
export AWS_PROFILE=wick-dev

# 1. The state bucket, once per account. versions.tf names the bucket with the
#    account id: change it there for another account.
./infra/bootstrap/bootstrap.sh

# 2. The Lambda bundles. Several functions are esbuild bundles under
#    services/agent/.build (gitignored), and the plan reads them: every plan
#    and apply, a laptop's or CI's, needs this first.
npm ci
npm run build:lambda

terraform -chdir=infra init

# 3. The three image repositories and the two parameters that pin their
#    tags, alone: App Runner and AgentCore will not start without an image
#    to run.
terraform -chdir=infra apply \
  -target=aws_ecr_repository.agents \
  -target=aws_ecr_repository.live_bridge \
  -target=aws_ecr_repository.mcp_server \
  -target=aws_ssm_parameter.agents_image \
  -target=aws_ssm_parameter.mcp_server_image

# 4. The images. Each script builds, pushes under the short git SHA, and
#    writes that SHA to its parameter (images.tf). After this, CI does it
#    on every push to main.
scripts/push-agent-image.sh     # wick-agents + wick-live-bridge, arm64
scripts/push-mcp-image.sh       # wick-mcp-server, amd64 (App Runner)

# 5. Everything. mcp_issuer_url's default is the current deployment's own
#    address, so a new one starts with it empty (mcp.tf says why).
terraform -chdir=infra apply -var mcp_issuer_url=""

# 6. The second apply: the Wick server's real address, baked into its OAuth
#    metadata. Set it as the default in variables.tf (or a tfvars file) so
#    later applies, CI's included, keep it.
terraform -chdir=infra output -raw mcp_server_url
terraform -chdir=infra apply -var mcp_issuer_url="https://<that address>"

# 7. The secrets' values. Terraform made the containers; these fill them.
./infra/bootstrap/put-ring-secret.sh                        # Ring app credentials, from .env
./infra/bootstrap/generate-pairing-key.sh                   # signs television tokens
./infra/bootstrap/generate-push-keys.sh mailto:you@example.com   # Web Push

# 8. A Ring link for the operator household (var.household_id). A
#    Playground token lasts about 30 minutes. A home's organiser does the
#    same from the family app's Doorbell card.
scripts/set-ring-token.sh

# 9. The films the television plays.
scripts/publish-programmes.sh all

# 10. CI: set the repository variable AWS_DEPLOY_ROLE_ARN to
terraform -chdir=infra output -raw github_deploy_role_arn
```

Every variable has a default. Variables worth setting on purpose: `alarm_email`
(see below), `ring_operator_link` (off; turn on only while linking the
operator's own Ring account), `ring_playground_link` and `demo_accounts` (on
for the hackathon, off for a deployment with real doorbells and real people),
`ring_webhook_reserved_concurrency` (once the Lambda quota is raised).

## What CI applies, and what it cannot

`deploy-edge.yml` and `deploy-agent.yml` run `npm run verify`, `npm run
build:lambda` and a full `terraform apply` on every push to `main` that
touches their paths. They authenticate by OIDC as `github-actions-wick-deploy`
(`github-oidc.tf`), which can manage the services this stack already uses,
scoped to `wick-*` names where AWS allows it.

A laptop apply, by someone with administrator rights, is needed for:

- **The deploy role's own policy.** The role can read itself and nothing
  more, so it can never widen its own permissions. Any change to
  `github-oidc.tf` is applied from a laptop.
- **A new AWS service.** Until the deploy role has been granted it, CI's
  apply stops at the first resource of that kind, part-way through, with
  everything before it already changed. Apply from a laptop first, so the
  grant and the resources exist together; CI's next apply is then a no-op.
- **The first apply of `images.tf`.** CI pins an image only in a parameter
  Terraform has already made, so on a stack that has never had `images.tf`
  applied, `deploy-agent.yml` stops at "pin the images" with that message.

Before a laptop apply, bring the checkout up to date with `main` and run the
same command as `plan` first. A targeted apply from a stale checkout once
destroyed nine resources.

## How an image is deployed

`deploy-agent.yml`, on a push to `main` that changes a path an image is
built from (each Dockerfile's `COPY` lines), or by hand from the Actions tab:

1. **verify** — `npm run test:property` and `npm run verify`.
2. **mcp-image** and **agent-images**, only for the images the push changed:
   the Wick server for `linux/amd64` on `ubuntu-latest`; the AgentCore
   runtime and the live bridge for `linux/arm64` on `ubuntu-24.04-arm`,
   natively. Each is pushed under the commit's short SHA, never `latest`.
3. **deploy**, in the `terraform-infra` concurrency group that every apply
   takes: writes each new SHA to its parameter (only forward along `main`:
   a slower run of an older commit never moves a pin back), runs
   `terraform apply`, which points AgentCore, the bridge Lambda and App
   Runner at exactly those tags, then waits on App Runner's own operations
   and fails unless the pinned image is the one running. A deployment App
   Runner rolled back ends `RUNNING` on the old image, which is why the
   apply alone is not trusted.

Every apply, a laptop's included, reads the tags from SSM, so an apply from
an older checkout deploys today's images, not that checkout's. With the
Wick server's parameter at `latest` (a stack CI has never deployed), App
Runner follows pushes to `:latest` by itself, as it used to; once a SHA is
pinned, automatic deployments are off and only a moved pin deploys it.

**To roll back**, from a laptop: `terraform -chdir=infra apply -var
mcp_image_tag=<older sha>` (or `-var agent_image_tag=…`). The override wins
over the parameter for that apply only; the next CI apply returns to the
parameter, so also write the older SHA to the parameter with `aws ssm
put-parameter --overwrite` if it is to stay. ECR keeps the ten most recent
images of each repository.

**After each deploy**, `smoke.yml` runs `npm run smoke:live` against the
live stack (also nightly, and by hand). It needs no AWS credentials.

## What pages someone (`alarms.tf`)

Every alarm notifies the SNS topic `wick-alarms` (output `alarm_topic_arn`),
on alarm and on recovery.

| Alarm | Fires when |
|---|---|
| `<function>-errors` | Any of the 22 Lambdas throws or times out, once in 5 minutes |
| `<function>-throttles` | Any of the 22 Lambdas is throttled (the account quota is 10) |
| `wick-dead-letters-not-empty` | A door event or a press failed every try (below) |
| `wick-narrator-week-not-written` | The weekly narrative failed for a household (a `narrative_household_failed` log line) |
| `wick-narrator-run-not-started` | EventBridge could not start the weekly run |
| `wick-mcp-server-5xx` | The Wick server answered 5xx three times in 5 minutes |
| `wick-edge-api-5xx` | The edge HTTP API answered 5xx three times in 5 minutes |
| `wick-transport-integrationerror`, `-executionerror` | The televisions' WebSocket API failed three times in 5 minutes |

The MQTT authorizer is the `iot-authorize` Lambda, so its failures are its
errors and throttles alarms.

**To receive them**, set the repository secret `ALARM_EMAIL`:

```
gh secret set ALARM_EMAIL --repo rogerjeasy/wick
```

Both deploy workflows pass it to Terraform as `TF_VAR_alarm_email`, so every
CI apply keeps the subscription. It is a secret, not a variable, because this
repository's Actions logs are public; the variable is `sensitive`, so a plan
never prints it either. AWS emails a confirmation link first; nothing arrives
until it is clicked. A laptop apply must export `TF_VAR_alarm_email` as well,
or it removes the subscription. With no address (the default) the alarms
still change state and show in the CloudWatch console, and nobody is told.

## Retries and the dead-letter queue

The door path, from Ring's webhook to her television:

- **EventBridge → `agent-door-event`.** EventBridge retries only when it
  cannot hand the event to Lambda at all. Its default is 185 tries over 24
  hours, unseen; here it is two more tries within five minutes, then the
  event goes to `wick-dead-letters`.
- **The function itself.** Lambda retries a failed run once, about a minute
  later, and runs nothing older than five minutes — the door card's own
  lifetime: by then the visitor has gone. Then the invocation record goes to
  `wick-dead-letters`.
- **Why a retry is safe.** The card's id comes from Ring's event id, and
  `egress.ts` writes a door card only if it is not already there. A retried
  Phase 1 never puts the bare card back over a picture, a sentence or her
  answer; it sends the stored card again instead, if she has not answered it.
- **Ring slow or down.** Phase 1 no longer waits on Ring: if the device list
  cannot be read, the card still goes, without Watch live or the chime.

`agent-card-action` and `live-bridge` failures go to the same queue.
`card-action` keeps Lambda's default retries (Hold for Sarah's timers reach it
the same way and a failed step must still be taken); `live-bridge` is never
retried, because a live view is for now.

The queue keeps a message 14 days, encrypted (SSE-SQS). The ops console's
status page shows how many are waiting. To read them, from a laptop:

```bash
aws sqs receive-message --max-number-of-messages 10 \
  --queue-url "$(terraform -chdir=infra output -raw dead_letter_queue_url)"
```

A message from EventBridge is the event itself; one from Lambda carries the
event under `requestPayload` and the error under `responsePayload`. They are
a household's events: read them, fix the cause, then purge the queue. The
deploy role cannot read them.

## Logs

Every Lambda's log group is declared here with 14 days' retention, so none is
created by Lambda to keep everything forever. App Runner and AgentCore create
their own groups; `alarms.tf` finds them by prefix, imports each the first
time a plan sees it, and keeps 30 days. On a new account the next apply after
the services first log picks them up.

## State

S3 with native locking (`use_lockfile = true`), so no DynamoDB lock table.
The bucket is versioned and encrypted: the safety net for a truncated or
corrupted state file.

## Invariants enforced here, not in application code

**INV-3 — no Ring media persists beyond 24 hours.** The `snapshots/` and
`live/` prefixes carry expiry lifecycle rules (`core.tf`). Versioning is on,
so each rule expires non-current versions too, or a deleted object would
survive as one. Do not add an application-level copy, cache or backup of a
snapshot.

**INV-1 — no long-lived credential reaches the television.** Ring secrets
are in Secrets Manager, one per household (`wick/ring/tokens/<householdId>`),
readable only by the roles that act for a household. The public status page
reads none of them: it sees that the operator household's secret exists and
when it changed (`DescribeSecret`), never its value.

## Deliberate choices

**`prevent_destroy` on every stateful resource, and deletion protection on
the table.** `prevent_destroy` stops this Terraform; DynamoDB's own deletion
protection stops the console, the CLI and anything else too. The table also
has point-in-time recovery. Removing either is a conscious, reviewable edit.

**No reserved concurrency on the webhook, yet.** The intent is to keep a busy
agent plane from starving Ring's five-second acknowledgement, but this
account's Lambda quota is 10, and AWS refuses a reservation that leaves fewer
than 10 unreserved. `ring_webhook_reserved_concurrency` is null until the
quota is raised; then set it (20 was the intent).

**Timeouts inside timeouts.** Every call to Ring gives up after 5 seconds,
and every call to the agent plane after 20 (8 for the door's sentence), so a
function ends by its own deadline, with a reason in its log, and never by
Lambda killing it. The door Lambda's 40 seconds is the sum of its parts with
room to spare (`services/agent/src/agents/door/lambda.ts`).

**API access logs carry no request body and no headers.** An access log for
an endpoint carrying household events must not become a second copy of them.

**`arm64` Lambdas.** Cheaper and slightly faster for this workload; nothing
in the handlers is architecture-dependent.

## The deprecation warnings

`terraform validate` warns that `hash_key` and `range_key` on
`aws_dynamodb_table` are deprecated in favour of `key_schema`. That is AWS
provider 6.x signalling a future change; both still work. Worth revisiting,
not worth churning now.
