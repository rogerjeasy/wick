import { describe, expect, it } from 'vitest';
import { loadDeviceConfig, resolveDeviceConfig } from '../config.js';

describe('resolveDeviceConfig', () => {
  it('throws when pairingApiUrl or websocketUrl is missing', () => {
    expect(() => resolveDeviceConfig({})).toThrow(/not populated/);
    expect(() => resolveDeviceConfig({ pairingApiUrl: 'https://a' })).toThrow(/not populated/);
  });

  it('needs no household: a television learns whose it is when it is paired', () => {
    expect(resolveDeviceConfig({ pairingApiUrl: 'https://a', websocketUrl: 'wss://b' })).toEqual({
      pairingApiUrl: 'https://a',
      websocketUrl: 'wss://b',
    });
  });

  it('returns the config when all required fields are present', () => {
    const config = resolveDeviceConfig({
      pairingApiUrl: 'https://pair.example',
      websocketUrl: 'wss://ws.example/prod',
    });
    expect(config).toEqual({
      pairingApiUrl: 'https://pair.example',
      websocketUrl: 'wss://ws.example/prod',
    });
  });

  it('carries mqttWssUrl through only when present', () => {
    const config = resolveDeviceConfig({
      pairingApiUrl: 'https://pair.example',
      websocketUrl: 'wss://ws.example/prod',
      mqttWssUrl: 'wss://iot.example/mqtt',
    });
    expect(config.mqttWssUrl).toBe('wss://iot.example/mqtt');
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
});
