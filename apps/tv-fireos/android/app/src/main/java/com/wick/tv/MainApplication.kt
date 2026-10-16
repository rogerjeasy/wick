package com.wick.tv

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.wick.tv.door.DoorAlertPackage
import com.wick.tv.media.FilmSessionPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Wick's own: the door, outside Wick (door/DoorAlertModule.kt).
          add(DoorAlertPackage())
          // Her film as Android's media session: "Alexa, pause" (media/FilmSessionModule.kt).
          add(FilmSessionPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
