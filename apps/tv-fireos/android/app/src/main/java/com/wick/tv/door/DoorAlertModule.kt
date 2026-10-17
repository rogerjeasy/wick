package com.wick.tv.door

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.uimanager.ViewManager
import java.util.concurrent.Executors

/**
 * `WickDoorAlert`, as src/door/native.ts calls it: start the door service,
 * and put the door's notification up, change it and take it down. It
 * decides nothing — src/door/doorAlert.ts does.
 */
class DoorAlertModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  /** One at a time, in the order asked: a notification changed by its picture must not be overtaken by its first post. */
  private val posting = Executors.newSingleThreadExecutor()

  override fun getName(): String = "WickDoorAlert"

  @ReactMethod
  fun start(listening: String, promise: Promise) {
    try {
      DoorService.start(context, listening)
      promise.resolve(null)
    } catch (refused: Exception) {
      promise.reject("door_service_not_started", refused)
    }
  }

  /** The door task has ended: nothing left to hold. */
  @ReactMethod
  fun ended(promise: Promise) {
    DoorService.taskEnded()
    promise.resolve(null)
  }

  @ReactMethod
  fun show(alert: ReadableMap, promise: Promise) {
    val door =
        try {
          DoorAlert(
              cardId = alert.getString("cardId")!!,
              title = alert.getString("title")!!,
              text = alert.getString("text")!!,
              pictureUrl = if (alert.hasKey("pictureUrl")) alert.getString("pictureUrl") else null,
              openLabel = alert.getString("openLabel")!!,
              endsInMs = alert.getDouble("endsInMs").toLong(),
              quiet = alert.hasKey("quiet") && alert.getBoolean("quiet"),
          )
        } catch (malformed: Exception) {
          promise.reject("door_alert_malformed", malformed)
          return
        }
    posting.execute {
      try {
        val picture = door.pictureUrl?.let { DoorPicture.fetch(it) }
        DoorNotifications.showDoor(context, door, picture)
        promise.resolve(null)
      } catch (failed: Exception) {
        promise.reject("door_alert_failed", failed)
      }
    }
  }

  @ReactMethod
  fun clear(cardId: String, promise: Promise) {
    posting.execute {
      DoorNotifications.clearDoor(context, cardId)
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun clearAll(promise: Promise) {
    posting.execute {
      DoorNotifications.clearAllDoors(context)
      promise.resolve(null)
    }
  }

  override fun invalidate() {
    posting.shutdown()
    super.invalidate()
  }
}

class DoorAlertPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> = listOf(DoorAlertModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
