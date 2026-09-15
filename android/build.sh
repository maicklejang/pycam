#!/bin/sh
#
# Build the Android application.
#
#     ./build.sh                     # build bin/*.apk (buildozer android debug)
#     ./build.sh android debug deploy run    # build, install via USB and start
#
# Use this script instead of calling buildozer directly: it collects the modules of PyCAM for
# the APK and applies "pip-constraints.txt", without which the build fails while installing
# the pip dependencies of Kivy (the file explains why).

set -e

cd "$(dirname "$0")"

python3 prepare_package.py

if [ "$#" -eq 0 ]; then
    set -- android debug
fi

echo "running: buildozer $*"
exec env PIP_CONSTRAINT="$(pwd)/pip-constraints.txt" buildozer "$@"
