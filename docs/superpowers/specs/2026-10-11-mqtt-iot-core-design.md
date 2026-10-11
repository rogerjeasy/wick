# The MQTT channel over AWS IoT Core — design

**Date:** 2026-10-11 · **Status:** awaiting review
**Item 3 of 4** (add-on package → Fire OS build → MQTT / IoT Core → per-household Ring link).
**Evidence:** "checked today" means read on 2026-10-11 in the repo at `a4ee162`, in the
AWS account behind the `wick-dev` profile, or on the AWS documentation page named.

## 1. What this changes, in one paragraph

A television reaches Wick over an API Gateway WebSocket. The repository also holds a
complete MQTT client (`apps/tv-vega/src/transport/MqttChannel.ts`) with nothing to connect
to: no IoT Core resources, no server code that publishes to it, and a rule in the server
that skips any television marked `mqtt`. After this work a television **tries MQTT over
IoT Core first and falls back to the WebSocket**, exactly as `createDeviceChannel.ts`
already says it should; the server sends a card to whichever channel the television is on;
and what the television sends back arrives at the same handler either way. It is shown
working on the Vega simulator, and on the Android TV emulator once item 2 is in.

## 2. Facts the design rests on

### 2.1 Checked today
- The account has an IoT Core data endpoint (`…-ats.iot.us-east-1.amazonaws.com`) and no
  custom authorizers.
- `MqttChannel.ts` connects with `username: deviceId`, `password: jwt`,
  `clientId: deviceId`, `clean: false`, `reconnectPeriod: 0`, and uses three topics:
  `wick/device/<id>/cards`, `/control` (to the television) and `/events` (from it).
- `createDeviceChannel.ts` tries MQTT when `config.mqtt` is set and falls back to the
  WebSocket on any error or a 4-second timeout. The deployed configuration
  (`config.ts`) has no MQTT address, so MQTT is never tried.
- The background card service never offers MQTT (`startCardChannel.ts:163`), by design.
- `connect.mjs` always records `transport = 'websocket'`. `egress.ts` skips a television
  whose transport is anything else (`egress.ts:132-136`).
- Device events arrive at `services/edge-device/lambda/route.mjs`, which finds the
  television from the WebSocket connection id.
- INV-2: `services/agent/src/egress.ts` is the only module allowed to import a transport
  client; `@aws-sdk/client-iot-data-plane` is already on the lint rule's list.
- The MQTT path has no reconnect after a first successful connection.
- FL-009 records that none of this was ever run on a device.

### 2.2 Read today in AWS's documentation (IoT Core custom authentication)
- Over MQTT-over-WebSocket, credentials go either in the HTTP upgrade request (headers or
  query string) or in the MQTT CONNECT `username`/`password`.
- **"If you pass credentials through the MQTT connect message, the ALPN and SNI TLS
  extensions are required."** A WebSocket opened from JavaScript cannot set ALPN.

So the client as written — the token in the MQTT password — cannot authenticate from a
television. The token has to travel in the upgrade request's query string, which is where
the existing WebSocket channel already puts it (`?token=`).

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | A **custom authorizer** verifies the television's existing device token. No certificates, no Cognito, no new credential on the television. | INV-1: the television holds one device-bound token and nothing else. |
| D2 | The token travels in the WebSocket upgrade's query string, with the authorizer's name. Token signing is off; the token is itself a signed JWT. | §2.2. The WebSocket channel does the same today. |
| D3 | The authorizer's policy lets a television connect as its own id only, subscribe to its own two topics, and publish to its own events topic. It refuses a revoked television. Connections are re-authorised at least every 5 minutes and end with the token. | A token for one television must reach nothing of another's. A revocation must count within minutes. |
| D4 | The server learns a television is on MQTT from IoT Core's own connect and disconnect events, written to the same device row the WebSocket path uses. | One place answers "how do I reach this television". |
| D5 | `egress.ts` publishes to IoT Core for a television on MQTT and posts to the WebSocket otherwise. Nothing else changes for callers of `sendToDevice()`. | INV-2. |
| D6 | Events from the television over MQTT go to the handler that takes them over the WebSocket. `route.mjs` is split into "find the television" and "handle its event"; both transports call the second. | One behaviour, two ways in. |
| D7 | The WebSocket stays, as the fallback and as the background card service's channel. | It works; MQTT is tried first and may fail for reasons outside Wick. |
| D8 | The MQTT channel reconnects by itself with the same backoff the WebSocket channel uses. | Today a dropped MQTT connection stays dropped. |
| D9 | The first step is a spike on the Vega simulator: does `mqtt.js` connect from the television's JavaScript runtime at all (FL-009's open question)? **If it does not, the server side is still built and verified from the laptop and the Android TV emulator, and the Vega app keeps the WebSocket, with the finding written up.** | The client has never run on a device. |

## 4. What gets built

### 4.1 Infrastructure (`infra/iot.tf`, new)
- `aws_iot_authorizer` "wick-device" → Lambda `wick-iot-authorize`; signing disabled.
- Topic rule on `wick/device/+/events` → Lambda `wick-iot-events`.
- Topic rules on `$aws/events/presence/connected/+` and `…/disconnected/+` →
  Lambda `wick-iot-presence`.
- `iot:Publish` on `wick/device/*` for the roles that run `egress.ts`.
- An output with the full `wss://…/mqtt?x-amz-customauthorizer-name=wick-device` address.
- `infra/transport.tf`'s header no longer says IoT Core is absent.

### 4.2 Lambdas (`services/edge-device/lambda/`)
- `iot-authorize.mjs` — verifies the JWT with the pairing public key (`jwt.mjs`, as
  `connect.mjs` does), checks the television is served, returns the policy in D3. Its
  policy builder is a pure function with tests: one television's token never names
  another's topic or client id.
- `iot-presence.mjs` — sets or clears the foreground connection on the device row, with
  `transport = 'mqtt'`. A disconnect clears it only if the row still holds that
  connection, as `disconnect.mjs` does for the WebSocket.
- `iot-events.mjs` — takes the television's id from the topic, never from the payload,
  looks up its household (`device-owner.mjs`), and calls the shared event handler.
- `route.mjs` — the handler body moves to `device-event.mjs`; `route.mjs` keeps the
  WebSocket-specific lookup. Existing tests keep passing unchanged.

### 4.3 Server send path (`services/agent/src/egress.ts`)
`liveDeviceConnections` returns MQTT televisions too; `pushToDevices` publishes to
`wick/device/<id>/cards` or `/control` at QoS 1 with the same bodies the client already
parses. A failed publish is treated as a failed WebSocket post is today.

### 4.4 Client (`apps/tv-vega/src/transport/`)
- `MqttChannel.ts` — token in the address, not the password; reconnect with backoff;
  asks for missed cards on every connect, as the WebSocket channel does.
- `config.ts` — the deployed MQTT address.
- No change to `createDeviceChannel.ts` or to the background service.

### 4.5 Words
`AGENTS.md` (INV-1 and INV-2 name the new path), `README.md` (the architecture diagram's
"WSS" line), `docs/WICK-TECHNICAL.md` §4.1, FL-009 closed with what was found, and a new
friction entry for §2.2 — the Vega docs and the client both assume a password that cannot
be sent.

## 5. Testing

- Unit tests for the authorizer's policy, presence, the events adapter, the send path's
  choice of transport, and the client's address, reconnect and re-ask.
- `npm run verify` green.
- From the laptop, with a real device token: connect with `mqtt.js` over WSS, subscribe,
  receive a card sent through the deployed stack, publish an event and see it handled;
  then with another television's topic, and with a revoked television — both refused.
- On the Vega simulator: the app connects over MQTT (the device row says `mqtt`), a
  family note and a door card arrive, a reply goes back. Then MQTT is made to fail and the
  app is seen on the WebSocket instead.
- The same on the Android TV emulator once item 2 has merged.

## 6. Deployment

IoT Core is a service this stack has not used, so the first apply is from the laptop with
the `wick-dev` profile, after the plan has been read. **Nothing is applied without the
user's go-ahead at that point.** The WebSocket path is untouched by the apply, and a
television with no MQTT address in its configuration never tries MQTT, so the change is
dark until the client configuration is updated.

## 7. Out of scope

Certificates and device provisioning, device shadows, MQTT for the background card
service, MQTT 5 features, and removing the WebSocket.
