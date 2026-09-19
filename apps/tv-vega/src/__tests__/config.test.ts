import { describe, expect, it } from 'vitest';
import { resolveDeviceConfig } from '../config.js';

describe('resolveDeviceConfig', () => {
  it('throws when pairingApiUrl, websocketUrl or householdId is missing', () => {
    expect(() => resolveDeviceConfig({})).toThrow(/not populated/);
    expect(() => resolveDeviceConfig({ pairingApiUrl: 'https://a' })).toThrow(/not populated/);
    expect(() =>
      resolveDeviceConfig({ pairingApiUrl: 'https://a', websocketUrl: 'wss://b' }),
    ).toThrow(/not populated/);
  });

  it('returns the config when all required fields are present', () => {
    const config = resolveDeviceConfig({
      pairingApiUrl: 'https://pair.example',
      websocketUrl: 'wss://ws.example/prod',
      householdId: 'margaret',
    });
    expect(config).toEqual({
      pairingApiUrl: 'https://pair.example',
      websocketUrl: 'wss://ws.example/prod',
      householdId: 'margaret',
    });
  });

  it('carries mqttWssUrl through only when present', () => {
    const config = resolveDeviceConfig({
      pairingApiUrl: 'https://pair.example',
      websocketUrl: 'wss://ws.example/prod',
      householdId: 'margaret',
      mqttWssUrl: 'wss://iot.example/mqtt',
    });
    expect(config.mqttWssUrl).toBe('wss://iot.example/mqtt');
  });
});
