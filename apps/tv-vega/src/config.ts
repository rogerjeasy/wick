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
  /**
   * The Wick server — the family app's and the MCP server's own origin, with
   * no path and no trailing slash. Only a family member's own television
   * asks it anything (`/tv/home`, `/tv/press`: family/familyClient.ts); the
   * resident's never does. Required all the same: a television learns which
   * of the two it is when it is paired, not when it is built.
   */
  readonly wickServerUrl: string;
}

export function resolveDeviceConfig(partial: Partial<DeviceConfig>): DeviceConfig {
  const { pairingApiUrl, websocketUrl, mqttWssUrl, wickServerUrl } = partial;
  if (!pairingApiUrl || !websocketUrl || !wickServerUrl) {
    throw new Error(
      'apps/tv-vega/src/config.ts is not populated. Run `terraform output` in infra/ ' +
        'after applying pairing.tf, transport.tf and mcp.tf, and fill in DEPLOYED below.',
    );
  }
  return { pairingApiUrl, websocketUrl, wickServerUrl: wickServerUrl.replace(/\/+$/, ''), ...(mqttWssUrl ? { mqttWssUrl } : {}) };
}

/**
 * From `terraform output`, for the stack this build talks to.
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
  // `terraform output mcp_server_url` (infra/mcp.tf): the App Runner
  // service that serves the family app. A family member's own television asks
  // it for its home screen, with the device token it was paired with.
  wickServerUrl: 'https://tqcu7pa3ip.us-east-1.awsapprunner.com',
};

export function loadDeviceConfig(): DeviceConfig {
  return resolveDeviceConfig(DEPLOYED);
}
