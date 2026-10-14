# tv-fireos — Wick on Fire OS

The same application as `apps/tv-vega`, on Fire OS. **It has no screens of its
own.** It bundles the Vega app's source (`apps/tv-vega/src`) and gives it
Android in place of the four Amazon packages that source was written against:

| The Vega app imports | On Fire OS that is | File |
|---|---|---|
| `@amazon-devices/react-native-kepler` — View, Text, Pressable, the remote's key events | React Native's own (`react-native-tvos`), with the media keys renamed | `src/adapters/kepler.ts` |
| `@amazon-devices/react-native-w3cmedia` — `VideoPlayer`, `KeplerVideoView`, `AudioPlayer` | ExoPlayer through `react-native-video`, behind the same objects | `src/adapters/w3cmedia.tsx`, `videoPlayer.ts`, `audioPlayer.ts`, `AudioHost.tsx` |
| `@amazon-devices/kepler-file-system` — three file calls | the app's key-value storage | `src/adapters/fileSystem.ts` |
| `@amazon-devices/kepler-media-controls` — the film as a media session ("Alexa, pause") | nothing yet: the film obeys the remote's keys only | `src/adapters/mediaControls.ts` |

One shared file is replaced outright: `headless/launchCardService.ts`, which on
Vega starts a background service by a `pkg://` address Android does not have.
The whole table is `adapters.config.js`, and `metro.config.js` applies exactly
that.

So pairing, the home screen, playback, the Natural-Break Engine, every card and
Watch live are the Vega app's code, unchanged. So is the screen of a television
a family member connects as their own (`apps/tv-vega/src/family`): it uses the
same components and `fetch`, and needed no adapter of its own. Two things hold
the swap honest:

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
  television;
- the television is on the MQTT channel (the server's row for it says so): a
  card comes down it and a reply goes back up it; with MQTT refused — a build
  whose address names an authorizer that does not exist — it is on the
  WebSocket instead.

The door card was sent to the test home from a laptop with the Door agent's
own code, because Ring's webhook only ever resolves to the operator's
household; everything after that — the picture, Watch live, the bridge — was
the deployed stack.

Two things Android does differently from Vega, both handled in the adapters
and written up in `FRICTION.md` FL-025: a key press reaches only what holds
focus, and play/pause arrives as the key coming up.

Not yet run on the emulator: a television connected as a family member's own.
It typechecks here and its decisions are tested, and that is all. Such a
television is given a fresh token only when it shows the one it held, so it
stays connected across relaunches only where that token is kept — here, in the
app's own storage (`src/adapters/fileSystem.ts`). The Vega simulator keeps
nothing, and a family member's television there is paired again each time.
The same goes for its later screens — something to read, the wave, and the
seat beside the resident's film, which plays through `src/adapters/w3cmedia.tsx`
and follows her player (`apps/tv-vega/src/family/seat.ts`): typechecked and
tested as decisions, not yet seen on the emulator.

The television speaks her language (`packages/contracts/src/language.ts`):
the resident's app says its own words in the household's language, which it
learns from the home message, and the language is kept in the same storage as
the token so a relaunch here does not begin in English (the Vega simulator
keeps nothing, and is English for the moment before the home message). It
typechecks here and its decisions are tested; it has not yet been seen on the
emulator.

The mantelpiece (`packages/contracts/src/mantel.ts`) — the picture card, the
screen that shows what she has kept, and her pictures filling a home screen
left untouched — is the Vega app's code here too, and needed no adapter: it is
built from `View`, `Image`, `Text`, `Pressable` and `Animated`. Two things in
it were written with Android in mind and are tested as decisions only
(`src/__tests__/idle.test.ts`, on keys as `remoteEvents.ts` says them): a
screen that is all picture keeps one focused view, because Android gives a key
to nothing when nothing is focused; and the key that ends the idle screen is
taken whole, whether it arrives as down-then-up, up only, or `longSelect`. None
of it has been seen on the emulator yet.

"Read to me" (`packages/contracts/src/speech.ts`) is the one place where
Fire OS needed something of its own. On Vega a card is read aloud by an
`AudioPlayer` object; Android's player is a component and plays only while it
is on the screen. So `src/adapters/audioPlayer.ts` is that object, and
`src/adapters/AudioHost.tsx` an unseen view it plays through, which
`src/Root.tsx` puts beside the app — the app itself is still the Vega app,
unchanged. The view sets react-native-video's `disableFocus`, so the reading
does not ask Android for the sound and the film under the door's card keeps
playing. The object's logic is tested, and the shared reader is run through
it (`src/__tests__/audioPlayer.test.ts`); **nothing of it has been heard**: it
has not run on the emulator or a device, and whether a second ExoPlayer mixes
with the film's as intended is unverified.

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
- **What waits for a family member, said while Wick is not on screen.** On
  Vega the same background service asks and posts a toast
  (`apps/tv-vega/src/headless/waitingService.ts`). Here there is no service
  (`src/overrides/launchCardService.ts` gives it no address), so the app
  neither starts one nor opens the way for one at the pairing service.
- **Content Personalization** — a Vega API. Fire TV's equivalent is a separate
  integration.
- Amazon Device Messaging, the Fire TV Integration SDK, camera, voice.
- A signing key or an Appstore submission. Both build types are signed with
  the debug key Android's tooling makes on each machine.

## Architectures

`android/gradle.properties` builds `armeabi-v7a` and `arm64-v8a`: Fire TV
devices are ARM, and so is the emulator on an Apple-silicon Mac. An Intel
emulator needs `-PreactNativeArchitectures=x86_64`.
