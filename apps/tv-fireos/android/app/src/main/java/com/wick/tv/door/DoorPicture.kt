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
 * the notification goes up without one.
 */
object DoorPicture {
  private const val TIMEOUT_MS = 4_000
  private const val MOST_BYTES = 4 * 1024 * 1024
  /** Fire TV's tile is 228 x 128 dp; Android TV's big picture is wider. This is plenty for both. */
  private const val WIDEST = 960

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
      val bytes = readAtMost(connection, MOST_BYTES) ?: return null
      decode(bytes)
    } catch (failed: Exception) {
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
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= WIDEST) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
  }
}
