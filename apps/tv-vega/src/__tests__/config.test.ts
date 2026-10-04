import { describe, expect, it } from 'vitest';
import { resolveDeviceConfig } from '../config.js';

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
