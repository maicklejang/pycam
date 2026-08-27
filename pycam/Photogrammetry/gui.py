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


The graphical scanner application ("pycam-photo3d gui").

It guides through the three steps of a scan:
  1. take photos of the object while it is rotating on a turntable
  2. reconstruct the 3D model
  3. save the result as an STL file for PyCAM

Tkinter is used for the interface, since it is part of the Python standard library.  The camera
access needs OpenCV, but photos that were taken with any other camera can be imported from a
directory.
"""

import os
import queue
import threading
import traceback

import numpy as np

from pycam.Photogrammetry import capture as capture_module
from pycam.Photogrammetry import preview
from pycam.Photogrammetry.camera import turntable_angles
from pycam.Photogrammetry.images import load_image, resize_to_max
from pycam.Photogrammetry.pipeline import ReconstructionConfig, reconstruct
from pycam.Photogrammetry.session import (CaptureSession, SESSION_FILENAME, TurntableRig,
                                          load_session, session_from_directory)
from pycam.Photogrammetry.silhouette import MASK_METHODS, SilhouetteConfig, extract_mask

PREVIEW_SIZE = 460
CAMERA_INTERVAL = 80


class ScannerApplication:
    """ the main window of the photo scanner """

    def __init__(self, master, directory=None):
        import tkinter
        from tkinter import ttk
        self.tkinter = tkinter
        self.ttk = ttk
        self.master = master
        self.master.title("PyCAM - 3D scan from photos")
        self.device = None
        self.result = None
        self.background_image = None
        self.messages = queue.Queue()
        self.preview_image = None
        self.busy = False
        self.session = CaptureSession(directory or os.path.join(os.path.expanduser("~"),
                                                                "pycam-scan"))
        self.controller = None
        self._build_widgets()
        if directory and os.path.isfile(os.path.join(directory, SESSION_FILENAME)):
            self.load_session(directory)
        else:
            self._update_session_label()
        self.master.after(200, self._process_messages)

    # -- construction of the interface ---------------------------------------------------

    def _build_widgets(self):
        ttk = self.ttk
        tkinter = self.tkinter
        main = ttk.Frame(self.master, padding=8)
        main.pack(fill="both", expand=True)
        left = ttk.Frame(main)
        left.pack(side="left", fill="both", expand=True)
        right = ttk.Frame(main)
        right.pack(side="right", fill="y", padx=(10, 0))

        self.canvas = tkinter.Canvas(left, width=PREVIEW_SIZE, height=PREVIEW_SIZE,
                                     background="#1c1e24", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas_text = self.canvas.create_text(PREVIEW_SIZE / 2, PREVIEW_SIZE / 2,
                                                   fill="#8a8f9a", width=PREVIEW_SIZE - 40,
                                                   justify="center",
                                                   text="Start the camera or open a directory "
                                                        "with photos of your object.")
        self.canvas_image = self.canvas.create_image(PREVIEW_SIZE / 2, PREVIEW_SIZE / 2)

        view = ttk.Frame(left)
        view.pack(fill="x", pady=(6, 0))
        self.show_silhouette = tkinter.BooleanVar(value=True)
        ttk.Checkbutton(view, text="show silhouette", variable=self.show_silhouette).pack(
            side="left")
        self.rotation = tkinter.DoubleVar(value=35.0)
        ttk.Scale(view, from_=0.0, to=360.0, variable=self.rotation, orient="horizontal",
                  command=lambda _value: self._draw_model()).pack(side="right", fill="x",
                                                                  expand=True, padx=(10, 0))
        ttk.Label(view, text="turn model:").pack(side="right")

        self._build_session_panel(right)
        self._build_capture_panel(right)
        self._build_setup_panel(right)
        self._build_reconstruction_panel(right)

        status = ttk.Frame(self.master, padding=(8, 0, 8, 8))
        status.pack(fill="both")
        self.progress = ttk.Progressbar(status, mode="determinate", maximum=100.0)
        self.progress.pack(fill="x")
        self.log_widget = tkinter.Text(status, height=7, wrap="word", state="disabled")
        self.log_widget.pack(fill="both", expand=True, pady=(6, 0))

    def _build_session_panel(self, parent):
        ttk = self.ttk
        frame = ttk.LabelFrame(parent, text="1. session", padding=6)
        frame.pack(fill="x")
        self.session_label = ttk.Label(frame, text="", wraplength=230, justify="left")
        self.session_label.pack(fill="x")
        ttk.Button(frame, text="new session directory ...",
                   command=self.choose_session_directory).pack(fill="x", pady=(6, 0))
        ttk.Button(frame, text="open existing session ...",
                   command=self.open_session_directory).pack(fill="x", pady=(3, 0))
        ttk.Button(frame, text="import photos from folder ...",
                   command=self.import_photo_directory).pack(fill="x", pady=(3, 0))

    def _build_capture_panel(self, parent):
        ttk = self.ttk
        tkinter = self.tkinter
        frame = ttk.LabelFrame(parent, text="2. photos", padding=6)
        frame.pack(fill="x", pady=(8, 0))
        row = ttk.Frame(frame)
        row.pack(fill="x")
        ttk.Label(row, text="camera:").pack(side="left")
        self.device_index = tkinter.IntVar(value=0)
        spinbox = ttk.Spinbox(row, from_=0, to=8, width=4, textvariable=self.device_index)
        spinbox.pack(side="left", padx=4)
        self.camera_button = ttk.Button(row, text="start camera", command=self.toggle_camera)
        self.camera_button.pack(side="right")
        row = ttk.Frame(frame)
        row.pack(fill="x", pady=(6, 0))
        ttk.Label(row, text="photos per turn:").pack(side="left")
        self.shot_count = tkinter.IntVar(value=24)
        ttk.Spinbox(row, from_=4, to=180, width=5, textvariable=self.shot_count,
                    command=self._update_session_label).pack(side="right")
        self.background_button = ttk.Button(frame, text="reference photo (empty turntable)",
                                            command=self.capture_background)
        self.background_button.pack(fill="x", pady=(6, 0))
        self.shot_button = ttk.Button(frame, text="take photo", command=self.capture_shot)
        self.shot_button.pack(fill="x", pady=(3, 0))
        ttk.Button(frame, text="delete last photo", command=self.remove_last_shot).pack(
            fill="x", pady=(3, 0))
        if not capture_module.is_available():
            self.camera_button.state(["disabled"])
            self.background_button.state(["disabled"])
            self.shot_button.state(["disabled"])
            ttk.Label(frame, text="install 'python3-opencv' to use a camera directly",
                      wraplength=230, foreground="#a04030").pack(fill="x", pady=(6, 0))

    def _build_setup_panel(self, parent):
        frame = self.ttk.LabelFrame(parent, text="3. setup (mm)", padding=6)
        frame.pack(fill="x", pady=(8, 0))
        self.rig_variables = {}
        for key, label, default in (("distance", "camera distance", 300.0),
                                    ("height", "camera height", 150.0),
                                    ("object_diameter", "object diameter", 120.0),
                                    ("object_height", "object height", 120.0),
                                    ("field_of_view", "field of view (deg)", 60.0)):
            row = self.ttk.Frame(frame)
            row.pack(fill="x", pady=1)
            self.ttk.Label(row, text=label + ":").pack(side="left")
            variable = self.tkinter.DoubleVar(value=default)
            self.ttk.Entry(row, textvariable=variable, width=8).pack(side="right")
            self.rig_variables[key] = variable
        self.clockwise = self.tkinter.BooleanVar(value=False)
        self.ttk.Checkbutton(frame, text="turntable rotates clockwise",
                             variable=self.clockwise).pack(fill="x", pady=(4, 0))

    def _build_reconstruction_panel(self, parent):
        ttk = self.ttk
        tkinter = self.tkinter
        frame = ttk.LabelFrame(parent, text="4. model", padding=6)
        frame.pack(fill="x", pady=(8, 0))
        row = ttk.Frame(frame)
        row.pack(fill="x")
        ttk.Label(row, text="detail:").pack(side="left")
        self.resolution = tkinter.IntVar(value=160)
        ttk.Spinbox(row, from_=40, to=400, increment=20, width=6,
                    textvariable=self.resolution).pack(side="right")
        row = ttk.Frame(frame)
        row.pack(fill="x", pady=(4, 0))
        ttk.Label(row, text="separation:").pack(side="left")
        self.method = tkinter.StringVar(value="auto")
        ttk.Combobox(row, textvariable=self.method, values=list(MASK_METHODS), width=10,
                     state="readonly").pack(side="right")
        self.reconstruct_button = ttk.Button(frame, text="build 3D model",
                                             command=self.start_reconstruction)
        self.reconstruct_button.pack(fill="x", pady=(8, 0))
        self.save_button = ttk.Button(frame, text="save STL ...", command=self.save_model)
        self.save_button.pack(fill="x", pady=(3, 0))
        self.save_button.state(["disabled"])

    # -- session handling ----------------------------------------------------------------

    def log(self, message):
        self.log_widget.configure(state="normal")
        self.log_widget.insert("end", "{}\n".format(message))
        self.log_widget.see("end")
        self.log_widget.configure(state="disabled")

    def _update_session_label(self):
        text = "{}\n{} photos".format(self.session.directory, len(self.session))
        if self.session.background:
            text += ", reference photo"
        self.session_label.configure(text=text)

    def _sync_rig_from_widgets(self):
        try:
            values = {key: float(variable.get())
                      for key, variable in self.rig_variables.items()}
        except (ValueError, self.tkinter.TclError):
            self.log("please enter numbers into the setup fields")
            return False
        self.session.rig = TurntableRig(distance=values["distance"], height=values["height"],
                                        clockwise=bool(self.clockwise.get()),
                                        object_diameter=values["object_diameter"],
                                        object_height=values["object_height"])
        self.session.field_of_view = values["field_of_view"]
        return True

    def _sync_widgets_from_rig(self):
        rig = self.session.rig
        for key, value in (("distance", rig.distance), ("height", rig.height),
                           ("object_diameter", rig.object_diameter),
                           ("object_height", rig.object_height),
                           ("field_of_view", self.session.field_of_view)):
            self.rig_variables[key].set(value)
        self.clockwise.set(rig.clockwise)

    def _use_session(self, session):
        self.session = session
        self.controller = capture_module.CaptureController(session=session)
        self.background_image = None
        self._sync_widgets_from_rig()
        self._update_session_label()

    def choose_session_directory(self):
        from tkinter import filedialog
        directory = filedialog.askdirectory(title="directory for the photos of this object")
        if not directory:
            return
        self._use_session(CaptureSession(directory))
        self.log("new session in {}".format(directory))

    def open_session_directory(self):
        from tkinter import filedialog
        directory = filedialog.askdirectory(title="open an existing capture session")
        if directory:
            self.load_session(directory)

    def load_session(self, directory):
        try:
            self._use_session(load_session(directory))
        except Exception as exc:
            self.log("failed to open the session: {}".format(exc))
            return
        self.log("opened {} ({} photos)".format(directory, len(self.session)))

    def import_photo_directory(self):
        from tkinter import filedialog
        directory = filedialog.askdirectory(title="directory with photos of one full turn")
        if not directory:
            return
        try:
            session = session_from_directory(directory, rig=self.session.rig,
                                             field_of_view=self.session.field_of_view)
        except Exception as exc:
            self.log("failed to import the photos: {}".format(exc))
            return
        self._use_session(session)
        self.session.save()
        self.log("imported {} photos from {}".format(len(session), directory))
        self._show_image(load_image(session.image_paths[0]))

    # -- camera --------------------------------------------------------------------------

    def toggle_camera(self):
        if self.device is not None:
            self.stop_camera()
            return
        try:
            self.device = capture_module.CameraDevice(index=int(self.device_index.get())).open()
        except Exception as exc:
            self.device = None
            self.log("failed to open the camera: {}".format(exc))
            return
        self.camera_button.configure(text="stop camera")
        self.log("camera {} started".format(self.device_index.get()))
        self._poll_camera()

    def stop_camera(self):
        if self.device is not None:
            self.device.close()
            self.device = None
        self.camera_button.configure(text="start camera")

    def _poll_camera(self):
        if self.device is None:
            return
        try:
            frame = self.device.grab()
        except Exception as exc:
            self.log("camera error: {}".format(exc))
            self.stop_camera()
            return
        if not self.busy:
            self._show_image(frame, with_silhouette=self.show_silhouette.get())
        self.master.after(CAMERA_INTERVAL, self._poll_camera)

    def _require_camera(self):
        if self.device is None:
            self.log("please start the camera first")
            return False
        return True

    def capture_background(self):
        if not self._require_camera():
            return
        image = self.device.grab_stable()
        if self.controller is None:
            self.controller = capture_module.CaptureController(session=self.session)
        self.controller.store_background(image)
        self.background_image = image
        self.controller.save()
        self._update_session_label()
        self.log("reference photo stored (sharpness: {:.0f})"
                 .format(capture_module.sharpness(image)))

    def capture_shot(self):
        if not self._require_camera():
            return
        if self.controller is None:
            self.controller = capture_module.CaptureController(session=self.session)
        count = max(int(self.shot_count.get()), 2)
        index = len(self.session)
        if index >= count:
            self.log("all {} photos of this turn were taken already".format(count))
            return
        angle = turntable_angles(count)[index]
        image = self.device.grab_stable()
        self.controller.store_shot(image, angle)
        self.controller.save()
        self._update_session_label()
        remaining = count - len(self.session)
        if remaining > 0:
            self.log("photo {}/{} at {:.1f} degrees - turn the table by {:.1f} degrees"
                     .format(index + 1, count, angle, 360.0 / count))
        else:
            self.log("photo {}/{} - the turn is complete, you can build the model now"
                     .format(index + 1, count))

    def remove_last_shot(self):
        if self.controller is None:
            return
        shot = self.controller.remove_last_shot()
        if shot is None:
            self.log("there is no photo to remove")
            return
        self.controller.save()
        self._update_session_label()
        self.log("removed {}".format(shot.filename))

    # -- reconstruction ------------------------------------------------------------------

    def start_reconstruction(self):
        if self.busy:
            return
        if len(self.session) < 2:
            self.log("at least two photos are required")
            return
        if not self._sync_rig_from_widgets():
            return
        self.session.save()
        config = ReconstructionConfig(resolution=int(self.resolution.get()),
                                      silhouette=SilhouetteConfig(method=self.method.get()))
        self.busy = True
        self.reconstruct_button.state(["disabled"])
        self.log("building the model from {} photos ...".format(len(self.session)))
        thread = threading.Thread(target=self._run_reconstruction, args=(config,), daemon=True)
        thread.start()

    def _run_reconstruction(self, config):
        def progress(message, ratio):
            self.messages.put(("progress", (message, ratio)))

        try:
            result = reconstruct(self.session, config=config, progress=progress)
        except Exception as exc:
            self.messages.put(("error", "{}: {}".format(type(exc).__name__, exc)))
            self.messages.put(("trace", traceback.format_exc()))
        else:
            self.messages.put(("result", result))

    def _process_messages(self):
        while True:
            try:
                kind, payload = self.messages.get_nowait()
            except queue.Empty:
                break
            if kind == "progress":
                message, ratio = payload
                self.progress.configure(value=100.0 * ratio)
                self.log(message)
            elif kind == "result":
                self._finish_reconstruction(payload)
            elif kind == "error":
                self.busy = False
                self.reconstruct_button.state(["!disabled"])
                self.progress.configure(value=0.0)
                self.log("failed: {}".format(payload))
            elif kind == "trace":
                self.log(payload.strip().splitlines()[-1])
        self.master.after(150, self._process_messages)

    def _finish_reconstruction(self, result):
        self.busy = False
        self.result = result
        self.reconstruct_button.state(["!disabled"])
        self.save_button.state(["!disabled"])
        self.progress.configure(value=100.0)
        self.log(result.mesh.describe())
        for warning in result.warnings:
            self.log("warning: {}".format(warning))
        self._draw_model()

    def save_model(self):
        from tkinter import filedialog
        if self.result is None:
            return
        filename = filedialog.asksaveasfilename(
            title="save the 3D model", defaultextension=".stl",
            initialfile="{}.stl".format(os.path.basename(self.session.directory.rstrip("/"))),
            filetypes=[("STL model", "*.stl"), ("Wavefront OBJ", "*.obj")])
        if not filename:
            return
        if filename.lower().endswith(".obj"):
            self.result.mesh.write_obj(filename)
        else:
            self.result.mesh.write_stl(filename)
        self.log("written to {}".format(filename))

    # -- drawing -------------------------------------------------------------------------

    def _draw_model(self):
        if self.result is None:
            return
        image = preview.render_mesh(self.result.mesh, azimuth=float(self.rotation.get()),
                                    size=(PREVIEW_SIZE, PREVIEW_SIZE))
        self._show_array(image)

    def _show_image(self, image, with_silhouette=False):
        scaled, _ = resize_to_max(image, PREVIEW_SIZE)
        if with_silhouette:
            try:
                mask = extract_mask(scaled, background=self._scaled_background(scaled.shape),
                                    config=SilhouetteConfig(method=self.method.get()))
            except Exception:
                mask = None
            if mask is not None and mask.any():
                scaled = scaled.copy()
                highlight = np.array((255, 80, 60), dtype=np.float32)
                scaled[mask] = np.clip(0.55 * scaled[mask] + 0.45 * highlight, 0,
                                       255).astype(np.uint8)
        self._show_array(scaled)

    def _scaled_background(self, shape):
        if self.background_image is None:
            return None
        scaled, _ = resize_to_max(self.background_image, max(shape[0], shape[1]))
        if scaled.shape != shape:
            return None
        return scaled

    def _show_array(self, image):
        self.preview_image = preview.to_tk_image(image)
        self.canvas.itemconfigure(self.canvas_image, image=self.preview_image)
        self.canvas.coords(self.canvas_image, self.canvas.winfo_width() / 2,
                           self.canvas.winfo_height() / 2)
        self.canvas.itemconfigure(self.canvas_text, text="")

    def shutdown(self):
        self.stop_camera()
        self.master.destroy()


def run_gui(directory=None):
    """ start the graphical scanner application """
    try:
        import tkinter
    except ImportError:
        print("the graphical scanner requires tkinter - please install 'python3-tk'")
        return 1
    root = tkinter.Tk()
    application = ScannerApplication(root, directory=directory)
    root.protocol("WM_DELETE_WINDOW", application.shutdown)
    root.mainloop()
    return 0
