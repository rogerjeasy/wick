/**
 * Your own account, in the family app: the file of everything Wick holds
 * about you, and deleting the account. What is said and shown is decided
 * here, without a browser (__tests__/account.test.ts); main.js puts it on the
 * page and asks the server (services/mcp-server/src/accounts/myData.ts).
 *
 * And signing out, which ends more than this page's memory: the two tokens
 * the app holds are revoked at the server, and the server's own sign-in
 * cookie is cleared (`signOutAddress`).
 */

/**
 * Said to mean this, and only this: "my account", "delete my account",
 * "download my data". The whole of what was said — a note that mentions an
 * account is still a note.
 */
export function isAboutMyAccount(text) {
  const t = (text ?? '').trim().toLowerCase().replace(/[.!?]+$/, '');
  return /^(?:(?:open|show|see) )?my (?:wick )?account$|^(?:delete|close|remove) (?:my )?(?:wick )?account$|^(?:download|export|get) (?:a copy of )?(?:all )?my (?:wick )?data$/.test(t);
}

/** The card the "Account" button and "my account" open. */
export function presentAccount(me) {
  const guest = me?.user?.guest === true;
  return {
    say: guest
      ? 'This is a guest account, with a demo home of its own. You can keep a copy of what it holds, or delete it now.'
      : 'This is your Wick account. You can keep a copy of everything Wick holds about you, or delete the account.',
    title: 'Your account',
    rows: guest
      ? [{ primary: 'A guest account', secondary: 'No email and no password' }]
      : [
          { primary: me?.user?.name ?? '', secondary: me?.user?.email ?? '' },
        ],
    download: 'Download my data',
    remove: 'Delete my account',
    footnote: 'The file holds no password, code or token. Wick never kept your password.',
  };
}

/** A file's name, as the server gave it, or one of the same shape. */
export function exportFileName(contentDisposition, now = Date.now()) {
  const named = /filename="([\w.-]+\.json)"/.exec(contentDisposition ?? '');
  return named ? named[1] : `wick-my-data-${new Date(now).toISOString().slice(0, 10)}.json`;
}

export const EXPORT_SAID = 'Your data is downloading as a JSON file. It holds what Wick keeps about you, and nothing that lets anybody in.';

const others = (n) => (n === 1 ? 'one other person loses their place in its circle' : `${n} other people lose their place in its circle`);

/**
 * The question before an account is deleted, naming everything that goes.
 * A home the person set up is closed with it — a home is never left without
 * the person who set it up (myData.ts) — and the button says so.
 */
export function presentDeletion(plan, me) {
  const homes = Array.isArray(plan?.homes) ? plan.homes : [];
  const closing = homes.filter((h) => h.closes);
  const leaving = homes.filter((h) => !h.closes);
  const goes = [
    plan?.guest ? 'Your guest account.' : `Your account: your name${me?.user?.email ? ` and ${me.user.email}` : ''}, and your password at Amazon Cognito.`,
    'Every sign-in and every linked app, on every device, and the browsers that asked to be told.',
  ];
  for (const home of leaving) {
    goes.push(`Your place in the circle of ${home.name}, the visits you said you would make, and any television you connected there as your own.`);
  }
  for (const home of closing) {
    const parts = [
      `${home.residentName}’s television is disconnected and shows its pairing code again`,
      ...(home.others > 0 ? [others(home.others)] : []),
      'its doorbell is disconnected',
      home.simulated
        ? 'everything Wick holds about it, its simulated history included, is deleted'
        : 'its notes, pictures, weeks and everything else Wick holds about it are deleted',
    ];
    goes.push(`${home.name}, which you set up, is closed: ${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`);
  }
  const names = closing.map((h) => h.name);
  const closes = names.length === 0 ? '' : names.length === 1 ? names[0] : 'your homes';
  return {
    title: 'Delete your Wick account?',
    lead: 'This goes, and cannot be brought back:',
    goes,
    stays: leaving.length > 0 ? 'A note or a picture you sent to a home you did not set up stays with that home: it was given to the person who lives there.' : '',
    password: plan?.needsPassword === true,
    passwordLabel: 'Your password, to confirm it is you',
    closeHomes: closing.length > 0,
    confirm: closing.length > 0 ? `Close ${closes} and delete my account` : 'Delete my account',
    cancel: 'Keep my account',
    footnote: 'Wick’s backups keep a deleted account for 35 days, and then it is gone from them too.',
  };
}

export const DELETED_SAID = 'Your Wick account is deleted, and this browser is signed out.';

/**
 * Where the browser goes last when signing out: the Wick server forgets its
 * own sign-in cookie there, and sends the browser back to this page — only
 * to an address this app registered (accountRouter.ts).
 */
export function signOutAddress(serverUrl, clientId, here) {
  const url = new URL(`${serverUrl.replace(/\/$/, '')}/account/sign-out`);
  if (clientId) url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', here);
  return url.toString();
}

/** The form body that revokes one token (RFC 7009), for this public client. */
export function revocationBody(token, hint, clientId) {
  return new URLSearchParams({ token, token_type_hint: hint, client_id: clientId });
}
