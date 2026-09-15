# infra — Terraform

Infrastructure as code for Wick. Terraform >= 1.10, AWS provider ~> 6.0.

## Layout

| File | Holds |
|---|---|
| `versions.tf` | Provider constraints, S3 backend, default tags |
| `variables.tf` | Region, environment, consent page URL, retention |
| `main.tf` | Caller identity, naming locals |
| `core.tf` | The memory plane — DynamoDB, EventBridge, S3, Secrets Manager |
| `edge.tf` | The edge — HTTP API, three Lambdas, least-privilege IAM |
| `outputs.tf` | The URLs the Ring console needs |
| `bootstrap/` | The one thing Terraform cannot manage: its own state bucket |

## First run

```bash
export AWS_PROFILE=wick-dev

./bootstrap/bootstrap.sh          # creates the state bucket, once per account
terraform init
terraform plan
terraform apply
./bootstrap/put-ring-secret.sh    # loads Ring credentials from ../.env
```

## State

S3 with **native locking** (`use_lockfile = true`) — Terraform 1.10+, so no
DynamoDB lock table. The bucket is versioned and encrypted, which is the safety
net for a truncated or corrupted state file.

The state bucket is the only resource not managed by Terraform, because something
has to hold the state before state exists.

## Invariants enforced here, not in application code

**INV-3 — no Ring media persists beyond 24 hours.** The `snapshots/` prefix
carries an expiry lifecycle rule (`core.tf`). Storage enforcing the promise is the
difference between a claim and a guarantee. Do not add an application-level copy,
cache or backup of a snapshot.

Note the `noncurrent_version_expiration` beside each rule: versioning is enabled,
so without it a deleted object survives as a non-current version — the rule that
was supposed to delete it would quietly not.

**INV-1 — no long-lived credential reaches the television.** Ring secrets live in
Secrets Manager and are readable only by the two Lambda roles that need them
(`edge.tf`), scoped to those exact secret ARNs.

## Deliberate choices

**`prevent_destroy` on every stateful resource.** The table, the bucket and both
secrets. A stray `terraform destroy` should fail loudly rather than take the
household's timeline with it. Removing the block is a conscious, reviewable edit.

**Reserved concurrency is unset on the webhook.** The intent was to stop a
downstream problem starving the acknowledgement path, but this account's total
Lambda concurrency quota is 10 — the new-account default; mature accounts get
1000 — so any reservation drops unreserved below the service minimum. Restore
`reserved_concurrent_executions = 20` once the quota is raised.

**API access logs carry no request body and no headers.** An access log for an
endpoint carrying household events must not become a second copy of those events.

**`arm64` Lambdas.** Cheaper and slightly faster for this workload; nothing in the
handlers is architecture-dependent.

## The deprecation warnings

`terraform plan` warns that `hash_key` and `range_key` on `aws_dynamodb_table` are
deprecated in favour of `key_schema`. That is AWS provider 6.x signalling a future
change; both still work and the replacement is not yet the documented default.
Worth revisiting, not worth churning now.
