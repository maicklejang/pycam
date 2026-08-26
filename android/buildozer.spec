# Build configuration of the Android application "PyCAM 3D scanner".
#
#   python3 prepare_package.py     # collect the modules of PyCAM
#   buildozer android debug        # build bin/*.apk
#
# See android/README.md for the complete build instructions.

[app]

title = PyCAM 3D scanner
package.name = photo3d
package.domain = net.sourceforge.pycam

source.dir = .
source.include_exts = py,png,jpg,kv,atlas
source.include_patterns = data/*.png
# the build directories of buildozer must not end up inside of the APK
source.exclude_dirs = tests,bin,.buildozer,__pycache__

version.regex = VERSION = ['"](.*)['"]
version.filename = %(source.dir)s/pycam/Version.py

# "camera4kivy" provides the camera of Android, "android" the permission handling
requirements = python3,kivy==2.3.1,numpy,pillow,camera4kivy,gestures4kivy,android

icon.filename = %(source.dir)s/data/icon.png
orientation = portrait
fullscreen = 0

android.permissions = CAMERA
android.api = 34
android.minapi = 24
android.archs = arm64-v8a,armeabi-v7a
android.allow_backup = True
android.accept_sdk_license = True
android.enable_androidx = True

# CameraX - the libraries that "camera4kivy" builds upon
android.gradle_dependencies = androidx.camera:camera-core:1.3.4, androidx.camera:camera-camera2:1.3.4, androidx.camera:camera-lifecycle:1.3.4, androidx.camera:camera-view:1.3.4, androidx.camera:camera-extensions:1.3.4

[buildozer]

log_level = 2
warn_on_root = 0
