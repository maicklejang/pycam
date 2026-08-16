# PyCAM Viewer for Android

A thin native wrapper around [`../mobile`](../mobile), for the one thing a web app
cannot do on Android: appear in the system's **Open with** list, so that tapping an
`.stl`, `.step`/`.stp` or `.dxf` file opens it straight away.

Everything else - the parsers, the renderer, the UI - is the same web app; this
project only adds the Android shell around it.

## Installing

Download the APK from the **android-latest** pre-release on the repository's
Releases page (or from the "Build Android app" workflow run) and open it on the
phone.  Android will ask for permission to install an app from an unknown source,
because the build is signed with Gradle's debug key rather than a store key.

## What it does

* Bundles the web app in the APK, so it runs completely offline.  Nothing is
  fetched from the network and no file leaves the device.
* Serves the app through `WebViewAssetLoader` on `https://appassets.androidplatform.net/`,
  which gives the page a real secure origin - web workers, IndexedDB and WebGL all
  behave exactly as they do in the browser.
* Accepts a file from *Open with* (`ACTION_VIEW`) and from *Share* (`ACTION_SEND`),
  copies it into internal storage and hands it to the page as `?url=/shared/<name>`.
  Only the most recent file is kept.

The intent filters list every media type Android is likely to attach to these
files, `application/octet-stream` included - there is no registered type for STL or
STEP, and file managers disagree about what to use.  The side effect is that the
viewer also shows up for other unrecognised binary files; opening one there simply
produces "unknown file format".

## Building locally

Requires JDK 17 and the Android SDK (`ANDROID_HOME` set):

```sh
gradle --project-dir android assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

The `syncWebApp` task copies `mobile/` into the APK assets, so the web app never
has to be duplicated in the repository - edit it in `mobile/` and rebuild.

## Layout

```
android/
  settings.gradle, build.gradle, gradle.properties
  app/build.gradle                       assets sync + module config
  app/src/main/AndroidManifest.xml       intent filters for STL / STEP / DXF
  app/src/main/java/.../MainActivity.java  WebView host and file intake
  app/src/main/res/                      launcher icon and strings
```
