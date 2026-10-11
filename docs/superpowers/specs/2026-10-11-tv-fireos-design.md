# Wick on Fire OS — design

**Date:** 2026-10-11 · **Status:** awaiting review
**Item 2 of 4** (add-on package → Fire OS build → MQTT / IoT Core → per-household Ring link).
**Evidence:** "checked today" means checked on 2026-10-11 on this laptop or in the repo at
`a4ee162`. Anything marked *to verify* is from memory or from documentation not re-read
today, and has a named step that settles it.

## 1. What this changes, in one paragraph

`apps/tv-fireos` is a README. After this work it is an Android TV application that runs on
the Android TV emulator and does what the Vega app does on screen: pairs by six-digit code,
shows the home screen and its three programmes, plays them, holds a family note until a
natural break, shows the door card over the picture at once, and opens Watch live. **It is
the same application code.** The Fire OS app is a shell — an Android project and a small set
of adapters — that loads `apps/tv-vega/src` unchanged. Nothing in the Vega app or the back
end is edited. No physical device is used at any point.

## 2. Facts the design rests on

### 2.1 The rules
- Rules: "The requirement is that the project runs on Fire OS or Vega OS."
- FAQ: "an emulator (Android TV Emulator or the Fire TV/Vega simulator) is fine - a
  physical device isn't required at any stage of submission or judging."
- Amazon publishes no Fire OS emulator; the Android TV emulator is the one the FAQ names.

### 2.2 This laptop, checked today
- JDK 21 at `/opt/homebrew/opt/openjdk@21` (not on the default path).
- Android SDK at `/opt/homebrew/share/android-commandlinetools`: platform-tools 37.0.1,
  emulator 37.2.12, platform `android-36`, build-tools 36.0.0, and the system image
  `android-34;android-tv;arm64-v8a`.
- One emulator device already defined: `kata_tv` (1080p television, Android 14).
- `react-native-tvos` is published for React Native 0.83 (latest `0.83.10-1`). The Vega app
  is pinned to React Native `0.83.0` and React 19.

### 2.3 The Vega app, checked today
- 51 source files, about 3,800 lines; 28 test files.
- 35 source files import neither an Amazon package nor React Native: the natural-break
  engine, the device channel, the queue, pairing, the live client, card logic, the
  catalogue.
- The on-screen app reaches three Amazon packages:
  `@amazon-devices/react-native-kepler` (View, Text, StyleSheet, Image, Pressable,
  Animated, BackHandler, `useTVEventHandler`),
  `@amazon-devices/react-native-w3cmedia` (`VideoPlayer`, `KeplerVideoView`, in two files),
  and `@amazon-devices/kepler-file-system` (`KeplerFileSystem`, three methods).
- The code already narrows each to a small interface: `FileSystemLike` (three methods,
  `headless/QueueStore.ts:25`), `MediaElementLike` (eight members,
  `player/PlayerService.ts:36`), `NotificationManagerLike` (`notify/doorToast.ts`).
- Three more Amazon packages are reached only from the headless entry files (`service.js`,
  `task.js`) and the Content Personalization handlers, which the on-screen app does not
  import.
- The app starts its background service with `Linking.openURL('pkg://…')`
  (`headless/launchCardService.ts`); the call never throws.

## 3. Approaches considered

| | Approach | For | Against |
|---|---|---|---|
| **A** (chosen) | **Adapters.** The Fire OS app's bundler resolves the three Amazon package names to local adapters and loads `apps/tv-vega/src` as it is. | The Vega app, which is the primary demo, is not touched. One copy of every screen and card. Least work. | The Fire OS app imports another app's source directory. Adapters imitate Amazon's module shapes. |
| B | **Shared packages.** Move logic to `packages/tv-core` and screens to `packages/tv-app`, with an explicit platform interface; both apps become shells. | The cleanest structure. | Moves or edits about 50 files of a working app twelve days before the deadline; needs a full regression on the Vega simulator before anything new exists. |
| C | **Copy the screens.** Share only the pure logic; write Fire OS screens separately. | No bundler tricks. | Two copies of about 1,600 lines of interface that drift apart. |

A can be turned into B later by moving directories; nothing in A blocks it.

## 4. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | React Native through `react-native-tvos` 0.83.x. | Same React Native minor version as Vega, so the same components run. It adds the D-pad focus engine and `useTVEventHandler`. |
| D2 | Approach A: three adapters plus a short, explicit table of file overrides, all declared in `apps/tv-fireos/metro.config.js`. | §3. |
| D3 | `apps/tv-fireos` is **not** an npm workspace member. It has its own `package.json` and lockfile; the bundler resolves every dependency of the shared source from `apps/tv-fireos/node_modules` only. | The name `react-native` must mean `react-native-tvos` here and plain React Native 0.83.0 in the Vega app. Keeping the installs apart leaves the Vega build exactly as it is. |
| D4 | TypeScript checks the Vega source a second time against the adapters' types (`apps/tv-fireos/tsconfig.json` maps the three package names to the adapters). | A screen that starts using a member an adapter lacks fails the build, not the emulator. |
| D5 | Video is `react-native-video` (ExoPlayer, HLS). The adapter presents it as the `VideoPlayer` object and `KeplerVideoView` component the two screens use, and satisfies `MediaElementLike`. | The natural-break engine reads position, duration, paused, ended and ready state — all available from ExoPlayer. |
| D6 | Storage is AsyncStorage behind `FileSystemLike`, with the file path as the key. | Three methods; Android's app-private storage persists, unlike the Vega simulator's. |
| D7 | The television's id is generated once and stored. The fixed id `wick-tv` is not used. | The fixed id exists only because the Vega simulator loses its storage. |
| D8 | Android application id `com.wick.tv`; launcher category Leanback; a 320×180 banner; landscape; no touchscreen required; HTTPS only. | What Fire OS and Android TV need to list and launch a television app. |
| D9 | No back-end change. The Fire OS app pairs as another television against the deployed pairing API and WebSocket. | The device protocol is already platform-neutral. If a back-end change turns out to be needed, work stops and this design is revised. |
| D10 | The door alert outside the app is a **spike with a stated outcome**, done last (§6). | It is the one part that may not be showable on the emulator. |

## 5. What gets built

```
apps/tv-fireos/
  android/                 Gradle project, manifest, banner, MainActivity
  index.js                 registers the Vega app's root component
  metro.config.js          the adapter and override table (D2), resolution (D3)
  tsconfig.json            second type check of the shared source (D4)
  src/adapters/
    kepler.ts              re-exports the same names from react-native(-tvos)
    w3cmedia.tsx           VideoPlayer + KeplerVideoView over react-native-video
    fileSystem.ts          KeplerFileSystem over AsyncStorage
  src/overrides/
    launchCardService.ts   starts the Android background service, or does nothing (§6)
  src/__tests__/           adapter tests; an export-parity test for each override
```

- **Export parity:** for every override and adapter, a test compares its exported names
  with the names the shared source imports from the module it stands in for. A new import
  in the Vega app that the Fire OS side lacks fails a test.
- **`scripts/check-no-mocks.mjs`** scans `apps/tv-fireos/src` as well.
- **Root scripts:** `fireos:start`, `fireos:android` (build, install, launch on the
  running emulator), `fireos:apk`.
- **CI:** one job that type-checks the Fire OS app and builds a debug APK, on changes under
  `apps/tv-fireos`, `apps/tv-vega/src` or `packages`.
- **Words:** `README.md` (the Fire OS line and how to run it), `AGENTS.md` (INV-1 already
  names `apps/tv-fireos`; the data rule gains the directory), `apps/tv-fireos/README.md`
  rewritten, `FRICTION.md` entries written as each limitation is met.

### What the Fire OS build does not have
- Content Personalization (a Vega API; the Fire TV equivalent is a separate integration).
- Amazon Device Messaging, the Fire TV Integration SDK, camera, voice.
- An Appstore submission.

## 6. The door alert outside the app

On Vega a background service holds a second connection and posts a system toast. The
Android equivalent is a foreground service running a headless JavaScript task that holds
the same `role=background` connection and posts a notification with the door picture, whose
action opens Wick.

Two things are unsettled:

- Amazon's Fire TV documentation (read 2026-10-04) says an app "should not send a Heads-Up
  notification when another app is in the foreground".
- Stock Android TV may draw no heads-up notification at all (*to verify* on `kata_tv`).

So this part is a spike, after everything in §5 works: build the service and post one
notification with the app in the background. **If the emulator draws it**, it is kept,
tested like the rest, and the documentation's guidance is quoted beside it in the README.
**If the emulator draws nothing**, the service is not shipped, the Fire OS build shows door
cards while Wick is on screen only, and the finding is written into FRICTION.md. Either
outcome is reported with screenshots.

## 7. Order of work, with stopping points

1. **Toolchain proof.** An empty `react-native-tvos` 0.83 app builds with JDK 21 and shows
   on `kata_tv`. *If this is not working within half a day, stop and report.*
2. **Shell and resolution.** The Vega root component loads through the adapters; the
   pairing screen shows a code from the deployed API.
3. **Paired.** Channel connects; home screen; a door card and a family note arrive.
4. **Video.** A programme plays; the note waits for a pause or the credits; the door card
   comes over the picture.
5. **Watch live.** Needs a fresh Ring Playground token from the user.
6. **Door alert spike** (§6).
7. **CI, scripts, words.**

Each step ends with `npm run verify` green and emulator screenshots.

## 8. Verification on the emulator

Driven from the shell: `emulator -avd kata_tv`, `adb install`, D-pad by
`adb shell input keyevent`, screenshots by `adb exec-out screencap -p`. The test home is a
demo guest home made for the run and removed afterwards — never `margaret`. Checked, each
with a screenshot:

1. pairing code shown; television connected from the family app; Allow on the Circle card;
2. home screen with three programmes; D-pad focus moves and OK opens one;
3. a note sent while a film plays is not shown; it appears on pause; a reply is pressed and
   read back through `get_replies`;
4. a door card arrives over a playing film within a few seconds;
5. Watch live shows the Playground camera and Back returns to the card;
6. the app is killed and reopened: still paired, same television id.

The Vega app is rebuilt and smoke-tested once at the end to confirm it is unchanged.

## 9. Risks

| Risk | How it is met |
|---|---|
| `react-native-tvos` 0.83 with the new architecture and JDK 21 does not build. | Step 1 is this and nothing else. JDK 17 is the fallback. |
| `react-native-video` does not support this React Native version. | Checked in step 1's scaffold before any adapter is written; the fallback is a thin native ExoPlayer view. |
| Two copies of React in one bundle. | D3: one `node_modules` for everything bundled. |
| The shared source spells imports with a `.js` extension. | The Fire OS bundler config strips it, as the Vega one does. |
| The emulator cannot decode the HLS streams. | Found in step 4; software decoding or a lower rendition is the fallback. |
| Minimum Fire OS version. | *To verify* in step 1: Fire OS 7 is Android 9 (API 28), Fire OS 8 is Android 11 (API 30). `minSdk` 28 unless React Native requires higher. |

## 10. Out of scope

Everything in "What the Fire OS build does not have", plus MQTT (item 3), any change to the
Vega app's behaviour, and any physical device.
