package com.wick.tv.door

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.lang.ref.WeakReference
import androidx.core.content.ContextCompat
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener

/**
 * The part of Wick that keeps running while another app is in front: an
 * Android foreground service that runs one JavaScript task, the door
 * service (src/door/doorService.ts), for as long as that task holds the
 * television's background connection. When the task ends — the television
 * is not paired, is a family member's, or has been disconnected — the
 * service stops.
 *
 * Like React Native's HeadlessJsTaskService, but it holds no wake lock: a
 * television that has gone to sleep has nobody in front of it to tell, and
 * the connection is taken up again when it wakes. And it runs as a
 * foreground service, without which Android would stop it within a minute
 * of Wick leaving the screen. Its type is `specialUse` (Android 14 and
 * later ask for one): none of Android's named types is a doorbell.
 *
 * Started by the app each time Wick comes on screen (src/overrides/
 * launchCardService.ts), and when the television starts up (StartAtBoot).
 * A start that finds the task running changes nothing.
 */
class DoorService : Service(), HeadlessJsTaskEventListener {
  private var taskId: Int? = null
  private var starting = false
  private var tasks: HeadlessJsTaskContext? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    current = WeakReference(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    intent?.getStringExtra(EXTRA_LISTENING)?.let { remember(this, it) }
    try {
      val notification = DoorNotifications.listening(this, listeningText(this))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(DoorNotifications.LISTENING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(DoorNotifications.LISTENING_ID, notification)
      }
    } catch (refused: Exception) {
      // Android 12 and later refuse a foreground service started from behind another app — a restart by the
      // system, say. Then there is no door outside Wick until Wick is next on screen, which starts it again.
      Log.w(TAG, "door_service_not_allowed", refused)
      stopSelf()
      return START_NOT_STICKY
    }
    if (taskId == null && !starting) startTask()
    return START_STICKY
  }

  private fun startTask() {
    starting = true
    val host = (application as ReactApplication).reactHost
    if (host == null) {
      Log.w(TAG, "door_service_no_react_host")
      finish()
      return
    }
    val current = host.currentReactContext
    if (current != null) {
      runTask(current)
      return
    }
    host.addReactInstanceEventListener(
        object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) {
            host.removeReactInstanceEventListener(this)
            runTask(context)
          }
        }
    )
    host.start()
  }

  private fun runTask(context: ReactContext) {
    UiThreadUtil.runOnUiThread {
      val headless = HeadlessJsTaskContext.getInstance(context)
      headless.addTaskEventListener(this)
      tasks = headless
      // No timeout, and allowed while Wick is on screen: the task is the connection, for as long as there is one.
      taskId = headless.startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true))
      starting = false
    }
  }

  override fun onHeadlessJsTaskStart(taskId: Int) = Unit

  // React Native 0.83's new architecture does not register the module a Headless JS task reports its end through
  // (HeadlessJsTaskSupport is in no package), so this is never called today. The task says so itself instead
  // (taskEnded, from DoorAlertModule). Kept for the day React Native calls it.
  override fun onHeadlessJsTaskFinish(taskId: Int) {
    if (taskId != this.taskId) return
    taskEnded()
  }

  private fun taskEnded() {
    Log.i(TAG, "door_task_ended")
    val ended = taskId ?: return
    taskId = null
    tasks?.finishTask(ended)
    finish()
  }

  private fun finish() {
    starting = false
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    tasks?.removeTaskEventListener(this)
    tasks = null
    if (current?.get() === this) current = null
    super.onDestroy()
  }

  companion object {
    private const val TAG = "WickDoorService"
    /** The Headless JS task index.js registers (src/door/task.ts DOOR_TASK). */
    const val TASK = "WickDoorService"
    private const val EXTRA_LISTENING = "listening"
    private const val PREFS = "wick_door"
    private const val PREF_LISTENING = "listening"
    private const val LISTENING_FALLBACK = "Wick will tell you when someone is at the door."
    @Volatile private var current: WeakReference<DoorService>? = null

    /** The door task has nothing left to hold (src/door/task.ts): the service stops. */
    fun taskEnded() {
      UiThreadUtil.runOnUiThread { current?.get()?.taskEnded() }
    }

    /** `listening`: the quiet notification's sentence, in her language — kept for a start at boot, before the app has run. */
    fun start(context: Context, listening: String?) {
      val intent = Intent(context, DoorService::class.java)
      if (listening != null) intent.putExtra(EXTRA_LISTENING, listening)
      ContextCompat.startForegroundService(context, intent)
    }

    private fun remember(context: Context, listening: String) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(PREF_LISTENING, listening).apply()
    }

    private fun listeningText(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREF_LISTENING, null) ?: LISTENING_FALLBACK
  }
}
