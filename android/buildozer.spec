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

# The camera is used through the provider that Kivy brings along.  CameraX can be used
# instead by adding "camera4kivy,gestures4kivy" here plus the CameraX libraries to
# "android.gradle_dependencies" - see android/README.md.
#
# "charset-normalizer" is pinned on purpose.  The recipe of Kivy installs "requests" (and
# friends) with pip, and pip resolves the dependency "charset-normalizer" to its *Android*
# wheel.  python-for-android accepts that wheel while resolving, but installs it afterwards
# with a pip that runs on the build machine, which rejects it:
#
#   ERROR: charset_normalizer-3.5.1-cp314-cp314-android_24_arm64_v8a.whl
#          is not a supported wheel on this platform
#
# Version 3.3.2 publishes no Android wheels, so the pure Python wheel is used and the
# installation succeeds.  The package is only a dependency of "requests", which this
# application never imports.
requirements = python3,kivy,numpy,pillow,android,charset-normalizer==3.3.2

icon.filename = %(source.dir)s/data/icon.png
orientation = portrait
fullscreen = 0

android.permissions = CAMERA
android.api = 34
android.minapi = 24
# every architecture is built separately (Python and numpy are compiled for each of them),
# so only the one that all current phones use is enabled - add "armeabi-v7a" for old devices
android.archs = arm64-v8a
android.allow_backup = True
android.accept_sdk_license = True
android.enable_androidx = True

[buildozer]

log_level = 2
warn_on_root = 0
