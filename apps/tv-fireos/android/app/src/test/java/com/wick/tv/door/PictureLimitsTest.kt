package com.wick.tv.door

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a door picture may cost the foreground service that holds the door (DoorPicture.kt). */
class PictureLimitsTest {
  @Test
  fun aDoorFrameIsDecodedWhole() {
    assertEquals(1, PictureLimits.sampleFor(832, 474))
    assertEquals(1, PictureLimits.sampleFor(1920, 1080))
  }

  @Test
  fun aLargePictureIsSampledDownOnBothSides() {
    assertEquals(2, PictureLimits.sampleFor(3840, 2160))
    assertEquals(4, PictureLimits.sampleFor(4000, 3000))
    // Tall and narrow: the width alone would say "whole".
    assertEquals(16, PictureLimits.sampleFor(100, 17_000))
  }

  @Test
  fun whatIsSampledDownFitsTheCap() {
    for ((width, height) in listOf(3840 to 2160, 4000 to 3000, 100 to 17_000, 1921 to 1081, 7000 to 7000)) {
      val sample = PictureLimits.sampleFor(width, height)!!
      val w = (width + sample - 1) / sample
      val h = (height + sample - 1) / sample
      assertTrue("$width x $height at $sample", PictureLimits.decodedAllowed(w, h))
    }
  }

  @Test
  fun anExtremePictureIsRefusedNotDecoded() {
    assertNull(PictureLimits.sampleFor(1, 1_000_000))
    assertNull(PictureLimits.sampleFor(200_000, 10))
    assertNull(PictureLimits.sampleFor(Int.MAX_VALUE, Int.MAX_VALUE))
  }

  @Test
  fun aPictureWithNoSizeIsRefused() {
    assertNull(PictureLimits.sampleFor(0, 0))
    assertNull(PictureLimits.sampleFor(-1, 480))
    assertNull(PictureLimits.sampleFor(640, -1))
  }

  @Test
  fun whatTheDecoderGivesBackIsHeldToTheSameCap() {
    assertTrue(PictureLimits.decodedAllowed(1920, 1080))
    assertFalse(PictureLimits.decodedAllowed(1921, 1080))
    assertFalse(PictureLimits.decodedAllowed(1920, 1081))
    assertFalse(PictureLimits.decodedAllowed(0, 10))
  }

  @Test
  fun aBodyTheServerSaysIsTooLargeIsNotRead() {
    assertTrue(PictureLimits.lengthAllowed(-1))
    assertTrue(PictureLimits.lengthAllowed(120_000))
    assertTrue(PictureLimits.lengthAllowed(PictureLimits.MOST_BYTES.toLong()))
    assertFalse(PictureLimits.lengthAllowed(PictureLimits.MOST_BYTES.toLong() + 1))
  }
}
