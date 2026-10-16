package com.wick.tv.door

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * The picture from the door, fetched for the notification. Its address is
 * the short-lived one the server signed for this card; the picture is held
 * in memory for as long as it takes to post, and written nowhere (INV-3).
 *
 * Best effort: no picture in a few seconds, or anything odd about it, and
 * the notification goes up without one. This runs in the foreground service
 * that holds the door, so what it may cost is bounded twice: the bytes read
 * (PictureLimits.MOST_BYTES, refused up front when the server says more), and
 * the image decoded (PictureLimits.sampleFor, on both sides and on the count
 * of pixels).
 */
object DoorPicture {
  private const val TIMEOUT_MS = 4_000

  fun fetch(address: String): Bitmap? {
    if (!address.startsWith("https://")) return null
    var connection: HttpURLConnection? = null
    return try {
      connection = (URL(address).openConnection() as HttpURLConnection).apply {
        connectTimeout = TIMEOUT_MS
        readTimeout = TIMEOUT_MS
        instanceFollowRedirects = false
      }
      if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
      if (!PictureLimits.lengthAllowed(connection.contentLengthLong)) return null
      val bytes = readAtMost(connection, PictureLimits.MOST_BYTES) ?: return null
      decode(bytes)
    } catch (failed: Exception) {
      null
    } catch (outOfMemory: OutOfMemoryError) {
      null
    } finally {
      connection?.disconnect()
    }
  }

  private fun readAtMost(connection: HttpURLConnection, most: Int): ByteArray? {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(16 * 1024)
    connection.inputStream.use { input ->
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        out.write(buffer, 0, read)
        if (out.size() > most) return null
      }
    }
    return out.toByteArray()
  }

  private fun decode(bytes: ByteArray): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val sample = PictureLimits.sampleFor(bounds.outWidth, bounds.outHeight) ?: return null
    val picture = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    // The decoder may round a sample down; what came out is held to the same cap as what was asked for.
    if (!PictureLimits.decodedAllowed(picture.width, picture.height)) {
      picture.recycle()
      return null
    }
    return picture
  }
}

/** What a door picture may cost. Pure, so it is tested without Android (src/test/.../PictureLimitsTest.kt). */
object PictureLimits {
  /** The most bytes read for one picture. A door frame is about 100 KB. */
  const val MOST_BYTES = 4 * 1024 * 1024
  /** Neither side of the decoded picture is larger than these, and its pixels no more than their product. */
  const val WIDEST = 1920
  const val TALLEST = 1080
  const val MOST_PIXELS = WIDEST.toLong() * TALLEST
  /** Past this the picture is not sampled down further, but refused: nothing a door camera sends is that large. */
  private const val LARGEST_SAMPLE = 64

  /** `Content-Length` as Android reads it: -1 when the server did not say, which is allowed and bounded as it is read. */
  fun lengthAllowed(contentLength: Long): Boolean = contentLength <= MOST_BYTES

  /**
   * The power-of-two sample that brings the picture within WIDEST x TALLEST,
   * or null when it should not be decoded at all: no size, a nonsense size,
   * or one that would still be too large at the largest sample.
   */
  fun sampleFor(width: Int, height: Int): Int? {
    if (width <= 0 || height <= 0) return null
    var sample = 1
    while (ceilDiv(width, sample) > WIDEST || ceilDiv(height, sample) > TALLEST) {
      sample *= 2
      if (sample > LARGEST_SAMPLE) return null
    }
    return if (decodedAllowed(ceilDiv(width, sample).toInt(), ceilDiv(height, sample).toInt())) sample else null
  }

  fun decodedAllowed(width: Int, height: Int): Boolean =
      width in 1..WIDEST && height in 1..TALLEST && width.toLong() * height <= MOST_PIXELS

  /** In Long: a side near Int.MAX_VALUE must not wrap round to a small one. */
  private fun ceilDiv(size: Int, by: Int): Long = (size.toLong() + by - 1) / by
}
