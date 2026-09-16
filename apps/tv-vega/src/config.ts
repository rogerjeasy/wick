/**
 * Deployed endpoint configuration — the Vega equivalent of the "paste into
 * Ring console" fields in infra/outputs.tf. Populate DEPLOYED after
 * `terraform apply` against infra/pairing.tf and infra/transport.tf. There is
 * no default: a device silently pointed at nothing is worse than one that
 * fails to boot with a clear message.
 */
export interface DeviceConfig {
  readonly pairingApiUrl: string;
  readonly websocketUrl: string;
  /** Absent until infra/transport.tf's IoT Core stack exists — SP-5, see FRICTION.md. */
  readonly mqttWssUrl?: string;
}

export function resolveDeviceConfig(partial: Partial<DeviceConfig>): DeviceConfig {
  const { pairingApiUrl, websocketUrl, mqttWssUrl } = partial;
  if (!pairingApiUrl || !websocketUrl) {
    throw new Error(
      'apps/tv-vega/src/config.ts is not populated. Run `terraform output` in infra/ ' +
        'after applying pairing.tf and transport.tf, and fill in DEPLOYED below.',
    );
  }
  return { pairingApiUrl, websocketUrl, ...(mqttWssUrl ? { mqttWssUrl } : {}) };
}

/**
 * Fill these in from `terraform output` once infra/pairing.tf and
 * infra/transport.tf are applied. Left blank deliberately — see the header
 * comment above.
 */
const DEPLOYED: Partial<DeviceConfig> = {
  // pairingApiUrl: 'https://xxxx.execute-api.us-east-1.amazonaws.com',
  // websocketUrl: 'wss://yyyy.execute-api.us-east-1.amazonaws.com/prod',
};

export function loadDeviceConfig(): DeviceConfig {
  return resolveDeviceConfig(DEPLOYED);
}
