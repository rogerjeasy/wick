package com.wick.tv.door

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Starts the door service when the television starts, and when Wick has
 * just been updated, so the door is said behind another app without her
 * having to open Wick first. Whether there is anything to listen for is
 * the service's to find out: on a television that is not paired, or is a
 * family member's, it stops at once.
 */
class StartAtBoot : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    try {
      DoorService.start(context, null)
    } catch (refused: Exception) {
      Log.w("WickDoorService", "door_service_not_started_at_boot", refused)
    }
  }
}
