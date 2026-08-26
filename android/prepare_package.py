#!/usr/bin/env python3
"""
Copyright 2026 PyCAM contributors

This file is part of PyCAM.

PyCAM is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

PyCAM is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with PyCAM.  If not, see <http://www.gnu.org/licenses/>.


Collect the parts of PyCAM that the Android application needs.

Buildozer packages everything below "android/", therefore the required modules are copied
into "android/pycam/" before the build.  Only the modules of the reconstruction are copied -
the graphical desktop interface, the toolpath generation and the file importers stay outside
of the APK.

    python3 android/prepare_package.py            # copy the modules
    python3 android/prepare_package.py --check    # only verify that the copy is complete
"""

import argparse
import os
import re
import shutil
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.realpath(__file__))
REPO_DIR = os.path.dirname(BASE_DIR)
TARGET_DIR = os.path.join(BASE_DIR, "pycam")

# the modules that are needed by "pycam.Photogrammetry" at runtime
MODULES = ("__init__.py",
           "errors.py",
           "Utils/__init__.py",
           "Utils/log.py",
           "Photogrammetry/__init__.py",
           "Photogrammetry/camera.py",
           "Photogrammetry/capture.py",
           "Photogrammetry/carving.py",
           "Photogrammetry/images.py",
           "Photogrammetry/mesh.py",
           "Photogrammetry/pipeline.py",
           "Photogrammetry/preview.py",
           "Photogrammetry/session.py",
           "Photogrammetry/silhouette.py",
           "Photogrammetry/surfacenets.py",
           "Photogrammetry/synthetic.py")


# the version of the APK when the repository carries no release tag
FALLBACK_VERSION = "0.7.0.dev"


def _git(*arguments):
    output = subprocess.check_output(("git",) + arguments, cwd=REPO_DIR,
                                     stderr=subprocess.DEVNULL)
    return output.decode("ascii", "replace").strip()


def _version():
    """ ask git for the version - the APK has no repository to look at """
    try:
        described = _git("describe", "--tags", "--dirty", "--match", "v*")
        return described.lstrip("v").replace("-", ".")
    except (OSError, subprocess.CalledProcessError):
        pass
    try:
        return "{}.{}".format(FALLBACK_VERSION, _git("rev-parse", "--short", "HEAD"))
    except (OSError, subprocess.CalledProcessError):
        return FALLBACK_VERSION


def copy_modules():
    """ copy the required modules into the application directory """
    if os.path.isdir(TARGET_DIR):
        shutil.rmtree(TARGET_DIR)
    for module in MODULES:
        source = os.path.join(REPO_DIR, "pycam", module)
        destination = os.path.join(TARGET_DIR, module)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        shutil.copyfile(source, destination)
    with open(os.path.join(TARGET_DIR, "Version.py"), "w") as out_file:
        out_file.write('VERSION = "{}"\n'.format(_version()))
    return len(MODULES) + 1


def _missing_module(text):
    """ return the name of the module that an ImportError complains about """
    match = re.search(r"No module named '([^']+)'", text)
    return match.group(1) if match else None


def check_modules():
    """ verify that the copied modules are complete

    The copy is imported in a separate process.  A missing third party module (numpy for
    example) is not a packaging problem: those are installed into the APK by buildozer and
    they do not have to be present on the machine that builds the APK.
    """
    missing = [module for module in MODULES
               if not os.path.isfile(os.path.join(TARGET_DIR, module))]
    if missing:
        raise SystemExit("missing modules in {}: {}".format(TARGET_DIR, ", ".join(missing)))
    result = subprocess.run((sys.executable, "-c",
                             "import pycam.Photogrammetry as p; print(p.__file__)"),
                            cwd=BASE_DIR, capture_output=True)
    if result.returncode == 0:
        return "imported {}".format(result.stdout.decode("utf-8", "replace").strip())
    error = result.stderr.decode("utf-8", "replace")
    blocked = _missing_module(error)
    if blocked and not blocked.split(".")[0] == "pycam":
        return ("all files are present - the import was not tried out, since '{}' is not "
                "installed here (buildozer adds it to the APK)".format(blocked))
    raise SystemExit("the copied modules cannot be imported:\n{}".format(error))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[2])
    parser.add_argument("--check", action="store_true",
                        help="only verify an existing copy")
    arguments = parser.parse_args()
    if not arguments.check:
        count = copy_modules()
        print("copied {} modules into {}".format(count, TARGET_DIR))
    print("verified: {}".format(check_modules()))


if __name__ == "__main__":
    main()
