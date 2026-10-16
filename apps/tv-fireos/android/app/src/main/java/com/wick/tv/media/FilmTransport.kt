package com.wick.tv.media

import android.media.session.PlaybackState
import android.view.KeyEvent

/**
 * A command for her film, by the names the Vega app's rules use
 * (apps/tv-vega/src/watch/mediaSession.ts `MediaCommand`). `deltaMs` is how
 * far a skip asks to go; none, and the rules use the remote's own step.
 */
data class FilmCommand(val name: String, val deltaMs: Long? = null) {
  companion object {
    const val PLAY = "play"
    const val PAUSE = "pause"
    const val TOGGLE = "toggle"
    const val STOP = "stop"
    const val START_OVER = "startOver"
    const val SKIP_FORWARD = "skipForward"
    const val SKIP_BACKWARD = "skipBackward"
  }
}

/**
 * What Android's media session is told, and what it is asked, put into the
 * Vega app's words and out of them again. It decides nothing about the film:
 * every command goes on to the same rules as her remote's keys, in
 * JavaScript. Plain values only, so it is tested on the JVM
 * (src/test/.../FilmTransportTest.kt).
 *
 * Two places where Android and Fire TV differ from Vega, and how they are
 * met here:
 *
 * - **Fire TV's Alexa seeks.** "Alexa, rewind", "Alexa, fast-forward" (with
 *   or without a length of time) and "Alexa, restart" all arrive as
 *   `onSeekTo`, with a position Alexa worked out from the one this session
 *   last published; restart is a seek to zero (Amazon's "Voice-enabling
 *   Transport Controls with Media Session API on Fire TV"). Vega's rules have
 *   no seek to a time, only start over and skips by a step. So a seek to zero
 *   is start over, and any other seek is a skip, forward or back, by the
 *   distance from where the film is now — and the rules then do what a skip
 *   does, never past the last second.
 * - **Previous is refused.** On Fire TV "Alexa, previous" asks for the item
 *   before this one; Wick has no playlist, and Vega refuses it too.
 */
object FilmTransport {
  /** The session's state, from the Vega app's playback status. */
  fun stateOf(status: String): Int =
      when (status) {
        "PLAYING" -> PlaybackState.STATE_PLAYING
        "PAUSED" -> PlaybackState.STATE_PAUSED
        "BUFFERING" -> PlaybackState.STATE_BUFFERING
        else -> PlaybackState.STATE_STOPPED
      }

  /**
   * What the session offers, from the Vega app's action names (the shared
   * session's `capabilities.actions`). Start over and the skips are offered
   * as a seek, because that is how Fire TV's Alexa asks for them; the skips
   * also as Android's own fast-forward and rewind, which is what the
   * remote's keys and the system's transport controls send. Nothing else:
   * no next, no previous, one speed.
   */
  fun actionsOf(names: Collection<String>): Long {
    var actions = 0L
    for (name in names) {
      actions =
          actions or
              when (name) {
                "Play" -> PlaybackState.ACTION_PLAY
                "Pause" -> PlaybackState.ACTION_PAUSE
                "TogglePlayPause" -> PlaybackState.ACTION_PLAY_PAUSE
                "Stop" -> PlaybackState.ACTION_STOP
                "StartOver" -> PlaybackState.ACTION_SEEK_TO
                "SkipForward" -> PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_SEEK_TO
                "SkipBackward" -> PlaybackState.ACTION_REWIND or PlaybackState.ACTION_SEEK_TO
                else -> 0L
              }
    }
    return actions
  }

  /**
   * A media key the session was given, as a command — or none. One press is
   * one command: only the key going down counts, and a key held down
   * repeating is not a second press. Play/Pause is the key's own command
   * (Vega's TogglePlayPause), not Android's default reading of it, which
   * would take two quick presses for "next".
   */
  fun commandForKey(keyCode: Int, down: Boolean, repeatCount: Int): FilmCommand? {
    if (!down || repeatCount > 0) return null
    return when (keyCode) {
      KeyEvent.KEYCODE_MEDIA_PLAY -> FilmCommand(FilmCommand.PLAY)
      KeyEvent.KEYCODE_MEDIA_PAUSE -> FilmCommand(FilmCommand.PAUSE)
      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
      KeyEvent.KEYCODE_HEADSETHOOK -> FilmCommand(FilmCommand.TOGGLE)
      KeyEvent.KEYCODE_MEDIA_STOP -> FilmCommand(FilmCommand.STOP)
      KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
      KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD -> FilmCommand(FilmCommand.SKIP_FORWARD)
      KeyEvent.KEYCODE_MEDIA_REWIND,
      KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD -> FilmCommand(FilmCommand.SKIP_BACKWARD)
      // Next, previous, record, eject and the rest: nothing of Wick's.
      else -> null
    }
  }

  /**
   * A seek to `toMs`, when the film is at `nowMs`: start over at zero, a
   * skip by the distance otherwise, and nothing when it is already there.
   */
  fun commandForSeek(toMs: Long, nowMs: Long): FilmCommand? {
    if (toMs <= 0L) return FilmCommand(FilmCommand.START_OVER)
    val distance = toMs - nowMs
    return when {
      distance > 0L -> FilmCommand(FilmCommand.SKIP_FORWARD, distance)
      distance < 0L -> FilmCommand(FilmCommand.SKIP_BACKWARD, -distance)
      else -> null
    }
  }

  /**
   * Where the film is now, by the state last published: its position then,
   * run on at its speed. The same reckoning a controller makes from a
   * `PlaybackState`, so a seek Alexa worked out from it is measured from the
   * same place.
   */
  fun positionNow(positionMs: Long, speed: Float, publishedAtMs: Long, nowMs: Long): Long =
      (positionMs + ((nowMs - publishedAtMs).coerceAtLeast(0L) * speed).toLong()).coerceAtLeast(0L)
}
