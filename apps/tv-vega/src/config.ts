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
  /** MQTT over IoT Core (infra/iot.tf), tried before the WebSocket. Absent, MQTT is never tried. */
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
 *
 * No household: the television is told whose it is when the organiser
 * connects it, in the token it is handed (INV-8, ./deviceId.ts).
 */
const DEPLOYED: Partial<DeviceConfig> = {
  pairingApiUrl: 'https://aplt2e6673.execute-api.us-east-1.amazonaws.com',
  websocketUrl: 'wss://2ozlpzh5da.execute-api.us-east-1.amazonaws.com/prod',
  // `terraform output mqtt_wss_url` (infra/iot.tf): the IoT Core endpoint with
  // the custom authorizer named. The television adds its own device token
  // (transport/MqttChannel.ts). It is tried first; the WebSocket above is what
  // the app falls back to, and what the background card service always uses.
  mqttWssUrl: 'wss://a3mcxw8j3fftbo-ats.iot.us-east-1.amazonaws.com/mqtt?x-amz-customauthorizer-name=wick-device',
};

export function loadDeviceConfig(): DeviceConfig {
  return resolveDeviceConfig(DEPLOYED);
}
