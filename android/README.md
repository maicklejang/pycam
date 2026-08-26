# PyCAM 3D scanner for Android

An app that photographs an object on a turntable and turns the photos into a 3D model
(STL) - directly on the phone.  It uses the reconstruction of
[`pycam.Photogrammetry`](../docs/photogrammetry.md); only the user interface is specific to
the phone.

| screen | purpose |
| --- | --- |
| home | start a new scan or try the app without a camera |
| setup | distance and height of the phone, size of the object, number of photos, detail |
| capture | live image, reference photo, one button per photo, "check outline" |
| result | progress, rotatable preview of the model, export as STL |

The finished scan is stored in `Android/data/net.sourceforge.pycam.photo3d/files/scans/` on
the internal memory of the phone: the photos, `session.json`, `model.stl` and `model.png`.
No permission is needed for that directory - connect the phone to a computer or use a file
manager to fetch the STL file.


## Building the APK

### with GitHub Actions (no local setup)

The workflow [`android-apk.yml`](../.github/workflows/android-apk.yml) builds the APK.  Start
it under "Actions" -> "Build the Android app" -> "Run workflow" and download the artifact
`pycam-photo3d-apk` when it has finished.  The first build takes about an hour, since the
Android SDK, the NDK, Python and numpy are compiled for ARM; the following builds reuse the
cache.

### locally (Linux)

```
sudo apt-get install --yes python3-pip openjdk-17-jdk zip unzip autoconf libtool \
    pkg-config zlib1g-dev libncurses-dev libffi-dev libssl-dev cmake ccache
pip install buildozer cython==0.29.36

python3 android/prepare_package.py     # collect the modules of PyCAM
cd android
buildozer android debug                # the result is bin/photo3d-*-debug.apk
buildozer android debug deploy run     # build, install via USB and start
```

`prepare_package.py` copies the modules of the reconstruction into `android/pycam/` (that
directory is generated - do not edit it).  Everything else stays outside of the APK, so the
GTK interface and the toolpath generation of PyCAM are not part of the app.

The APK is built for `arm64-v8a`, which covers every phone of the last ten years.  Add
`armeabi-v7a` to `android.archs` in `buildozer.spec` for older devices - that doubles the
build time, since Python and numpy are compiled once per architecture.

### installing the APK

Copy the file onto the phone and open it.  Android asks whether apps from this source may be
installed - the APK is signed with a debug key, therefore it is not accepted by Google Play,
but it installs like any other sideloaded app.


## Trying the app on a computer

The same code runs on a desktop computer, which is the quickest way of looking at it:

```
pip install "kivy[base]" numpy pillow
python3 android/main.py --demo     # a virtual test object, no camera needed
python3 android/main.py            # uses a connected camera (webcam)
```


## Structure

```
android/
    main.py                     entry point (also usable on a desktop computer)
    buildozer.spec              build configuration of the APK
    prepare_package.py          collects the modules of PyCAM for the build
    data/icon.png               the icon (a model that the scanner produced itself)
    photo3d/
        app.py                  the application and the state of a scan
        screens.py              home, setup, capture and result screen
        camera_provider.py      camera4kivy (Android), Kivy camera, virtual demo camera
        analysis.py             the "check outline" feedback
        storage.py              where photos and models are stored
        widgets.py              small building blocks of the interface
```

The camera is used through a provider, so the app also runs where no camera exists: the demo
provider renders a virtual object on a turntable and is used by the automated interface test
(`pycam/Test/test_android_app.py`).


## Known limitations

* The reconstruction is a "shape from silhouette" method: concave details that never appear in
  an outline (the inside of a cup, a hole in the top) are filled up.
* A scan takes about half a minute to two minutes on a phone, depending on the detail level.
* The interface is in English.
