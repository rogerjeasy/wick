/**
 * The sign-in pages, as plain HTML strings.
 *
 * These are the pages an assistant's account-linking opens, so they work
 * with no JavaScript at all: forms that post, and pages that come back.
 * Every value a person typed is escaped on its way into a page (`esc`),
 * and nothing is written that the person did not need to read.
 */
import type { MemberStatus } from '@wick/contracts';

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const STYLE = `
  :root{--ground:#12100E;--raised:#1E1B17;--field:#26221D;--line:#3A342C;--ink:#F4F1EA;--ink-dim:#C8C2B6;--accent:#E8B75D;--accent-ink:#1A1408;--warn:#F0B8A8}
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  main{max-width:27rem;margin:0 auto;padding:3rem 1.25rem 4rem}
  .mark{display:flex;align-items:center;gap:.6rem;font-family:Georgia,serif;font-size:1.25rem;margin-bottom:2rem}
  .mark svg{width:1rem;height:1.4rem}
  h1{font-family:Georgia,serif;font-size:1.7rem;line-height:1.25;margin:0 0 .5rem;font-weight:400}
  .lead{color:var(--ink-dim);margin:0 0 1.5rem}
  form{display:flex;flex-direction:column;gap:1rem;background:var(--raised);border-radius:14px;padding:1.5rem}
  label{display:flex;flex-direction:column;gap:.35rem;font-size:.95rem;color:var(--ink-dim)}
  input[type=text],input[type=email],input[type=password]{font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:9px;padding:.7rem .8rem;width:100%}
  input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
  button{font:inherit;font-weight:600;border:0;border-radius:9px;padding:.8rem 1.2rem;cursor:pointer;background:var(--accent);color:var(--accent-ink)}
  button.quiet{background:none;color:var(--ink-dim);font-weight:400;text-decoration:underline;padding:.25rem 0;align-self:flex-start}
  button.second{background:none;color:var(--ink);border:1px solid var(--line)}
  form.demo{margin-top:1.25rem;gap:.6rem}
  .hint{font-size:.88rem;color:var(--ink-dim);margin:0}
  .error,.notice{border-radius:9px;padding:.7rem .9rem;margin:0 0 1rem;font-size:.95rem}
  .error{background:#3A211B;color:var(--warn)}
  .notice{background:#22301F;color:#BFE0B8}
  .links{display:flex;flex-wrap:wrap;gap:.4rem 1.25rem;margin-top:1.25rem;font-size:.95rem}
  a{color:var(--accent)}
  .choice{display:flex;align-items:flex-start;gap:.7rem;background:var(--field);border:1px solid var(--line);border-radius:9px;padding:.8rem;color:var(--ink);font-size:1rem;flex-direction:row}
  .choice input{margin-top:.3rem;accent-color:var(--accent)}
  .choice small{display:block;color:var(--ink-dim)}
  .who{display:flex;justify-content:space-between;align-items:center;gap:1rem;color:var(--ink-dim);font-size:.9rem;margin-top:1.25rem}
  .who form{background:none;padding:0;display:inline}
  ul.plain{margin:0;padding-left:1.1rem;color:var(--ink-dim);font-size:.95rem}
`;

const FLAME =
  '<svg viewBox="0 0 16 22" aria-hidden="true"><path d="M8 0c3 5 7 8 7 13a7 7 0 0 1-14 0C1 8 5 5 8 0z" fill="#e8b75d"/><path d="M8 9c1.5 2.5 3 4 3 6a3 3 0 0 1-6 0c0-2 1.500-3.500 3-6z" fill="#f4dfb4"/></svg>';

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>${esc(title)} — Wick</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="mark">${FLAME}<span>Wick</span></div>
${body}
</main>
</body>
</html>`;
}

const hidden = (name: string, value: string): string => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const message = (kind: 'error' | 'notice', text: string | undefined): string =>
  text ? `<p class="${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(text)}</p>` : '';
const link = (tx: string, view: string, text: string): string =>
  `<a href="/account?tx=${encodeURIComponent(tx)}${view ? `&amp;view=${view}` : ''}">${esc(text)}</a>`;

export interface PageMessage {
  readonly error?: string | undefined;
  readonly notice?: string | undefined;
}

export function signInPage(p: { tx: string; email?: string | undefined; demo?: boolean | undefined } & PageMessage): string {
  return layout('Sign in', `
<h1>Sign in to Wick</h1>
<p class="lead">Use the email and password you chose for Wick.</p>
${message('notice', p.notice)}${message('error', p.error)}
<form method="post" action="/account/sign-in">
  ${hidden('tx', p.tx)}
  <label>Email <input type="email" name="email" value="${esc(p.email ?? '')}" autocomplete="email" required autofocus></label>
  <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
</form>
<div class="links">${link(p.tx, 'sign-up', 'Create an account')}${link(p.tx, 'forgot', 'Forgot your password?')}</div>
${p.demo ? `<form class="demo" method="post" action="/account/demo">
  ${hidden('tx', p.tx)}
  <button class="second" type="submit">Try the demo</button>
  <p class="hint">No email and no password. You get a guest account and a demo home of your own.</p>
</form>` : ''}`);
}

export function demoBusyPage(tx: string): string {
  return layout('The demo is busy', `
<h1>The demo is busy</h1>
<p class="lead">A lot of people tried it in the last hour. Come back a little later, or create an account now: it takes a minute.</p>
<div class="links">${link(tx, 'sign-up', 'Create an account')}${link(tx, '', 'Sign in')}</div>`);
}

export function signUpPage(p: { tx: string; name?: string | undefined; email?: string | undefined } & PageMessage): string {
  return layout('Create an account', `
<h1>Create your Wick account</h1>
<p class="lead">One account for you. The person at home never needs one.</p>
${message('error', p.error)}
<form method="post" action="/account/sign-up">
  ${hidden('tx', p.tx)}
  <label>Your name <input type="text" name="name" value="${esc(p.name ?? '')}" autocomplete="name" maxlength="40" required autofocus></label>
  <p class="hint">This is the name shown on their television, so use the one they call you.</p>
  <label>Email <input type="email" name="email" value="${esc(p.email ?? '')}" autocomplete="email" required></label>
  <label>Password <input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
  <p class="hint">8 characters or more.</p>
  <button type="submit">Create account</button>
</form>
<div class="links">${link(p.tx, '', 'I already have an account')}</div>`);
}

export function verifyPage(p: { tx: string; email: string } & PageMessage): string {
  return layout('Confirm your email', `
<h1>Check your email</h1>
<p class="lead">We sent a code to ${esc(p.email)}. Enter it here to confirm the address is yours.</p>
${message('notice', p.notice)}${message('error', p.error)}
<form method="post" action="/account/verify">
  ${hidden('tx', p.tx)}${hidden('email', p.email)}
  <label>Code <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></label>
  <button type="submit">Confirm</button>
</form>
<form method="post" action="/account/resend" style="background:none;padding:.75rem 0 0">
  ${hidden('tx', p.tx)}${hidden('email', p.email)}
  <button class="quiet" type="submit">Send the code again</button>
</form>`);
}

export function forgotPage(p: { tx: string; email?: string | undefined } & PageMessage): string {
  return layout('Reset your password', `
<h1>Reset your password</h1>
<p class="lead">Enter your email and we will send you a code.</p>
${message('error', p.error)}
<form method="post" action="/account/forgot">
  ${hidden('tx', p.tx)}
  <label>Email <input type="email" name="email" value="${esc(p.email ?? '')}" autocomplete="email" required autofocus></label>
  <button type="submit">Send a code</button>
</form>
<div class="links">${link(p.tx, '', 'Back to sign in')}</div>`);
}

export function resetPage(p: { tx: string; email: string } & PageMessage): string {
  return layout('Choose a new password', `
<h1>Choose a new password</h1>
<p class="lead">If ${esc(p.email)} has a Wick account, a code is on its way. Enter it with your new password.</p>
${message('error', p.error)}
<form method="post" action="/account/reset">
  ${hidden('tx', p.tx)}${hidden('email', p.email)}
  <label>Code <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></label>
  <label>New password <input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
  <p class="hint">8 characters or more.</p>
  <button type="submit">Change password</button>
</form>
<div class="links">${link(p.tx, '', 'Back to sign in')}</div>`);
}

function signedInAs(tx: string, name: string): string {
  return `<div class="who"><span>Signed in as ${esc(name)}</span>
<form method="post" action="/account/sign-out">${hidden('tx', tx)}<button class="quiet" type="submit">Sign out</button></form></div>`;
}

export function householdPage(p: { tx: string; userName: string; canGoBack: boolean; timeZone?: string | undefined } & PageMessage): string {
  return layout('Set up a home', `
<h1>Who is this for?</h1>
<p class="lead">Wick is set up around one person at home. Tell us what you call them.</p>
${message('error', p.error)}
<form method="post" action="/account/household">
  ${hidden('tx', p.tx)}
  <label>Their name <input type="text" name="residentName" placeholder="Margaret" maxlength="40" required autofocus></label>
  <p class="hint">Use the name they go by. It appears in what Wick tells you: “Margaret hasn’t allowed this yet.”</p>
  <label>Their time zone <input type="text" name="timeZone" value="${esc(p.timeZone ?? '')}" placeholder="America/New_York" maxlength="64" required autocomplete="off" spellcheck="false"></label>
  <p class="hint">Where they live, not where you are. Their days, visits and week are kept on this clock. This browser’s is filled in.</p>
  <button type="submit">Continue</button>
</form>
<ul class="plain" style="margin-top:1.25rem">
  <li>Next you will connect their television with a 6-digit code.</li>
  <li>They will be asked, on that television, whether to allow you.</li>
</ul>
${p.canGoBack ? `<div class="links">${link(p.tx, '', 'Back')}</div>` : ''}
${signedInAs(p.tx, p.userName)}`);
}

export function joinPage(p: { tx: string; userName: string; invitedByName: string; householdName: string; residentName: string }): string {
  return layout('Join a family circle', `
<h1>${esc(p.invitedByName)} has invited you to ${esc(p.householdName)}</h1>
<p class="lead">If you join, ${esc(p.residentName)} will be asked on the television whether to allow you. Until then you will not see anything.</p>
<form method="post" action="/account/join">
  ${hidden('tx', p.tx)}
  <button type="submit">Ask to join</button>
</form>
${signedInAs(p.tx, p.userName)}`);
}

const STATUS_WORDS: Readonly<Record<MemberStatus, (resident: string) => string>> = {
  allowed: (r) => `${r} has allowed you`,
  pending: (r) => `Waiting for ${r} to allow you`,
  declined: (r) => `${r} chose not to share with you`,
  removed: () => 'You are no longer in this circle',
};

export interface ConsentHousehold {
  readonly householdId: string;
  readonly name: string;
  readonly residentName: string;
  readonly status: MemberStatus;
}

export function consentPage(p: {
  tx: string;
  userName: string;
  clientName: string;
  households: readonly ConsentHousehold[];
  selected?: string | undefined;
} & PageMessage): string {
  const selected = p.selected ?? p.households[0]?.householdId;
  const choices = p.households
    .map(
      (h) => `<label class="choice"><input type="radio" name="householdId" value="${esc(h.householdId)}"${h.householdId === selected ? ' checked' : ''} required>
  <span>${esc(h.name)}<small>${esc(STATUS_WORDS[h.status](h.residentName))}</small></span></label>`,
    )
    .join('\n  ');
  return layout('Approve', `
<h1>Approve ${esc(p.clientName)}?</h1>
<p class="lead">It will be able to ask about this home and send notes to its television, as you. It only ever sees what the person at home has chosen to share.</p>
${message('error', p.error)}
<form method="post" action="/account/approve">
  ${hidden('tx', p.tx)}
  ${choices}
  <button type="submit">Approve</button>
</form>
<div class="links">${link(p.tx, 'new-home', 'Set up another home')}</div>
${signedInAs(p.tx, p.userName)}`);
}

export function expiredPage(): string {
  return layout('Link expired', `
<h1>This sign-in link has expired</h1>
<p class="lead">Go back to the app you came from and start again. Nothing was changed.</p>`);
}

export function refusedPage(text: string): string {
  return layout('Not allowed', `
<h1>That is not something you can do</h1>
<p class="lead">${esc(text)}</p>`);
}

/** Where signing out ends when there is no app to go back to. */
export function signedOutPage(): string {
  return layout('Signed out', `
<h1>You are signed out</h1>
<p class="lead">This browser no longer holds your Wick sign-in. You can close this page.</p>`);
}
