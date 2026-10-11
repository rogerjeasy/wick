import { describe, expect, it } from 'vitest';
import { PUSH_KINDS, isPushKind, isPushServiceUrl } from '../push.js';

describe('isPushServiceUrl — where Wick is willing to send a nudge', () => {
  it('accepts the browsers’ own push services', () => {
    for (const url of [
      'https://fcm.googleapis.com/fcm/send/abc123',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://web.push.apple.com/QGk3',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      expect(isPushServiceUrl(url), url).toBe(true);
    }
  });

  it('refuses anything else: the address comes from a browser, and Wick’s own functions will call it', () => {
    for (const url of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/x',
      'https://evil.example/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.example/x',
      'https://user:pass@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'not a url',
      '',
    ]) {
      expect(isPushServiceUrl(url), url).toBe(false);
    }
    expect(isPushServiceUrl(undefined)).toBe(false);
  });
});

describe('isPushKind', () => {
  it('knows the kinds Wick sends and no others', () => {
    expect(isPushKind(PUSH_KINDS.doorLook)).toBe(true);
    expect(isPushKind('anything_else')).toBe(false);
    expect(isPushKind(undefined)).toBe(false);
  });
});
