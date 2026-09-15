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


Where the scanner app stores its photos and its results.

On Android the external directory of the application is used
("/sdcard/Android/data/<package>/files/scans").  It needs no permission and it is reachable
with a file manager or via USB, so the STL files can be copied to a computer.
"""

import datetime
import os


def is_android():
    return "ANDROID_ARGUMENT" in os.environ


def _android_external_directory():
    """ return the external files directory of the application (or None) """
    try:
        from jnius import autoclass
        activity = autoclass("org.kivy.android.PythonActivity").mActivity
        directory = activity.getExternalFilesDir(None)
        if directory is not None:
            return directory.getAbsolutePath()
    except Exception:
        pass
    try:
        from android.storage import app_storage_path
        return app_storage_path()
    except Exception:
        return None


def scans_root():
    """ return the directory that contains all scans """
    base = _android_external_directory() if is_android() else None
    if base is None:
        base = os.path.join(os.path.expanduser("~"), "pycam-scans")
    root = os.path.join(base, "scans")
    os.makedirs(root, exist_ok=True)
    return root


def new_scan_directory(prefix="scan"):
    """ create and return a new directory for one scan """
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    directory = os.path.join(scans_root(), "{}-{}".format(prefix, stamp))
    suffix = 0
    while os.path.exists(directory):
        suffix += 1
        directory = os.path.join(scans_root(), "{}-{}-{}".format(prefix, stamp, suffix))
    os.makedirs(directory)
    return directory


def list_scan_directories():
    """ return the existing scans, newest first """
    root = scans_root()
    entries = [os.path.join(root, name) for name in os.listdir(root)]
    directories = [entry for entry in entries if os.path.isdir(entry)]
    return sorted(directories, reverse=True)


def describe_location(path):
    """ return a short description of a path for the user interface """
    home = os.path.expanduser("~")
    if not is_android() and path.startswith(home):
        return "~" + path[len(home):]
    marker = "/Android/data/"
    if marker in path:
        return path[path.index(marker) + 1:]
    return path
