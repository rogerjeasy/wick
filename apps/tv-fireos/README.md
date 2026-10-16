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
Here it starts Wick's own Android foreground service instead (see "The door,
outside Wick" below). The whole table is `adapters.config.js`, and
`metro.config.js` applies exactly that.

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

A television connected as a family member's own was run on the emulator on
2026-10-13, against the deployed back end, in a throwaway home: pairing as
*Mine*, its home screen, a request to ring and a hello and their answers, the
week's reader, the wave and the seat beside the resident's film
(screenshots from those checks are not in the repository). Such a
television is given a fresh token only when it shows the one it held, so it
stays connected across relaunches only where that token is kept — here, in the
app's own storage (`src/adapters/fileSystem.ts`). The Vega simulator keeps
nothing, and a family member's television there is paired again each time.
The seat plays through `src/adapters/w3cmedia.tsx` and follows her player
(`apps/tv-vega/src/family/seat.ts`); how good its picture is could not be
judged on the emulator, whose link was slower than the film.

The television speaks her language (`packages/contracts/src/language.ts`):
the resident's app says its own words in the household's language, which it
learns from the home message, and the language is kept in the same storage as
the token so a relaunch here does not begin in English (the Vega simulator
keeps nothing, and is English for the moment before the home message). On
2026-10-13 it was run on the emulator as the resident's television: the
language card waited for a break during a film, and after her yes the home
screen and every card were Spanish.

The mantelpiece (`packages/contracts/src/mantel.ts`) — the picture card, the
screen that shows what she has kept, and her pictures filling a home screen
left untouched — is the Vega app's code here too, and needed no adapter: it is
built from `View`, `Image`, `Text`, `Pressable` and `Animated`. Two things in
it were written with Android in mind and are tested as decisions only
(`src/__tests__/idle.test.ts`, on keys as `remoteEvents.ts` says them): a
screen that is all picture keeps one focused view, because Android gives a key
to nothing when nothing is focused; and the key that ends the idle screen is
taken whole, whether it arrives as down-then-up, up only, or `longSelect`. On
2026-10-14 it was run on the emulator against the deployed back end: the
picture's card over a film and on the home screen, *Keep it*, the mantelpiece,
*Take it down*, *Thank you*, and the idle screen.

"Read to me" (`packages/contracts/src/speech.ts`) is the one place where
Fire OS needed something of its own. On Vega a card is read aloud by an
`AudioPlayer` object; Android's player is a component and plays only while it
is on the screen. So `src/adapters/audioPlayer.ts` is that object, and
`src/adapters/AudioHost.tsx` an unseen view it plays through, which
`src/Root.tsx` puts beside the app — the app itself is still the Vega app,
unchanged. The view sets react-native-video's `disableFocus`, so the reading
does not ask Android for the sound and the film under the door's card keeps
playing. The object's logic is tested, and the shared reader is run through
it (`src/__tests__/audioPlayer.test.ts`). On the emulator, on 2026-10-14, Play
was pressed over a note holding a film, and the note and the held film stayed
as they were. That is all that was seen: whether the reading was fetched and
played there was not confirmed, **nothing of it has been heard**, and whether a
second ExoPlayer mixes with the film's as intended is unverified.

## The door, outside Wick

When another app is in front, Wick cannot draw its card. What it does
instead, on Fire OS, is what the Vega build does with a system toast: it says
*"Someone's at the front door."* in an Android notification, with one button,
*Open Wick*, and choosing the notification or the button brings Wick forward
to the card, which is waiting there. When the door agent's picture and
sentence come, the same notification is put up again with them. Only the
door does this: a note from the family, the week, a question — anything that
waits for a natural break — never posts anything outside Wick.

How it is built:

| Part | File |
|---|---|
| An Android foreground service (`specialUse`: none of Android's named types is a doorbell) that runs one Headless JS task and holds no wake lock | `android/app/src/main/java/com/wick/tv/door/DoorService.kt` |
| The task: the television's *background* WebSocket connection (`role=background`, as the Vega card service holds it), the door card announced, its notification taken down when the card is taken back | `src/door/doorService.ts`, `src/door/task.ts` |
| What the notification says, and that there is one only for a live door card | `src/door/doorAlert.ts` |
| Putting it up, changing it and taking it down; the picture fetched for it, held in memory only | `android/.../door/DoorAlertModule.kt`, `DoorNotifications.kt`, `DoorPicture.kt`, `src/door/native.ts` |
| Starting the service each time Wick comes on screen, and taking the door's notification down then (the card is on the screen) | `src/overrides/launchCardService.ts` |
| Starting it when the television starts, or Wick has been updated | `android/.../door/StartAtBoot.kt` |

Two things the service does that React Native's own `HeadlessJsTaskService`
would not have: the task tells Android itself when it has ended
(`WickDoorAlert.ended()`), because React Native 0.83's new architecture
registers no `HeadlessJsTaskSupport` module and so never reports a Headless
JS task finished — a service waiting for that would run for ever on a
television with nothing to hold; and when Wick comes on screen with the
token of another television — paired again as a new one while the service
held the old one — the connection is let go and taken up again with the new
token (`doorRunner` in `src/door/doorService.ts`).

The rules it keeps:

- **The token is the app's.** The service runs in the app's process, against
  the app's storage, and uses the device-bound JWT the app keeps — nothing
  else (AGENTS.md INV-1). A token near its end is renewed with this
  television's secret, as the app renews its own, and nothing is written down
  for it. Unlike Vega (FL-029), nothing has to be handed from the app to its
  service, so no unproven token is ever asked for.
- **Her language.** The title and the sentence are the server's, in her
  language already. The button and the line shown before the door agent has
  said who is there come from the words table (`doorAlert.` in
  `apps/tv-vega/src/words/words.ts`), in the language the app keeps beside the
  token — read again for each notification.
- **No sound, no red, no badge.** The door's channel is high importance (that
  is what makes Fire OS show a heads-up) with no sound, no vibration, no light
  and no badge, and no colour is set. Fire OS's own *Do Not Interrupt* still
  silences it: that is hers to choose. The service's own notification, which
  Android requires of a foreground service, is the lowest importance there is.
- **It does not outlive the card.** It goes when Wick comes forward, when the
  card is taken back (answered on another television, or withdrawn), and at
  the moment the app itself lets a door card go — five minutes, the card's
  own end — so it never says someone is at the door once that is no longer
  true.
- **She is asked once.** On Android 13 and later the system asks whether Wick
  may post notifications, once, the first time the resident's Wick is on
  screen. Fire OS 7 and 8 are Android 9 and 11, and never ask.

Amazon's Fire TV guidance (an Appstore blog post, not the notifications page)
says an app "should not send a Heads-Up notification when another app is in
the foreground". Wick departs from that for the front door and nothing else;
`FRICTION.md` FL-035 says why, and what the guidance leaves unsaid.

**What was checked, on 2026-10-16,** against the deployed stack, in a demo
home made for the run and deleted afterwards, by ringing the demo home's
stand-in doorbell (`POST /api/demo/doorbell`) while another app was in front.

On the Android TV emulator (API 34), with Android TV Settings in front of
Wick:

- the service runs as a foreground service of type `specialUse`, started when
  Wick came on screen, and again by itself after `adb install -r`
  (`MY_PACKAGE_REPLACED`);
- one notification per door card, on the `wick_door` channel at high
  importance, with no sound and no vibration, carrying the card's line
  (*"Someone's at the front door (stand-in doorbell)."*) and *"Open Wick to
  see who it is."*, then — seconds later — the same notification with the
  vision model's sentence (*"A man holding a box stands in front of a
  house."*) and the picture from the door;
- in a home whose language is Spanish: *"Hay alguien en la puerta de entrada
  (timbre simulado)."*, *"Abra Wick para ver quién es."* and *"Abrir Wick"*,
  then the sentence in Spanish (*"Una mujer con un abrigo azul, de pie frente
  a una casa."*);
- the intent the notification carries, sent by hand (`am start` with the same
  component and flag), brought Wick forward over Settings with the door card
  on screen ([screenshot](../../docs/screenshots/door-card-brought-forward-fireos.png)),
  and the notification was gone;
- the notification went at the door card's end, five minutes after the ring;
- when the card was answered on another television in the home, the
  notification on this one was taken down (the server's `revoke` on the
  background connection).

None of that could be *seen* there: the Android TV emulator draws no
third-party notification at all — no heads-up, nothing in its notifications
panel (FL-036) — so it was read from `dumpsys notification`. To see the same
notification drawn and to press it, the same APK was run on an Android phone
emulator (API 34, Google APIs image), paired into the same home as a second
television, with the phone's home screen in front:

- the system asked once whether Wick may send notifications, and *Allow* was
  chosen;
- the ring brought a heads-up with the Spanish line, the vision model's
  sentence, the picture and one button, *Abrir Wick*; in the shade it shows
  the picture full width ([screenshot](../../docs/screenshots/door-notification-android-phone-emulator.png));
- pressing *Abrir Wick* brought Wick forward to the door card, in Spanish, and
  the notification was gone;
- answering the card there (*Ahora no*) took the notification off the TV
  emulator;
- after the phone emulator was restarted, and with Wick not opened, the
  service was started at boot and the next ring put the notification up;
- a note from the family (`send_note_to_tv`) sent while another app was in
  front of both put up nothing on either;
- on the TV emulator, the service ended by itself on a television that was
  not paired, and after the television was disconnected and paired again into
  another home, the next ring there put the notification up.

**What was not seen:** any of it on Fire OS. A phone's system UI is not a
Fire TV's. How it looks on a Fire TV — the heads-up at the bottom of the
screen, which picture becomes its tile, the Menu button's words, the
Notification Center, and whether the service's own notification sits there
or lights the bell on Settings — is unknown: there is no Fire TV and no Fire
OS emulator (FL-025). Nor is what Fire OS does to a foreground service over
hours, or whether it starts one at boot as Android did here. The service's own
notification takes her language from what the app kept when it last started
the service: on a television paired a moment before, that was English until
Wick next came on screen.

## Not a workspace

`apps/tv-fireos` is deliberately left out of the root `package.json`'s
workspaces. Here the name `react-native` is `react-native-tvos`; in
`apps/tv-vega` it is React Native 0.83.0 beside Amazon's own. One hoisted
`node_modules` cannot hold both under one name, so this app installs by itself,
and `metro.config.js` resolves everything the shared source imports from this
directory's `node_modules`.

## What this build does not have

- **What waits for a family member, said while Wick is not on screen.** On
  Vega the background service asks and posts a toast
  (`apps/tv-vega/src/headless/waitingService.ts`). Here the door service ends
  at once on a family member's television, and the app neither starts a
  service for one nor opens the way for one at the pairing service
  (`CARD_SERVICE_URI` is empty in `src/overrides/launchCardService.ts`).
- **Content Personalization** — a Vega API. Fire TV's equivalent is a separate
  integration.
- Amazon Device Messaging, the Fire TV Integration SDK, camera, voice.
- A signing key or an Appstore submission. Both build types are signed with
  the debug key Android's tooling makes on each machine.

## Architectures

`android/gradle.properties` builds `armeabi-v7a` and `arm64-v8a`: Fire TV
devices are ARM, and so is the emulator on an Apple-silicon Mac. An Intel
emulator needs `-PreactNativeArchitectures=x86_64`.
