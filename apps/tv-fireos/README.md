# tv-fireos — Wick on Fire OS

The same application as `apps/tv-vega`, on Fire OS. **It has no screens of its
own.** It bundles the Vega app's source (`apps/tv-vega/src`) and gives it
Android in place of the three Amazon packages that source was written against:

| The Vega app imports | On Fire OS that is | File |
|---|---|---|
| `@amazon-devices/react-native-kepler` — View, Text, Pressable, the remote's key events | React Native's own (`react-native-tvos`), with the media keys renamed | `src/adapters/kepler.ts` |
| `@amazon-devices/react-native-w3cmedia` — `VideoPlayer`, `KeplerVideoView` | ExoPlayer through `react-native-video`, behind the same object | `src/adapters/w3cmedia.tsx`, `videoPlayer.ts` |
| `@amazon-devices/kepler-file-system` — three file calls | the app's key-value storage | `src/adapters/fileSystem.ts` |

One shared file is replaced outright: `headless/launchCardService.ts`, which on
Vega starts a background service by a `pkg://` address Android does not have.
The whole table is `adapters.config.js`, and `metro.config.js` applies exactly
that.

So pairing, the home screen, playback, the Natural-Break Engine, every card and
Watch live are the Vega app's code, unchanged. Two things hold the swap honest:

- `npm run typecheck` here compiles the Vega source a second time, against the
  adapters' types.
- `src/__tests__/parity.test.ts` (run by the root `npm test`) fails when the
  Vega source imports a name an adapter does not offer.

## Run it

No Fire TV is needed. Amazon publishes no Fire OS emulator; the hackathon FAQ
names the Android TV emulator, and that is what this runs on.

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17        # Java 17: React Native 0.83's Gradle plugin asks for it
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools

cd apps/tv-fireos
npm install                                          # by itself — see "Not a workspace"
(cd android && ./gradlew assembleRelease)            # JavaScript bundled in; no dev server needed
$ANDROID_HOME/emulator/emulator -avd wick_tv &       # any Android TV device, API 34
$ANDROID_HOME/platform-tools/adb install -r android/app/build/outputs/apk/release/app-release.apk
$ANDROID_HOME/platform-tools/adb shell am start -n com.wick.tv/.MainActivity
```

For development, `npm start` and `npm run android` use the dev server instead.

The app pairs against the same deployed back end as the Vega app
(`apps/tv-vega/src/config.ts`); nothing on the server knows which of the two a
television is.

## Checked on the emulator

On 2026-10-11, on an Android TV emulator (API 34), against the deployed back
end and a demo home made for the run:

- the pairing screen shows a code from the pairing service; the family app
  connects the television; the Circle card arrives and **Allow** is recorded;
- the home screen shows the three programmes; the D-pad moves focus and OK
  starts one; the film plays (HLS over HTTPS, ExoPlayer);
- a note sent while the film plays is **not** shown; it appears when the film
  is paused; a reply chosen with the D-pad and OK is read back through the
  `get_replies` tool;
- a door card arrives over a playing film, with the picture from Ring's
  Developer Playground camera (Ring's simulator);
- **Watch live** shows that camera's live picture with the countdown, and Back
  returns to the card with the film still there;
- after the app is replaced and reopened it is still paired, as the same
  television.

The door card was sent to the test home from a laptop with the Door agent's
own code, because Ring's webhook only ever resolves to the operator's
household; everything after that — the picture, Watch live, the bridge — was
the deployed stack.

Two things Android does differently from Vega, both handled in the adapters
and written up in `FRICTION.md` FL-025: a key press reaches only what holds
focus, and play/pause arrives as the key coming up.

## Not a workspace

`apps/tv-fireos` is deliberately left out of the root `package.json`'s
workspaces. Here the name `react-native` is `react-native-tvos`; in
`apps/tv-vega` it is React Native 0.83.0 beside Amazon's own. One hoisted
`node_modules` cannot hold both under one name, so this app installs by itself,
and `metro.config.js` resolves everything the shared source imports from this
directory's `node_modules`.

## What this build does not have

- **A door alert while Wick is not on screen.** On Vega a background service
  posts a system toast. See `docs/superpowers/specs/2026-10-11-tv-fireos-design.md` §6.
- **Content Personalization** — a Vega API. Fire TV's equivalent is a separate
  integration.
- Amazon Device Messaging, the Fire TV Integration SDK, camera, voice.
- A signing key or an Appstore submission. Both build types are signed with
  the debug key Android's tooling makes on each machine.

## Architectures

`android/gradle.properties` builds `armeabi-v7a` and `arm64-v8a`: Fire TV
devices are ARM, and so is the emulator on an Apple-silicon Mac. An Intel
emulator needs `-PreactNativeArchitectures=x86_64`.
