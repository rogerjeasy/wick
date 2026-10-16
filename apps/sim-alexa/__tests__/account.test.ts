import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error — a plain browser module, deliberately untyped (no build step).
import { DELETED_SAID, exportFileName, isAboutMyAccount, presentAccount, presentDeletion, revocationBody, signOutAddress } from '../account.js';

const SARAH = { user: { userId: 'u1', name: 'Sarah', email: 'sarah@example.com', guest: false }, household: { residentName: 'Margaret' } };
const GUEST = { user: { userId: 'guest_1', name: 'Sarah', email: '', guest: true }, household: { residentName: 'Margaret' } };

describe('what is about one’s own account', () => {
  it.each(['my account', 'Delete my account', 'download my data', 'Close my Wick account', 'export my data'])('hears “%s”', (said) => {
    expect(isAboutMyAccount(said)).toBe(true);
  });

  it.each(['Did anyone come to the door?', 'invite Tom to the circle', 'send Mum a note about my data plan for Saturday', 'tell her I will delete my account on Facebook'])(
    'leaves “%s” to the rest',
    (said) => {
      // A note that happens to mention an account or data is a note.
      expect(isAboutMyAccount(said)).toBe(false);
    },
  );
});

describe('the account card', () => {
  it('names the person and offers the two things', () => {
    const card = presentAccount(SARAH);
    expect(card.rows).toEqual([{ primary: 'Sarah', secondary: 'sarah@example.com' }]);
    expect(card.download).toBe('Download my data');
    expect(card.remove).toBe('Delete my account');
  });

  it('says a guest account is one', () => {
    expect(presentAccount(GUEST).say).toMatch(/guest account/);
    expect(presentAccount(GUEST).rows[0].primary).toBe('A guest account');
  });

  it('keeps the server’s name for the file, or makes one of the same shape', () => {
    expect(exportFileName('attachment; filename="wick-my-data-2026-10-14.json"')).toBe('wick-my-data-2026-10-14.json');
    expect(exportFileName(null, Date.UTC(2026, 9, 14))).toBe('wick-my-data-2026-10-14.json');
    // Nothing that is not a plain name is taken from a header.
    expect(exportFileName('attachment; filename="../../evil.sh"', Date.UTC(2026, 9, 14))).toBe('wick-my-data-2026-10-14.json');
  });
});

describe('the question before an account is deleted', () => {
  it('names what goes for a member, what stays with the home, and asks for the password', () => {
    const view = presentDeletion({ guest: false, needsPassword: true, homes: [{ name: 'Margaret’s home', residentName: 'Margaret', closes: false, others: 0 }] }, SARAH);
    expect(view.goes[0]).toContain('sarah@example.com');
    expect(view.goes).toContainEqual(expect.stringContaining('Your place in the circle of Margaret’s home'));
    expect(view.stays).toMatch(/stays with that home/);
    expect(view.password).toBe(true);
    expect(view.closeHomes).toBe(false);
    expect(view.confirm).toBe('Delete my account');
  });

  it('says plainly that a home the person set up is closed, and what that does to her television and the others', () => {
    const view = presentDeletion({ guest: false, needsPassword: true, homes: [{ name: 'Margaret’s home', residentName: 'Margaret', closes: true, others: 2 }] }, SARAH);
    const closing = view.goes.find((line: string) => line.startsWith('Margaret’s home, which you set up, is closed'));
    expect(closing).toContain('Margaret’s television is disconnected and shows its pairing code again');
    expect(closing).toContain('2 other people lose their place in its circle');
    expect(closing).toContain('its doorbell is disconnected');
    expect(view.closeHomes).toBe(true);
    expect(view.confirm).toBe('Close Margaret’s home and delete my account');
    expect(view.cancel).toBe('Keep my account');
    expect(view.stays).toBe('');
  });

  it('asks a guest for no password, and says the demo home’s simulated history goes too', () => {
    const view = presentDeletion({ guest: true, needsPassword: false, homes: [{ name: 'Demo home', residentName: 'Margaret', closes: true, others: 0, simulated: true }] }, GUEST);
    expect(view.password).toBe(false);
    expect(view.goes[0]).toBe('Your guest account.');
    expect(view.goes.join(' ')).toContain('simulated history');
    expect(view.goes.join(' ')).not.toContain('other people');
  });

  it('says it is done', () => {
    expect(DELETED_SAID).toMatch(/deleted/);
  });
});

describe('signing out', () => {
  it('ends at the server’s own sign-out, which sends the browser back here', () => {
    const url = new URL(signOutAddress('https://wick.example/', 'client-1', 'https://app.example/'));
    expect(url.origin + url.pathname).toBe('https://wick.example/account/sign-out');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/');
  });

  it('revokes a token as the public client it was issued to', () => {
    expect(Object.fromEntries(revocationBody('tok', 'refresh_token', 'client-1'))).toEqual({ token: 'tok', token_type_hint: 'refresh_token', client_id: 'client-1' });
  });

  it('is wired so: both tokens revoked, then the server’s sign-out, from the Sign out button', () => {
    const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
    const handler = main.slice(main.indexOf("$('sign-out').addEventListener"));
    expect(handler.indexOf('await revokeTokens(')).toBeGreaterThan(0);
    expect(handler.indexOf('await revokeTokens(')).toBeLessThan(handler.indexOf('signOutAddress('));
  });
});
