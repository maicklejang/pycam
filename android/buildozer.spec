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

# Every requirement here is backed by a recipe of python-for-android.  That matters: as soon
# as a package without a recipe is listed, p4a resolves its dependencies with pip - and the
# dependencies of Kivy pull in "charset-normalizer", whose Android wheel p4a resolves but
# cannot install ("not a supported wheel on this platform").
#
# The camera is therefore used through the provider that Kivy brings along.  To use CameraX
# instead, add "camera4kivy,gestures4kivy" here and the CameraX libraries to
# "android.gradle_dependencies" (see android/README.md) - the application picks camera4kivy
# up automatically as soon as it can be imported.
requirements = python3,kivy,numpy,pillow,android

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
