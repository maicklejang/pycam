RUN_SCRIPT = ../pycam/run_gui.py
PHOTO3D_RUN_SCRIPT = ../pycam/run_photo3d.py
PYCAM_MAN_INCLUDE_FILE = pycam.1.inc
PHOTO3D_MAN_INCLUDE_FILE = pycam-photo3d.1.inc
MAN_FILES = pycam.1 pycam-photo3d.1
HTML_FILES = $(patsubst %,%.html,$(MAN_FILES))
RM = rm -f


.PHONY: build clean html man


man: $(MAN_FILES)

html: $(HTML_FILES)

pycam.1: $(RUN_SCRIPT) $(PYCAM_MAN_INCLUDE_FILE)
	help2man --no-info --name="Toolpath Generation for 3-Axis CNC machining" \
		--section=1 --manual="PyCAM manual" --include="$(PYCAM_MAN_INCLUDE_FILE)" \
		--output="$@" "$(RUN_SCRIPT)"

pycam-photo3d.1: $(PHOTO3D_RUN_SCRIPT) $(PHOTO3D_MAN_INCLUDE_FILE)
	help2man --no-info --name="3D scanning from photos for PyCAM" \
		--section=1 --manual="PyCAM manual" --include="$(PHOTO3D_MAN_INCLUDE_FILE)" \
		--output="$@" "$(PHOTO3D_RUN_SCRIPT)"

%.html: %
	man2html $* >"$@"

clean:
	$(RM) $(MAN_FILES) $(HTML_FILES)
