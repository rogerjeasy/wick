/**
 * What the infrastructure promises about spend and about the deploy role,
 * held where a change to either cannot quietly undo it (they are Terraform,
 * which no other test reads). Reads the .tf files as text: these are the
 * shapes a review would look for, written down so a review need not.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INFRA = resolve(dirname(fileURLToPath(import.meta.url)), '../../infra');
const read = (file: string): string => readFileSync(join(INFRA, file), 'utf8');

interface Statement {
  readonly sid: string;
  readonly effect: 'Allow' | 'Deny';
  readonly actions: readonly string[];
  readonly resources: readonly string[];
}

/** The `statement { ... }` blocks of one `data "aws_iam_policy_document" <name>`. */
function statementsOf(source: string, document: string): Statement[] {
  const start = source.indexOf(`data "aws_iam_policy_document" "${document}" {`);
  if (start < 0) throw new Error(`no policy document ${document}`);
  const body = source.slice(start);
  // The document ends at the first line that is only a closing brace.
  const end = body.search(/\n}\n/);
  const text = body.slice(0, end);
  const out: Statement[] = [];
  for (const block of text.split(/\n  statement \{\n/).slice(1)) {
    const list = (name: string): string[] => {
      const m = new RegExp(`\\n    ${name}\\s*=\\s*\\[([\\s\\S]*?)\\n?\\s*\\]`).exec(`\n${block}`);
      return m ? [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!) : [];
    };
    // A list on one line, or over several; `resources = ["*"]`, or ARNs built from locals.
    const resources = list('resources');
    const sid = /sid\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? '(none)';
    const effect = /effect\s*=\s*"Deny"/.test(block) ? 'Deny' : 'Allow';
    out.push({ sid, effect, actions: list('actions'), resources: resources.length ? resources : [...block.matchAll(/(aws_[a-z_.0-9\[\]]+\.arn)/g)].map((x) => x[1]!) });
  }
  return out;
}

describe('the deploy role (infra/github-oidc.tf)', () => {
  const source = read('github-oidc.tf');
  const documents = ['github_deploy', 'github_deploy_stack', 'github_deploy_denials'] as const;
  const all = documents.flatMap((d) => statementsOf(source, d));
  const allows = all.filter((s) => s.effect === 'Allow');
  const denies = all.filter((s) => s.effect === 'Deny');

  it('reads three documents', () => {
    for (const d of documents) expect(statementsOf(source, d).length, d).toBeGreaterThan(2);
  });

  it('grants no whole service on every resource: a `service:*` action is held to names', () => {
    const offenders = allows.filter((s) => s.resources.includes('*') && s.actions.some((a) => a.endsWith(':*')));
    expect(offenders.map((s) => `${s.sid}: ${s.actions.filter((a) => a.endsWith(':*')).join(',')}`)).toEqual([]);
  });

  it('grants no data-plane verb on every resource', () => {
    const dataPlane = /^(dynamodb:(Get|Put|Update|Delete|Query|Scan|BatchGet|BatchWrite|Execute|Transact)|s3:(GetObject|PutObject|DeleteObject)|lambda:Invoke|events:PutEvents|logs:(GetLogEvents|FilterLogEvents|StartQuery|GetQueryResults))/;
    const offenders = allows.filter((s) => s.resources.includes('*') && s.actions.some((a) => dataPlane.test(a)));
    expect(offenders.map((s) => s.sid)).toEqual([]);
  });

  it('denies every way a deploy could read or write a household’s rows, pictures, logs or events, or run a function', () => {
    const denied = new Set(denies.flatMap((s) => s.actions));
    for (const action of [
      'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
      'dynamodb:TransactWriteItems', 'dynamodb:ExecuteStatement', 'dynamodb:ExportTableToPointInTime',
      's3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket',
      'lambda:InvokeFunction', 'lambda:InvokeAsync', 'lambda:InvokeFunctionUrl', 'events:PutEvents',
      'logs:GetLogEvents', 'logs:FilterLogEvents', 'logs:StartQuery', 'logs:StartLiveTail',
      'bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:ListEvents',
    ]) expect(denied.has(action), action).toBe(true);
  });

  it('keeps the household buckets, and nothing else, out of reach of object actions', () => {
    const bucketDenial = denies.find((s) => s.sid === 'NeverTouchADoorPictureOrAFamilyPhoto')!;
    expect(bucketDenial.resources.join(' ')).toContain('aws_s3_bucket.media');
    expect(bucketDenial.resources.join(' ')).toContain('aws_s3_bucket.photos');
    const written = allows.find((s) => s.sid === 'PutTheStaticSites')!;
    expect(written.resources.join(' ')).not.toMatch(/media|photos/);
  });

  it('cannot write its own permissions', () => {
    const iamWrites = allows.filter((s) => s.actions.some((a) => /^iam:(Put|Attach|Create|Update|Delete|Detach)/.test(a)));
    for (const s of iamWrites) {
      expect(s.resources.join(' '), s.sid).not.toMatch(/github-actions-wick-deploy|github_deploy/);
    }
  });

  it('is a role only a tag-less ref of main can assume', () => {
    expect(source).toContain('default     = "refs/heads/main"');
    expect(source).toMatch(/test\s*=\s*"StringEquals"\s*\n\s*variable\s*=\s*"token\.actions\.githubusercontent\.com:sub"/);
  });
});

describe('what an anonymous visitor can reach (infra/edge.tf)', () => {
  const edge = read('edge.tf');
  const pairing = read('pairing.tf');
  const live = read('live.tf');
  const limits = (() => {
    const block = /edge_route_limits = \{([\s\S]*?)\n  \}/.exec(edge)![1]!;
    return new Map([...block.matchAll(/"([A-Z]+ [^"]+)"\s*=\s*\{\s*rate\s*=\s*(\d+),\s*burst\s*=\s*(\d+)\s*\}/g)].map((m) => [m[1]!, { rate: Number(m[2]), burst: Number(m[3]) }]));
  })();

  const routeKeys = [
    ...[...(/routes = \{([\s\S]*?)\n  \}/.exec(edge)![1]!).matchAll(/"([A-Z]+ [^"]+)"\s*=/g)].map((m) => m[1]!),
    ...[...(/pairing_routes = \{([\s\S]*?)\n  \}/.exec(pairing)![1]!).matchAll(/"([A-Z]+ [^"]+)"\s*=/g)].map((m) => m[1]!),
    ...[...(/live_routes = toset\(\[(.*?)\]\)/.exec(live)![1]!).matchAll(/"([A-Z]+ [^"]+)"/g)].map((m) => m[1]!),
  ];

  it('knows every route of the edge API', () => {
    expect(routeKeys).toContain('POST /ring/webhook');
    expect(routeKeys).toContain('POST /pair/start');
    expect(routeKeys.length).toBeGreaterThanOrEqual(10);
  });

  it('gives each route a limit of its own, so none is left to a share of the default', () => {
    expect(routeKeys.filter((k) => !limits.has(k))).toEqual([]);
    expect([...limits.keys()].filter((k) => !routeKeys.includes(k))).toEqual([]);
  });

  it('keeps Ring’s webhook at least as roomy as anything an anonymous visitor can call, except the television’s poll', () => {
    const webhook = limits.get('POST /ring/webhook')!;
    expect(webhook.rate).toBeGreaterThanOrEqual(100);
    for (const key of ['POST /pair/start', 'POST /pair/claim', 'POST /pair/refresh', 'POST /ring/token', 'GET /ring/link', 'GET /ring/authorize']) {
      expect(limits.get(key)!.rate, key).toBeLessThan(webhook.rate);
    }
  });

  it('applies them to the stage', () => {
    expect(edge).toMatch(/dynamic "route_settings" \{\s*for_each = local\.edge_route_limits/);
  });
});

describe('what an anonymous visitor can spend', () => {
  it('caps how far the server may scale, and runs it under its own scaling configuration', () => {
    const mcp = read('mcp.tf');
    expect(mcp).toMatch(/resource "aws_apprunner_auto_scaling_configuration_version" "mcp_server" \{[\s\S]*?max_size\s*=\s*var\.mcp_max_instances/);
    expect(mcp).toMatch(/resource "aws_apprunner_service" "mcp_server" \{[\s\S]*?auto_scaling_configuration_arn\s*=\s*aws_apprunner_auto_scaling_configuration_version\.mcp_server\.arn/);
    expect(read('variables.tf')).toMatch(/variable "mcp_max_instances" \{[\s\S]*?default\s*=\s*([1-9]|10)\n/);
  });

  it('brakes the roles that call a model, and only them, when the budget is spent', () => {
    const budget = read('budget.tf');
    expect(budget).toMatch(/resource "aws_budgets_budget_action" "brake"/);
    expect(budget).toMatch(/approval_model\s*=\s*"AUTOMATIC"/);
    expect(budget).toMatch(/notification_type\s*=\s*"ACTUAL"/);
    expect(budget).toMatch(/action_threshold_value\s*=\s*100/);
    const roles = /brake_roles = \{([\s\S]*?)\n  \}/.exec(budget)![1]!;
    expect(roles).toContain('aws_iam_role.apprunner_instance');
    expect(roles).toContain('aws_iam_role.agents_runtime');
    expect(roles).toContain('aws_iam_role.agent_narrator_weekly');
    expect(roles).not.toMatch(/github_deploy|household_link|webhook/);
    const deny = statementsOf(budget, 'spend_brake')[0]!;
    expect(deny.effect).toBe('Deny');
    expect(deny.actions).toEqual(expect.arrayContaining(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:ApplyGuardrail', 'transcribe:StartStreamTranscription']));
    expect(read('variables.tf')).toMatch(/variable "budget_brake" \{[\s\S]*?default\s*=\s*true/);
  });

  it('may be passed to Budgets, and is allowed to attach nothing else', () => {
    const budget = read('budget.tf');
    const attach = statementsOf(budget, 'budget_brake')[0]!;
    expect([...attach.actions].sort()).toEqual(['iam:AttachRolePolicy', 'iam:DetachRolePolicy']);
    expect(budget).toMatch(/variable\s*=\s*"iam:PolicyARN"/);
  });
});
