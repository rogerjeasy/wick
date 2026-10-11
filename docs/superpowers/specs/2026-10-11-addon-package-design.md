# The Alexa+ add-on package, finished and used — design

**Date:** 2026-10-11 · **Status:** awaiting review
**Item 1 of 4** (add-on package → Fire OS build → MQTT / IoT Core → per-household Ring link).
**Evidence:** "checked today" means checked on 2026-10-11 against the live stack or the
public page named. Amazon's add-on documentation was read through a summarising fetch, so
§2.2 is a paraphrase; the plan's first task re-reads those pages in a browser before any
field name is relied on.

## 1. What this changes, in one paragraph

`addon-package/addon.json` has a placeholder where the server address goes, and nothing
reads the file. Uploading it to Amazon is not possible: the MCP Toolkit, its CLI and the web
simulator are open to select partners only, and Amazon staff repeated on 2026-10-08 (forum
topic 45482) that no hackathon participant will be given access. After this work the
package is complete and valid, **a preflight script runs every check Amazon's docs describe
for a deploy that can be run without Amazon**, and **the simulated Alexa+ surface reads the
package**: it shows Wick's store listing from the manifest, and the address it links an
account against is the one in the manifest. The upload itself stays undone, and the
README and FRICTION.md say so.

## 2. Facts the design rests on

### 2.1 Checked today against the live stack

- The six light icons, the carousel image and both legal pages answer `200` over HTTPS at
  the URLs in the manifest. `light-241.png` is 241×241 and `wick-1.png` is 600×900.
- `POST https://tqcu7pa3ip.us-east-1.awsapprunner.com/mcp` with no token answers `401`
  with no `WWW-Authenticate` header.
- `/.well-known/oauth-authorization-server` on that host advertises
  `code_challenge_methods_supported: ["S256"]`.
- The manifest's endpoint is the literal `SET-FROM-WICKMCP-STACK-OUTPUT`; `spokenForm.value`
  is `""`; `icons.dark` is `[]`; two notes in the file still describe a CDK stack (the
  infrastructure is Terraform, and the server runs on App Runner).
- `apps/sim-alexa` takes its server address from an `<input>` whose value Terraform
  rewrites at deploy (`infra/sim-alexa.tf:39-42`). It never opens `addon.json`.

### 2.2 Read today in Amazon's add-on docs (paraphrased — to re-verify)

- **Manifest fields** (MCP Toolkit quickstart). Required: `manifestVersion` "1.0";
  `distributionCountries`; `name.value` ≤ 30 characters; `shortDescription` ≤ 123;
  `fullDescription` ≤ 4000; `examplePhrases` 3–4 items, ≤ 200 each; `privacyPolicyUrl` and
  `termsOfUseUrl` (HTTPS); `icons.light` in all six sizes (72, 64, 88, 126, 180, 241);
  at least one `carouselImages` entry at 600×900 with `altText` ≤ 250;
  `integrations[].type` "MCP" with `config.endpoints.default` `{type: "HTTPS", uri}`.
  Optional: `name.spokenForm` (IPA), `icons.dark` (same six sizes if present),
  `bannerImages` (1200×600). Images must be HTTPS and PNG, JPG, JPEG or WEBP. The manifest
  has no account-linking field; linking is a property of the server.
- **Deploy** (`alexa-ai deploy`): uploads the package and deploys it to a development
  stage. Alexa+ reads the server's tools and resources at deploy time only.
- **The Alexa+ MCP client** (client lifecycle page): its `initialize` example sends
  `protocolVersion: "2025-03-26"`, `capabilities: {roots: {listChanged: true}}` and
  `clientInfo: {name: "Alexa+ MCP Client", version: "1.0.0"}`, and expects `tools` and
  `resources` in the server's capabilities. A tool result may carry `structuredContent`,
  text `content`, and `_meta.ui.resourceUri` for a custom view; with no `resourceUri`
  Alexa+ draws the answer from the data.
- **Store listing guidance:** a tagline of 6–8 words written as an action; a short
  description in two or three conversational sentences; sample phrases that all work when
  spoken, covering an open request, a specific one and a follow-up; a full description that
  opens with example phrases and states any account-linking or device requirement.

The quickstart and the hackathon rules both name spec `2025-11-25`; the client lifecycle
page's example names `2025-03-26`. If the re-read confirms that, it is a friction-log entry.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | "Done" is: the package is complete, the preflight passes, and the simulated surface reads the package. It is not an upload. | The upload cannot happen. Everything short of it can be checked. |
| D2 | The endpoint is `https://tqcu7pa3ip.us-east-1.awsapprunner.com/mcp`, written in the manifest. A unit test fails if it differs from `var.mcp_issuer_url`'s default in `infra/variables.tf`. | One address, two files; the test keeps them equal. |
| D3 | `spokenForm` becomes IPA `wɪk`. Six dark-theme icons are made from the existing mark and published beside the light ones. | Both are optional in the schema; both are cheap; neither can fail the preflight if absent. |
| D4 | The preflight has two layers. **Static** checks run in CI inside `npm run verify`. **Live** checks run by hand (`npm run addon:check -- --live`) and before submission. | Live checks need the network and the deployed server; CI should not fail because GitHub Pages was slow. |
| D5 | The simulated surface gains one step before sign-in: **Wick's listing**, drawn from `addon.json` — icon, name, short description, example phrases, the account-linking notice, privacy and terms links, and an **Enable** button that starts the sign-in that exists today. | This is what a customer sees before using an add-on, and it makes the file load-bearing. |
| D6 | When the page is not on `localhost`, the server it links against is the manifest's endpoint. Terraform's string rewrite of `index.html` is removed, and `addon.json` is published beside the page. | One source for the address. Local development keeps the `localhost` field. |
| D7 | The listing is labelled as simulated, uses no Alexa+ logo, and the on-page notice that this is not a real Alexa+ integration stays. | Staff ruling in forum topic 45450; `apps/sim-alexa/README.md` "What this is not". |
| D8 | The preflight reports what the server does with a `2025-03-26` `initialize` and whether it advertises `resources`. It does not change the server. | Custom views (`ui://`, MCP Apps) and resources are a separate piece of work, outside these four items. |

## 4. What gets built

### 4.1 `addon-package/addon.json`
Real endpoint; `spokenForm`; dark icons; the three stale `_…Note` keys replaced by one
accurate comment; listing copy revised to the guidance in §2.2. The full description must
say that an account is linked and that the home needs a paired television. The three
example phrases stay natural questions. Copy is drafted in the plan for review.

### 4.2 `scripts/addon-check.ts` — `npm run addon:check`
Pure functions for the static layer, in `scripts/addon/` with tests beside them:

- shape and limits of every field in §2.2;
- the six icon sizes present, each `size` matching its file name; the same for dark if any;
- every URL is HTTPS; no placeholder text anywhere in the file;
- the endpoint equals the Terraform default (D2).

The live layer (`--live`), each line printed as pass or fail with the measured value:

1. every image URL answers `200` with an allowed type and the exact pixel size declared
   (read from the image header);
2. both legal URLs answer `200`;
3. the endpoint with no token answers `401` and sends no `WWW-Authenticate`;
4. the authorisation metadata lists `S256` and has authorisation and token endpoints;
5. with a token: `initialize` at `2025-11-25`, then again shaped as §2.2 describes the
   Alexa+ client (`2025-03-26`, `roots.listChanged`), reporting the version the server
   answers with and its capabilities;
6. `tools/list`: every tool has a title, a description and annotations;
7. one read-only `tools/call`: reports whether `structuredContent` is present;
8. the round-trip time of each call, failing above 500 ms (Amazon's stated limit),
   measured over five calls with the median reported.

The token comes from `WICK_ADDON_CHECK_TOKEN`, or from `--demo`, which makes a guest
account through the same public "Try the demo" route the family app uses. The script
writes nothing else and never touches a household a person set up.

### 4.3 `apps/sim-alexa`
- `addon.json` published as a fourth static object (`infra/sim-alexa.tf`).
- `surface.js`: a pure `presentListing(manifest)` that returns what the listing shows, and
  refuses a manifest the static checks would refuse. Tested in `surface.test.ts`.
- `main.js`: fetch `./addon.json` on load; show the listing where the link card is today;
  Enable runs the existing `connect()`; the example phrases become the first suggestions
  after linking.
- A test asserts that each example phrase in the manifest routes to a tool
  (`routeUtterance`), so the listing cannot promise a phrase that does nothing.

### 4.4 Words
- `README.md`: the add-on line states what is finished and what cannot be done.
- `FRICTION.md`: FL-001 gains the 2026-10-08 staff answer; a new entry for the protocol
  version disagreement if the re-read confirms it.
- `docs/WICK-TECHNICAL.md` §7.3: S4b's row updated.

## 5. Testing

- Unit tests for every static rule, each with one manifest that breaks only that rule.
- `presentListing` and the example-phrase routing test.
- `npm run verify` green.
- One live run of the preflight against the deployed stack, its output pasted into the PR.
- The deployed family app opened in a browser: listing shown, Enable, sign in as a demo
  guest, one example phrase asked and answered. Screenshots kept with the PR.

## 6. Out of scope

- Uploading or submitting the add-on (not possible).
- A deploy script that calls `alexa-ai`: it could not be run, so it could not be tested.
- MCP Apps, `ui://` resources, MCP resources, `outputSchema`.
- Any change to the MCP server's tools.

## 7. Open points

1. The exact field list in §2.2 (for example whether a locale carries a `default` key) is
   confirmed by the browser re-read in the plan's first task; the validator follows the
   page, not this paraphrase.
2. A preflight run with `--demo` leaves one guest account and demo home on the live table,
   as any visitor's click does.
