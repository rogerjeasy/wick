package com.wick.tv.media

import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.uimanager.ViewManager

/**
 * `WickFilmSession`, as src/media/native.ts calls it: her film as Android's
 * media session, which is how a Fire TV's Alexa ("Alexa, pause"), the
 * remote's media keys and the system's transport controls reach an app.
 *
 * It decides nothing. JavaScript publishes what the shared session says
 * about the film (apps/tv-vega/src/watch/mediaControls.ts, through
 * src/adapters/mediaControls.ts); each command the session is given goes
 * back to JavaScript as `WickFilmCommand`, and the rules her remote's keys
 * obey decide what it does (apps/tv-vega/src/watch/mediaSession.ts). Nothing
 * here touches the player — that is why react-native-video's own session
 * (its notification controls) is not used: it would drive the player around
 * those rules.
 *
 * There is a session only while a film of hers is on the screen: made when
 * the first state is published, released when JavaScript says there is no
 * film (the film let go, a family member's seat, the app closed).
 */
class FilmSessionModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  /** Every change to the session, and every command from it, on the main thread, in order. */
  private val main = Handler(Looper.getMainLooper())
  private var session: MediaSession? = null
  private var shown: Shown? = null
  /** The last state published, to tell where the film is when a seek arrives. */
  private var published: Published? = null

  override fun getName(): String = NAME

  @ReactMethod
  fun publish(film: ReadableMap, promise: Promise) {
    val next =
        try {
          Film(
              status = film.getString("status")!!,
              positionMs = film.getDouble("positionMs").toLong(),
              speed = film.getDouble("speed").toFloat(),
              durationMs = film.getDouble("durationMs").toLong(),
              contentId = film.getString("contentId") ?: "",
              title = if (film.hasKey("title")) film.getString("title") ?: "" else "",
              description = if (film.hasKey("description")) film.getString("description") ?: "" else "",
              actions = film.getArray("actions")?.toArrayList()?.map { it.toString() } ?: emptyList(),
          )
        } catch (malformed: Exception) {
          promise.reject("film_session_malformed", malformed)
          return
        }
    main.post {
      try {
        show(next)
        promise.resolve(null)
      } catch (failed: Exception) {
        promise.reject("film_session_failed", failed)
      }
    }
  }

  /** No film of hers: the session goes, and with it every way a command could reach her film. */
  @ReactMethod
  fun release(promise: Promise) {
    main.post {
      letGo()
      promise.resolve(null)
    }
  }

  // NativeEventEmitter asks every module it listens to for these two. The events are sent whoever listens.
  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}

  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {}

  override fun invalidate() {
    main.post { letGo() }
    super.invalidate()
  }

  private fun show(film: Film) {
    val s = session ?: makeSession().also { session = it }
    val about = Shown(film.contentId, film.title, film.description, film.durationMs)
    if (about != shown) {
      s.setMetadata(
          MediaMetadata.Builder()
              .putString(MediaMetadata.METADATA_KEY_MEDIA_ID, about.contentId)
              .putString(MediaMetadata.METADATA_KEY_TITLE, about.title)
              .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, about.title)
              .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, about.description)
              .putLong(MediaMetadata.METADATA_KEY_DURATION, about.durationMs)
              .build())
      shown = about
    }
    val at = SystemClock.elapsedRealtime()
    s.setPlaybackState(
        PlaybackState.Builder()
            .setState(FilmTransport.stateOf(film.status), film.positionMs, film.speed, at)
            .setActions(FilmTransport.actionsOf(film.actions))
            .build())
    published = Published(film.positionMs, film.speed, at)
    if (!s.isActive) s.isActive = true
  }

  private fun makeSession(): MediaSession =
      MediaSession(context, TAG).apply {
        // Android 8 and later set both always; Fire OS 6 (Android 7.1) still asks.
        @Suppress("DEPRECATION")
        setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
        setCallback(Commands(), main)
      }

  private fun letGo() {
    session?.let {
      it.isActive = false
      it.release()
    }
    session = null
    shown = null
    published = null
  }

  /** A command, to JavaScript. Without a running app to hear it, it goes nowhere: there is no film to move. */
  private fun say(command: FilmCommand?) {
    if (command == null || session == null) return
    Log.i(TAG, "film_command ${command.name}${command.deltaMs?.let { " $it" } ?: ""}")
    if (!context.hasActiveReactInstance()) return
    val event = Arguments.createMap().apply {
      putString("command", command.name)
      command.deltaMs?.let { putDouble("deltaMs", it.toDouble()) }
    }
    context.emitDeviceEvent(EVENT, event)
  }

  private inner class Commands : MediaSession.Callback() {
    override fun onPlay() = say(FilmCommand(FilmCommand.PLAY))

    override fun onPause() = say(FilmCommand(FilmCommand.PAUSE))

    override fun onStop() = say(FilmCommand(FilmCommand.STOP))

    override fun onFastForward() = say(FilmCommand(FilmCommand.SKIP_FORWARD))

    override fun onRewind() = say(FilmCommand(FilmCommand.SKIP_BACKWARD))

    override fun onSeekTo(pos: Long) {
      val p = published ?: return
      val now = FilmTransport.positionNow(p.positionMs, p.speed, p.atMs, SystemClock.elapsedRealtime())
      say(FilmTransport.commandForSeek(pos, now))
    }

    // Next and previous are not overridden: the session's own do nothing, and nothing is offered for them.

    override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
      val key = keyOf(mediaButtonIntent) ?: return super.onMediaButtonEvent(mediaButtonIntent)
      say(FilmTransport.commandForKey(key.keyCode, key.action == KeyEvent.ACTION_DOWN, key.repeatCount))
      // Every media key is answered here, Wick's or not: none falls through to Android's own reading of it.
      return true
    }
  }

  private fun keyOf(intent: Intent): KeyEvent? =
      if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
      else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)

  private data class Film(
      val status: String,
      val positionMs: Long,
      val speed: Float,
      val durationMs: Long,
      val contentId: String,
      val title: String,
      val description: String,
      val actions: List<String>,
  )

  private data class Shown(val contentId: String, val title: String, val description: String, val durationMs: Long)

  private data class Published(val positionMs: Long, val speed: Float, val atMs: Long)

  companion object {
    const val NAME = "WickFilmSession"
    const val EVENT = "WickFilmCommand"
    private const val TAG = "WickFilmSession"
  }
}

class FilmSessionPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> = listOf(FilmSessionModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
