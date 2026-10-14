# Setting up Wick

How to run Wick, from the cheapest path to the most complete. Each path stands
on its own: a judge who only wants to see it working needs the first or the
second, not the rest.

| Path | Needs | What you get |
|---|---|---|
| [1. Try the hosted demo](#1-try-the-hosted-demo) | A browser | The deployed stack, a demo home, a television in a browser tab |
| [2. Run the tests](#2-run-the-tests) | Node | Every test, the type checks, the lint rules and the no-mocks guard |
| [3. Run it locally, without AWS](#3-run-it-locally-without-aws) | Node | The family app and the real server on your laptop, with stand-ins for the television and the doorbell |
| [4. The Vega app](#4-the-vega-app-on-the-vega-virtual-device) | The Vega SDK | Wick on the Vega Virtual Device, against the deployed stack |
| [5. The Fire OS build](#5-the-fire-os-build-on-the-android-tv-emulator) | Java 17, the Android SDK | Wick on the Android TV emulator, against the deployed stack |
| [6. Deploy your own stack](#6-deploy-your-own-stack) | An AWS account, Bedrock access, a Ring developer account | All of it, in your account |

## Prerequisites

| Tool | Version | For |
|---|---|---|
| Node.js | **22** (`.nvmrc`; `package.json` asks for ≥ 20) | Everything |
| npm | the one that ships with Node 22 | `npm ci` from the root installs every workspace except `apps/tv-fireos` |
| Terraform | **≥ 1.10** (CI uses 1.16.2) | Path 6 |
| AWS CLI | v2 | Path 6 |
| Docker | any engine that builds `linux/arm64` and `linux/amd64` — Docker Desktop, or [colima](https://github.com/abiosoft/colima) on an Apple-silicon Mac | Path 6: the agent images are arm64 (AgentCore Runtime is arm64 only); the Wick server's image is amd64 |
| Python 3 | any | Path 6: `infra/bootstrap/put-ring-secret.sh` |
| The Vega SDK and its `vega` CLI | SDK 0.24 was used | Path 4 |
| Java 17 and the Android command-line tools | API 34 system image | Path 5 |

---

## 1. Try the hosted demo

No account and no hardware. The README's [Try it](../README.md#try-it) has the
steps: open the [family app](https://dmaz25jvryojp.cloudfront.net/), choose
**Try the demo**, open [a television in a browser tab](https://d2sbabcft8sm3m.cloudfront.net/device.html),
pair it, allow yourself on it, and ask.

---

## 2. Run the tests

```bash
nvm use            # Node 22, from .nvmrc
npm ci
npm run verify     # typecheck (workspace + scripts) + lint + check:no-mocks + every test
```

`npm run verify` touches no AWS. It is what CI runs on every pull request
(`.github/workflows/ci.yml`). The property tests on their own:

```bash
npm run test:property   # the Guardian and the Natural-Break Engine
```

`npm ci` also installs a git hook through `simple-git-hooks` (`postinstall`).
If your git uses a global `core.hooksPath`, install with
`npm ci --ignore-scripts` instead.

---

## 3. Run it locally, without AWS

```bash
npx vite-node -c vitest.config.ts services/mcp-server/src/__tests__/devServer.ts
```

This starts the real Wick server on <http://127.0.0.1:3300>, over an in-memory
store, and serves the family app on <http://127.0.0.1:4173>. Open the family
app there. What is real and what stands in is in the header comment of
[`devServer.ts`](../services/mcp-server/src/__tests__/devServer.ts); in short:

- **Accounts** are kept in memory. The confirmation code for a new account is
  always `123456`, and the demo button is on.
- **The television** is stood in for. Its pairing code is always `123456`.
  `GET http://127.0.0.1:3300/dev/allow` presses **Allow** as the resident for
  everyone who is waiting; it is also what the family app's "virtual
  television" link opens here.
- **The doorbell:** `GET /dev/door` puts a door card on the stand-in
  television of every home, as if the resident had pressed *Ask … to look*.
- **Every other feature** has a `/dev/…` route that presses the resident's
  buttons through the agent plane's and the edge's own code: `/dev/different`
  and `/dev/tell` (*Shall I tell …?*), `/dev/watch` (watch together),
  `/dev/light`, `/dev/reach` (hold for Sarah), `/dev/visit` (the visit,
  witnessed), `/dev/language`, `/dev/photos` (the mantelpiece) and
  `/dev/hear` (ask by voice). The header comment gives each one's options.
- **Ring:** a pasted token that starts with `playground` is accepted and lists
  one simulated camera.
- **The assistant's model** has no stand-in. Without AWS the family app
  answers by its own rules. With `WICK_DEV_ASSISTANT=on` and AWS credentials
  for Bedrock, Claude Sonnet 4.5 chooses the tools. With
  `WICK_DEV_HEAR=transcribe` and credentials, the real Amazon Transcribe hears
  a spoken question.

Nothing in it ships: the deployed entry point is `services/mcp-server/src/index.ts`.

---

## 4. The Vega app on the Vega Virtual Device

The Vega app (`apps/tv-vega`) talks to the deployed stack: its addresses are
in [`apps/tv-vega/src/config.ts`](../apps/tv-vega/src/config.ts).

1. Install the Vega SDK, the `vega` CLI and the Vega Virtual Device by
   following Amazon's [Install the Vega SDK](https://developer.amazon.com/docs/vega/0.21/install-vega-sdk.html).
   Check the toolchain with `vega project doctor`.
2. From the repository root, `npm ci` (the Vega app is a workspace).
3. Build the package:

   ```bash
   cd apps/tv-vega
   npm run build      # react-native build-vega --build-type Release
   ```

   On an Apple-silicon Mac the package is
   `build/aarch64-release/tv-vega_aarch64.vpkg`.
4. Start the simulator and install and launch the app:

   ```bash
   vega virtual-device start
   vega run-app build/aarch64-release/tv-vega_aarch64.vpkg com.wick.tv.main
   ```

5. The television shows a pairing code. Enter it in the family app (path 1),
   allow yourself on the television, and use it.

Useful while it runs:

```bash
vega device run-cmd --command 'inputd-cli button_press KEY_ENTER'   # press a remote key
vega device running-apps
vega device start-log-stream
```

Two things the simulator does differently from a Fire TV, both in
[`FRICTION.md`](../FRICTION.md): it keeps nothing on disk between launches
(FL-013), so the app pairs itself again through `POST /pair/refresh`; and it
stops by itself from time to time — `vega virtual-device start` again, then
`vega run-app`.

---

## 5. The Fire OS build on the Android TV emulator

Amazon publishes no Fire OS emulator; the hackathon FAQ names the Android TV
emulator, and that is what this runs on. [`apps/tv-fireos/README.md`](../apps/tv-fireos/README.md)
has the full instructions and what has and has not been seen working. In short:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools

cd apps/tv-fireos
npm install                                   # by itself: not a workspace
(cd android && ./gradlew assembleRelease)
$ANDROID_HOME/emulator/emulator -avd wick_tv &   # any Android TV device, API 34
$ANDROID_HOME/platform-tools/adb install -r android/app/build/outputs/apk/release/app-release.apk
$ANDROID_HOME/platform-tools/adb shell am start -n com.wick.tv/.MainActivity
```

The build has no background service, so no system toast over another app.

---

## 6. Deploy your own stack

This creates every AWS resource Wick uses in your account (`us-east-1`), from
`infra/`. [`infra/README.md`](../infra/README.md) is the authority for the
details of each step; this is the order and what each step is for.

### 6.1 Accounts and access

- **An AWS account and a named profile.** The scripts default to
  `AWS_PROFILE=wick-dev`.
- **Bedrock model access** in `us-east-1` for **Amazon Nova Lite**
  (`amazon.nova-lite-v1:0`) and **Claude Sonnet 4.5** through its US
  cross-region inference profile (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`).
  Request both in the Bedrock console before the first door event or the
  first weekly run.
- **A Ring developer account** with an app in the Ring developer console, for
  its client id, client secret and webhook HMAC key. The
  [Developer Playground](https://developer.amazon.com/ring/console/playground)
  gives a simulated camera and a token that lasts 30 minutes.

### 6.2 Values that name this deployment

A few values in the repository name the original deployment. Change them for
yours:

| Where | What |
|---|---|
| `infra/versions.tf` | The state bucket, `wick-tfstate-<account id>` |
| `infra/variables.tf` | `mcp_issuer_url` (the Wick server's own URL, known after its first apply — `infra/mcp.tf` explains the two applies) |
| `infra/outputs.tf` | `app_homepage_url`, if you host your own pages |
| `apps/tv-vega/src/config.ts` | The pairing API, WebSocket, MQTT and Wick server addresses — from `terraform output` |

### 6.3 Order

```bash
export AWS_PROFILE=wick-dev
cp .env.example .env                # fill in the Ring app credentials; see the comments

# 1. Terraform's own state bucket, once per account
infra/bootstrap/bootstrap.sh

# 2. The Lambda bundles Terraform zips
npm ci
npm run build:lambda

# 3. Terraform. On a fresh account the App Runner service and the AgentCore
#    runtime need their images in ECR before they can start, so the
#    repositories come first — infra/README.md has the exact first run.
terraform -chdir=infra init
terraform -chdir=infra plan

# 4. The container images
scripts/push-agent-image.sh         # wick-agents + wick-live-bridge (arm64); pins the tag in infra/images.auto.tfvars
#    the Wick server (amd64); App Runner deploys every push to :latest
ECR="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.us-east-1.amazonaws.com"
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "$ECR"
docker build --platform linux/amd64 -f services/mcp-server/Dockerfile -t "$ECR/wick-mcp-server:latest" .
docker push "$ECR/wick-mcp-server:latest"

terraform -chdir=infra apply

# 5. Secrets Terraform makes the containers for, and never the contents
infra/bootstrap/generate-pairing-key.sh   # RS256 key for device tokens
infra/bootstrap/generate-push-keys.sh     # Web Push (VAPID) key pair
infra/bootstrap/put-ring-secret.sh        # Ring client id, secret, HMAC key, from .env
```

Then:

6. **Ring console.** Paste the four outputs into your Ring app's account
   linking settings: `terraform -chdir=infra output` prints
   `ring_account_link_url`, `ring_token_exchange_url`, `ring_webhook_url` and
   `app_homepage_url`, each with the field it belongs in.
7. **Link Ring to a household.** A home's organiser does it from the family
   app's Doorbell card. For a quick test with a Playground token,
   `scripts/set-ring-token.sh` writes one household's secret
   (`wick/ring/tokens/<householdId>`). Then hand the doorbell to that
   household — `scripts/assign-ring-device.ts -- --list` shows what the link
   can see — and check it with `npm run ring:check`.
8. **The films.** `scripts/publish-programmes.sh all` fetches the Blender
   films, transcodes them to HLS in a container and uploads them. The calm
   points are already measured in the repository
   (`apps/tv-vega/src/catalog/calmPoints.ts`); `npm run calm:measure` and
   `npm run calm:build` measure them again with Amazon Rekognition and ffmpeg.
9. **CI.** `infra/github-oidc.tf` creates the role GitHub Actions deploys
   with; set the repository variable `AWS_DEPLOY_ROLE_ARN` to it. After that,
   a push to `main` applies Terraform. The container images are still
   pushed by hand, and an apply that adds a new AWS service to the deploy
   role's permissions has to be run from a laptop first.
10. **The television.** Put your addresses in `apps/tv-vega/src/config.ts`,
    then path 4 or 5.

### 6.4 Before a recording

```bash
npm run ring:check                        # can the household's link reach the camera?
npm run addon:check -- --live             # the Alexa+ add-on's documented checks, against your stack
```

A Playground token lasts 30 minutes and cannot be refreshed (FL-010): paste a
fresh one shortly before.

### 6.5 What it costs

[`docs/WICK.md`](WICK.md#76-what-it-costs-to-run) §7.6 estimates the running
cost. The App Runner service is the largest fixed item: one instance is always
on.
