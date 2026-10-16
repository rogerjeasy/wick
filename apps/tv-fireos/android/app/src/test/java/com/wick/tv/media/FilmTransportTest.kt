package com.wick.tv.media

import android.media.session.PlaybackState
import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What Android's media session is told about her film, and what its commands become (FilmTransport.kt). */
class FilmTransportTest {
  /** What the shared session offers while the film plays (apps/tv-vega/src/watch/mediaSession.ts sessionView). */
  private val playing = listOf("Pause", "TogglePlayPause", "Stop", "StartOver", "SkipForward", "SkipBackward")

  @Test
  fun theStatusIsAndroidsState() {
    assertEquals(PlaybackState.STATE_PLAYING, FilmTransport.stateOf("PLAYING"))
    assertEquals(PlaybackState.STATE_PAUSED, FilmTransport.stateOf("PAUSED"))
    assertEquals(PlaybackState.STATE_BUFFERING, FilmTransport.stateOf("BUFFERING"))
    assertEquals(PlaybackState.STATE_STOPPED, FilmTransport.stateOf("NOT_PLAYING"))
  }

  @Test
  fun aPlayingFilmOffersPauseTheSkipsAndStartOverAsASeek() {
    val actions = FilmTransport.actionsOf(playing)
    val expected =
        PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_STOP or
            PlaybackState.ACTION_SEEK_TO or
            PlaybackState.ACTION_FAST_FORWARD or
            PlaybackState.ACTION_REWIND
    assertEquals(expected, actions)
    assertEquals(0L, actions and PlaybackState.ACTION_PLAY)
  }

  @Test
  fun nothingIsOfferedForNextPreviousOrSpeed() {
    val actions = FilmTransport.actionsOf(listOf("Play") + playing.drop(1))
    assertEquals(0L, actions and PlaybackState.ACTION_SKIP_TO_NEXT)
    assertEquals(0L, actions and PlaybackState.ACTION_SKIP_TO_PREVIOUS)
    assertEquals(0L, actions and PlaybackState.ACTION_SET_PLAYBACK_SPEED)
    assertEquals(0L, FilmTransport.actionsOf(listOf("Next", "Previous", "Seek")))
  }

  @Test
  fun noFilmOffersNothing() {
    assertEquals(0L, FilmTransport.actionsOf(emptyList()))
  }

  @Test
  fun eachMediaKeyIsTheCommandItsButtonIs() {
    fun press(code: Int) = FilmTransport.commandForKey(code, down = true, repeatCount = 0)?.name
    assertEquals("play", press(KeyEvent.KEYCODE_MEDIA_PLAY))
    assertEquals("pause", press(KeyEvent.KEYCODE_MEDIA_PAUSE))
    assertEquals("toggle", press(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
    assertEquals("toggle", press(KeyEvent.KEYCODE_HEADSETHOOK))
    assertEquals("stop", press(KeyEvent.KEYCODE_MEDIA_STOP))
    assertEquals("skipForward", press(KeyEvent.KEYCODE_MEDIA_FAST_FORWARD))
    assertEquals("skipForward", press(KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD))
    assertEquals("skipBackward", press(KeyEvent.KEYCODE_MEDIA_REWIND))
    assertEquals("skipBackward", press(KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD))
  }

  @Test
  fun aKeySkipNamesNoStepSoTheRemotesOwnIsUsed() {
    assertNull(FilmTransport.commandForKey(KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, true, 0)!!.deltaMs)
  }

  @Test
  fun nextAndPreviousAreRefused() {
    assertNull(FilmTransport.commandForKey(KeyEvent.KEYCODE_MEDIA_NEXT, true, 0))
    assertNull(FilmTransport.commandForKey(KeyEvent.KEYCODE_MEDIA_PREVIOUS, true, 0))
  }

  @Test
  fun onePressIsOneCommand() {
    assertNull(FilmTransport.commandForKey(KeyEvent.KEYCODE_MEDIA_PAUSE, down = false, repeatCount = 0))
    assertNull(FilmTransport.commandForKey(KeyEvent.KEYCODE_MEDIA_PAUSE, down = true, repeatCount = 1))
  }

  @Test
  fun aSeekToZeroIsStartOver() {
    assertEquals(FilmCommand(FilmCommand.START_OVER), FilmTransport.commandForSeek(0, 95_000))
  }

  @Test
  fun anyOtherSeekIsASkipByTheDistance() {
    // "Alexa, rewind thirty seconds", 95 seconds in.
    assertEquals(FilmCommand(FilmCommand.SKIP_BACKWARD, 30_000), FilmTransport.commandForSeek(65_000, 95_000))
    // "Alexa, fast-forward ten seconds".
    assertEquals(FilmCommand(FilmCommand.SKIP_FORWARD, 10_000), FilmTransport.commandForSeek(105_000, 95_000))
    assertNull(FilmTransport.commandForSeek(95_000, 95_000))
  }

  @Test
  fun whereTheFilmIsRunsOnAtItsSpeed() {
    assertEquals(13_000L, FilmTransport.positionNow(10_000, 1f, publishedAtMs = 1_000, nowMs = 4_000))
    assertEquals(10_000L, FilmTransport.positionNow(10_000, 0f, publishedAtMs = 1_000, nowMs = 4_000))
    // A clock that went backwards moves nothing.
    assertEquals(10_000L, FilmTransport.positionNow(10_000, 1f, publishedAtMs = 4_000, nowMs = 1_000))
  }
}
