import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_STATUS_WARNINGS,
  circleVerdict,
  countRegisteredTools,
  exportVerdict,
  featuresIn,
  FEATURE_MARKERS,
  missingSecurityHeaders,
  protectedResourceVerdict,
  secretsInExport,
  siteVerdict,
  televisionPageVerdict,
  statusVerdict,
  toolCountVerdict,
  toolSources,
} from '../smoke/checks.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SECURE = new Headers({
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

describe('the security headers on a site', () => {
  it('passes a site that sends all four', () => {
    expect(missingSecurityHeaders(SECURE)).toEqual([]);
    expect(siteVerdict('family app', 200, SECURE, true).map((r) => r.outcome)).toEqual(['pass', 'pass']);
  });

  it('takes frame-ancestors none as frame denial without X-Frame-Options', () => {
    const headers = new Headers(SECURE);
    headers.delete('x-frame-options');
    expect(missingSecurityHeaders(headers)).toEqual([]);
  });

  it('says "not deployed yet" when none is sent and the checkout does not have #70', () => {
    const [, headers] = siteVerdict('family app', 200, new Headers(), false);
    expect(headers).toMatchObject({ outcome: 'skip', detail: 'none sent: not deployed yet (#70)' });
  });

  it('fails a site with none once the checkout has #70', () => {
    const [, headers] = siteVerdict('family app', 200, new Headers(), true);
    expect(headers?.outcome).toBe('fail');
  });

  it('fails a site with some but not all, whether or not #70 is in the checkout', () => {
    const headers = new Headers(SECURE);
    headers.delete('strict-transport-security');
    headers.set('x-content-type-options', 'sniff');
    const [, verdict] = siteVerdict('family app', 200, headers, false);
    expect(verdict).toMatchObject({ outcome: 'fail', detail: 'missing Strict-Transport-Security, X-Content-Type-Options: nosniff' });
  });

  it('fails HSTS with a max-age of zero, which turns it off', () => {
    const headers = new Headers(SECURE);
    headers.set('strict-transport-security', 'max-age=0');
    expect(missingSecurityHeaders(headers)).toEqual(['Strict-Transport-Security']);
  });

  it('fails a site that does not answer 200', () => {
    expect(siteVerdict('family app', 403, SECURE, true)[0]).toMatchObject({ outcome: 'fail', detail: 'answered 403; 200 is required' });
  });
});

describe('the status API', () => {
  const row = (id: string, status: string, detail = '') => ({ id, status, detail });
  const page = (...checks: ReturnType<typeof row>[]) => ({ checks, summary: { healthy: !checks.some((c) => c.status === 'fail') } });

  it('passes a healthy page whose only warnings are known ones', () => {
    const verdict = statusVerdict(page(row('mcpServer', 'ok'), row('ringLink', 'warn', 'Playground token ran out'), row('doorEvents', 'info')));
    expect(verdict).toMatchObject({ outcome: 'pass', detail: 'healthy, 1 ok; known warnings: ringLink' });
  });

  it('fails a warning it does not know, with what the page said', () => {
    const verdict = statusVerdict(page(row('mcpServer', 'ok'), row('ringOperatorLink', 'warn', 'On')));
    expect(verdict).toMatchObject({ outcome: 'fail', detail: 'a warning that is not a known one: ringOperatorLink (On)' });
  });

  it('does not accept the dead-letter queue being unreadable or the operator link left on', () => {
    expect(Object.keys(ACCEPTED_STATUS_WARNINGS)).toEqual(['ringLink']);
  });

  it('fails any failed row, even one that is otherwise known', () => {
    const verdict = statusVerdict(page(row('ringLink', 'fail', 'No Ring link')));
    expect(verdict).toMatchObject({ outcome: 'fail', detail: 'not healthy: ringLink (No Ring link)' });
  });

  it('fails a page that says it is not healthy, and one that is not a status page', () => {
    expect(statusVerdict({ checks: [], summary: { healthy: false } }).outcome).toBe('fail');
    expect(statusVerdict({ message: 'Internal Server Error' }).outcome).toBe('fail');
    expect(statusVerdict(null).outcome).toBe('fail');
  });
});

describe('protected resource metadata', () => {
  it('passes one with a resource and an authorization server', () => {
    expect(protectedResourceVerdict(200, { resource: 'https://wick.test/', authorization_servers: ['https://wick.test/'] }).outcome).toBe('pass');
  });

  it('fails a missing document, and one that names no authorization server', () => {
    expect(protectedResourceVerdict(404, undefined).outcome).toBe('fail');
    expect(protectedResourceVerdict(200, { resource: 'https://wick.test/', authorization_servers: [] }).outcome).toBe('fail');
  });
});

describe('the tool count', () => {
  it('counts one registerTool( per tool, in every file it is given', () => {
    expect(countRegisteredTools(['mcpServer.registerTool(\n  "a"', 'server.registerTool("b"); server.registerTool("c")', 'nothing here'])).toBe(3);
  });

  it('finds the tools this checkout registers', () => {
    expect(countRegisteredTools(toolSources(ROOT))).toBeGreaterThan(0);
  });

  it('fails a server that lists another number than the checkout registers', () => {
    expect(toolCountVerdict(22, 22).outcome).toBe('pass');
    expect(toolCountVerdict(21, 22)).toMatchObject({ outcome: 'fail', detail: '21 tools listed; the checkout registers 22' });
  });
});

describe('her television, alone, on the virtual television’s site', () => {
  const URL_ = 'https://tv.wick.test/tv.html';

  it('passes the page with 200 and the four headers', () => {
    expect(televisionPageVerdict(URL_, 200, SECURE, true, true).map((r) => r.outcome)).toEqual(['pass', 'pass']);
  });

  it('says it is not deployed yet while the checkout does not hold it and the site does not have it', () => {
    const [verdict] = televisionPageVerdict(URL_, 403, new Headers(), false, true);
    expect(verdict).toMatchObject({ outcome: 'skip' });
    expect(verdict!.detail).toMatch(/not deployed yet/);
  });

  it('fails it once the checkout holds it and the site answers anything but 200, or without the headers', () => {
    expect(televisionPageVerdict(URL_, 403, SECURE, true, true)[0]!.outcome).toBe('fail');
    expect(televisionPageVerdict(URL_, 200, new Headers(), true, true)[1]!.outcome).toBe('fail');
  });

  it('checks it whenever the site already has it, even before the checkout does', () => {
    expect(televisionPageVerdict(URL_, 200, new Headers(), false, true)[1]!.outcome).toBe('fail');
  });
});

describe('which features the checkout holds', () => {
  it('turns a check on by the file its pull request adds', () => {
    const present = new Set([`/repo/${FEATURE_MARKERS.securityHeaders}`]);
    expect(featuresIn('/repo', (path) => present.has(path))).toEqual({ securityHeaders: true, accountData: false, televisionRef: false, browserTelevision: false, statusPrivate: false });
  });
});

describe('a person\'s exported data', () => {
  /** The shape #70's export has (services/mcp-server/src/accounts/myData.ts MyDataExport). */
  const EXPORT = {
    format: 'wick-my-data/1',
    exportedAt: '2026-10-14T10:00:00.000Z',
    about: 'Everything Wick holds about you. Your password is not here: Amazon Cognito keeps it, and Wick never stored it.',
    account: { name: 'Sarah', email: null, guest: true, createdAt: '2026-10-14T09:59:00.000Z' },
    circles: [{ home: 'Demo home', residentName: 'Margaret', simulated: true, nameInTheCircle: 'Sarah', role: 'organiser', status: 'pending', askedAt: '2026-10-14T09:59:00.000Z' }],
    invitationsSent: [],
    notesSent: [],
    picturesSent: [],
    ownTelevisions: [],
    browsersToNudge: [{ pushService: 'https://fcm.googleapis.com', savedAt: '2026-10-14T10:00:00.000Z' }],
    linkedApps: [
      { app: 'the Wick live smoke test', token: 'access', home: 'Demo home', expiresAt: '2026-10-14T11:00:00.000Z' },
      { app: 'the Wick live smoke test', token: 'refresh', expiresAt: '2026-11-13T10:00:00.000Z' },
    ],
    signIns: [{ expiresAt: '2026-10-14T22:00:00.000Z' }],
  };

  it('passes the export as #70 writes it: `token` says only which kind of token an app holds', () => {
    expect(secretsInExport(EXPORT, ['access-token-value-AAAAAAAAAAAAAAAAAAAAAA'])).toEqual([]);
    expect(exportVerdict(200, JSON.stringify(EXPORT), [], true)).toMatchObject({ outcome: 'pass' });
  });

  it('fails a token, a secret, a code or a hash, under any key', () => {
    const leaky = {
      ...EXPORT,
      linkedApps: [{ app: 'x', token: 'k8Jd0-2kdQ9vX3mZpL7wqT4yR1nB6cF5' }],
      invitationsSent: [{ home: 'Demo home', code: 'ABC123' }],
      account: { ...EXPORT.account, refreshToken: 'r' },
      signIns: [{ sessionSecret: 's' }],
    };
    expect(secretsInExport(leaky)).toEqual([
      '$.account.refreshToken is a credential\'s field',
      '$.invitationsSent[0].code is a credential\'s field',
      '$.linkedApps[0].token is not just the kind of token',
      '$.signIns[0].sessionSecret is a credential\'s field',
    ]);
  });

  it('fails the guest\'s own token anywhere in the file, and anything shaped like a token', () => {
    expect(secretsInExport({ note: 'here it is: abc.def' }, ['abc.def'])).toEqual(['$.note holds one of the guest\'s own tokens']);
    expect(secretsInExport({ id: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig' })).toEqual(['$.id looks like a token or a code']);
  });

  it('says "not deployed yet" for a 404 until the checkout has #70, then fails it', () => {
    expect(exportVerdict(404, 'Cannot GET', [], false)).toMatchObject({ outcome: 'skip', detail: '404: not deployed yet (#70)' });
    expect(exportVerdict(404, 'Cannot GET', [], true).outcome).toBe('fail');
  });

  it('fails a 200 that is not JSON', () => {
    expect(exportVerdict(200, '<html>', [], true)).toMatchObject({ outcome: 'fail', detail: 'answered 200 with something that is not JSON' });
  });
});

describe('the circle names televisions by ref (#68)', () => {
  it('passes televisions that each have a ref and no device id', () => {
    const circle = { televisions: [{ ref: 'r1', pairedAt: 1 }], familyTelevisions: [{ ref: 'r2', name: 'Sarah' }] };
    expect(circleVerdict(200, circle, true)).toMatchObject({ outcome: 'pass', detail: '2 television(s), each by ref' });
  });

  it('fails a device id anywhere in the circle, and a television with no ref', () => {
    expect(circleVerdict(200, { televisions: [{ deviceId: 'wick-tv', ref: 'r1' }] }, true)).toMatchObject({ outcome: 'fail', detail: 'GET /api/circle holds 1 device id' });
    expect(circleVerdict(200, { televisions: [{ pairedAt: 1 }] }, true)).toMatchObject({ outcome: 'fail', detail: '1 television with no ref' });
  });

  it('is not asked until the checkout has #68', () => {
    expect(circleVerdict(0, undefined, false)).toMatchObject({ outcome: 'skip', detail: 'not deployed yet (#68)' });
  });
});
