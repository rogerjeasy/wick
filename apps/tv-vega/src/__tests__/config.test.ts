import { describe, expect, it } from 'vitest';
import { loadDeviceConfig, resolveDeviceConfig } from '../config.js';

describe('resolveDeviceConfig', () => {
  it('throws when pairingApiUrl or websocketUrl is missing', () => {
    expect(() => resolveDeviceConfig({})).toThrow(/not populated/);
    expect(() => resolveDeviceConfig({ pairingApiUrl: 'https://a', wickServerUrl: 'https://c' })).toThrow(/not populated/);
  });

  // The same television can be connected as a family member's own, and it
  // only learns which when it is paired — so every build has to know where
  // the Wick server is (family/familyClient.ts).
  it('throws when the Wick server is missing: any television may turn out to be a family member\'s', () => {
    expect(() => resolveDeviceConfig({ pairingApiUrl: 'https://a', websocketUrl: 'wss://b' })).toThrow(/not populated/);
  });

  it('needs no household: a television learns whose it is when it is paired', () => {
    expect(resolveDeviceConfig({ pairingApiUrl: 'https://a', websocketUrl: 'wss://b', wickServerUrl: 'https://c' })).toEqual({
      pairingApiUrl: 'https://a',
      websocketUrl: 'wss://b',
      wickServerUrl: 'https://c',
    });
  });

  it('returns the config when all required fields are present', () => {
    const config = resolveDeviceConfig({
      pairingApiUrl: 'https://pair.example',
      websocketUrl: 'wss://ws.example/prod',
      wickServerUrl: 'https://wick.example',
    });
    expect(config).toEqual({
      pairingApiUrl: 'https://pair.example',
      websocketUrl: 'wss://ws.example/prod',
      wickServerUrl: 'https://wick.example',
    });
  });

  it('carries mqttWssUrl through only when present', () => {
    const config = resolveDeviceConfig({
      pairingApiUrl: 'https://pair.example',
      websocketUrl: 'wss://ws.example/prod',
      wickServerUrl: 'https://wick.example',
      mqttWssUrl: 'wss://iot.example/mqtt',
    });
    expect(config.mqttWssUrl).toBe('wss://iot.example/mqtt');
  });

  it('takes a trailing slash off the Wick server: its paths are added as /tv/home', () => {
    const config = resolveDeviceConfig({ pairingApiUrl: 'https://a', websocketUrl: 'wss://b', wickServerUrl: 'https://wick.example/' });
    expect(config.wickServerUrl).toBe('https://wick.example');
  });
});

describe('loadDeviceConfig — what a television built from this repository connects to', () => {
  const config = loadDeviceConfig();

  it('tries MQTT over IoT Core, naming the authorizer that checks its device token', () => {
    const url = new URL(config.mqttWssUrl!);

    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toMatch(/-ats\.iot\.[a-z0-9-]+\.amazonaws\.com$/);
    expect(url.pathname).toBe('/mqtt');
    expect(url.searchParams.get('x-amz-customauthorizer-name')).toBe('wick-device');
  });

  it('carries no token of its own: the television adds the one it was paired with (INV-1)', () => {
    expect(new URL(config.mqttWssUrl!).searchParams.has('token')).toBe(false);
  });

  it('still has the WebSocket to fall back to', () => {
    expect(config.websocketUrl).toMatch(/^wss:\/\//);
  });

  it('knows the Wick server a family member\'s television asks, over HTTPS and by its origin alone', () => {
    const url = new URL(config.wickServerUrl);

    expect(url.protocol).toBe('https:');
    expect(config.wickServerUrl).toBe(url.origin);
  });
});
