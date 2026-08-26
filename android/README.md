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
because the build is self-signed rather than signed with a store key.

### Signing

`sideload.keystore` is committed deliberately.  Gradle's default debug keystore is
generated per machine, so two CI runs signed two APKs with two different keys and
Android rejected the second one with *"the package conflicts with an existing
package"*.  A fixed key gives every build one identity, so updates install over the
previous version.  It is a throwaway self-signed key with the password `android` -
it is not a secret and makes no authenticity claim.

`versionCode` follows the CI run number, so each published APK is an upgrade of the
one before it.

## What it does

* Bundles the web app in the APK, so it runs completely offline.  Nothing is
  fetched from the network and no file leaves the device.
* Serves the app through `WebViewAssetLoader` on `https://appassets.androidplatform.net/`,
  which gives the page a real secure origin - web workers, IndexedDB and WebGL all
  behave exactly as they do in the browser.
* Accepts a file from *Open with* (`ACTION_VIEW`) and from *Share* (`ACTION_SEND`),
  copies it into internal storage and hands it to the page as `?url=/shared/<name>`.
  Only the most recent file is kept.

## About the intent filters

Android's media type table has an entry for `.stl` (`application/vnd.ms-pki.stl`) and
for `.dxf` (`image/vnd.dxf`), but none at all for `.step` / `.stp`.  A file manager
opening a STEP file therefore sends an intent with a type nobody declares, or with
no type, and often with a `content://` URI whose path does not even contain the file
name - so neither a media type filter nor a `pathPattern` filter can match it, and
Android reports that no app can open the file.

The manifest works around this in three layers: the known media types, path patterns
for file managers that pass a real path, and finally a `*/*` filter that accepts
anything.  The last one is what makes STEP files openable; the cost is that the
viewer also appears for unrelated files, where it simply reports that the format is
not supported.  The parser sniffs the content, so a file still opens correctly even
when its name or media type is misleading.

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
