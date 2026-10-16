package com.wick.tv.door

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.wick.tv.MainActivity
import com.wick.tv.R

/**
 * Wick's two notifications on Fire OS, and the rules they keep.
 *
 * - The door (`wick_door`): "Someone's at the front door." while another app
 *   is in front. High priority, which is what makes Fire OS show it as a
 *   heads-up at the bottom of the screen. It is the only thing Wick ever
 *   puts in front of another app (src/door/doorAlert.ts says when).
 * - Listening (`wick_listening`): the quiet notification Android requires
 *   of a foreground service. Lowest importance: never a heads-up, never a
 *   sound.
 *
 * Neither makes a sound, vibrates, lights a light, sets a colour or puts a
 * badge on Wick's icon (AGENTS.md: no red, no badges, no beeps).
 */
object DoorNotifications {
  const val DOOR_CHANNEL = "wick_door"
  const val LISTENING_CHANNEL = "wick_listening"
  const val LISTENING_ID = 1
  /** Every door notification has this id; its card's id is its tag. */
  const val DOOR_ID = 2

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val door =
        NotificationChannel(DOOR_CHANNEL, "Someone at the door", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "Said only for the front door, while another app is on the screen."
          setSound(null, null)
          enableVibration(false)
          enableLights(false)
          setShowBadge(false)
        }
    val listening =
        NotificationChannel(LISTENING_CHANNEL, "Listening for the door", NotificationManager.IMPORTANCE_MIN).apply {
          description = "Shown while Wick listens for the front door behind another app."
          setSound(null, null)
          enableVibration(false)
          enableLights(false)
          setShowBadge(false)
        }
    manager.createNotificationChannels(listOf(door, listening))
  }

  /** Brings Wick forward. MainActivity is singleTask, so the Wick already running comes to the front, with the card. */
  private fun openWick(context: Context, requestCode: Int): PendingIntent =
      PendingIntent.getActivity(
          context,
          requestCode,
          Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )

  fun listening(context: Context, text: String): Notification {
    ensureChannels(context)
    return NotificationCompat.Builder(context, LISTENING_CHANNEL)
        .setSmallIcon(R.drawable.ic_wick_notification)
        .setContentTitle("Wick")
        .setContentText(text)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setOngoing(true)
        .setShowWhen(false)
        .setSilent(true)
        .setContentIntent(openWick(context, 0))
        .build()
  }

  fun showDoor(context: Context, alert: DoorAlert, picture: Bitmap?) {
    ensureChannels(context)
    val manager = NotificationManagerCompat.from(context)
    // Android 13 and later: not allowed is not allowed. The card is waiting in Wick all the same.
    if (!manager.areNotificationsEnabled()) return
    val open = openWick(context, alert.cardId.hashCode())
    val builder =
        NotificationCompat.Builder(context, DOOR_CHANNEL)
            .setSmallIcon(R.drawable.ic_wick_notification)
            .setContentTitle(alert.title)
            .setContentText(alert.text)
            // Fire TV: high priority is a heads-up ("Urgent"), and an Urgent notification's Menu button says the action.
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(0)
            .setSound(null)
            .setVibrate(null)
            .setAutoCancel(true)
            .setContentIntent(open)
            .addAction(0, alert.openLabel, open)
            // Its card's own life: the app lets a door card go at the same moment.
            .setTimeoutAfter(alert.endsInMs)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
    if (picture != null) {
      // Fire TV draws the large image as the card's tile (16:9); Android TV draws the big picture.
      builder
          .setLargeIcon(picture)
          .setStyle(
              NotificationCompat.BigPictureStyle()
                  .bigPicture(picture)
                  .bigLargeIcon(null as Bitmap?)
                  .setSummaryText(alert.text)
          )
    } else {
      builder.setStyle(NotificationCompat.BigTextStyle().bigText(alert.text))
    }
    try {
      manager.notify(alert.cardId, DOOR_ID, builder.build())
    } catch (refused: SecurityException) {
      // Permission taken away between the check and the post: nothing to show, nothing to break.
    }
  }

  fun clearDoor(context: Context, cardId: String) {
    NotificationManagerCompat.from(context).cancel(cardId, DOOR_ID)
  }

  fun clearAllDoors(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    for (shown in manager.activeNotifications) {
      if (shown.id == DOOR_ID) manager.cancel(shown.tag, shown.id)
    }
  }
}

/** What src/door/doorAlert.ts decided, as it crosses to Android. */
data class DoorAlert(
    val cardId: String,
    val title: String,
    val text: String,
    val pictureUrl: String?,
    val openLabel: String,
    val endsInMs: Long,
)
