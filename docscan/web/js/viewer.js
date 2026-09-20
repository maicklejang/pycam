/* Looking at a captured page full screen.
 *
 * A 104 px thumbnail is enough to tell pages apart and not enough to tell
 * whether the scan is any good, which is exactly what people want to know
 * before they save a PDF.  Tapping a thumbnail opens the page here: pinch or
 * double tap to zoom into the small print, drag to move around, and swipe to
 * the next page without going back to the grid.
 *
 * The overlay owns nothing but the element it is given; the pages, their
 * order and everything that changes them stay in app.js, which passes the
 * actions in.
 */

const MAX_ZOOM = 6;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP = 28;
const SWIPE_DISTANCE = 60;

const ui = {
  root: null,
  image: null,
  stage: null,
  position: null,
  previous: null,
  next: null,
  rotate: null,
  save: null,
  remove: null,
  close: null,
  hint: null,
};

const state = {
  pages: [],
  index: 0,
  actions: {},
  zoom: 1,
  panX: 0,
  panY: 0,
  pointers: new Map(),
  pinch: null,
  drag: null,
  lastTap: 0,
  lastTapAt: [0, 0],
  url: null,
};

/** True while the viewer is on screen. */
export function isOpen() {
  return Boolean(ui.root) && ui.root.open;
}

function clampPan() {
  // keep at least a third of the page inside the stage at any zoom
  const stage = ui.stage.getBoundingClientRect();
  const limitX = Math.max(0, (stage.width * state.zoom - stage.width) / 2);
  const limitY = Math.max(0, (stage.height * state.zoom - stage.height) / 2);
  state.panX = Math.min(limitX, Math.max(-limitX, state.panX));
  state.panY = Math.min(limitY, Math.max(-limitY, state.panY));
}

function applyTransform() {
  clampPan();
  ui.image.style.transform =
    `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  ui.stage.classList.toggle("viewer__stage--zoomed", state.zoom > 1.01);
}

function resetZoom() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  applyTransform();
}

function zoomAt(scale, clientX, clientY) {
  const stage = ui.stage.getBoundingClientRect();
  const wanted = Math.min(MAX_ZOOM, Math.max(1, scale));
  if (Math.abs(wanted - state.zoom) < 1e-3) return;
  // keep the point under the fingers where it is
  const offsetX = clientX - (stage.left + stage.width / 2);
  const offsetY = clientY - (stage.top + stage.height / 2);
  const ratio = wanted / state.zoom;
  state.panX = offsetX - (offsetX - state.panX) * ratio;
  state.panY = offsetY - (offsetY - state.panY) * ratio;
  state.zoom = wanted;
  applyTransform();
}

function show() {
  const page = state.pages[state.index];
  if (!page) { close(); return; }
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(page.blob);
  ui.image.src = state.url;
  ui.image.alt = `${state.index + 1}번째 페이지`;
  ui.position.textContent = `${state.index + 1} / ${state.pages.length}`;
  ui.previous.disabled = state.index === 0;
  ui.next.disabled = state.index >= state.pages.length - 1;
  ui.hint.textContent = `${page.width}×${page.height}`;
  resetZoom();
}

function step(by) {
  const wanted = state.index + by;
  if (wanted < 0 || wanted >= state.pages.length) return;
  state.index = wanted;
  show();
}

function close() {
  // the gallery it opens from is a modal dialog, so this one has to be a
  // dialog as well - anything else would be painted underneath it
  if (ui.root.open) ui.root.close();
}

function forget() {
  if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
  ui.image.removeAttribute("src");
  state.pointers.clear();
  state.pinch = null;
  state.drag = null;
  if (state.actions.onClose) state.actions.onClose();
}

function pointerDistance() {
  const [first, second] = Array.from(state.pointers.values());
  return {
    gap: Math.hypot(second.x - first.x, second.y - first.y),
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function onPointerDown(event) {
  // the arrows sit inside the stage, and capturing the pointer here would
  // retarget their clicks onto it
  if (event.target.closest("button")) return;
  ui.stage.setPointerCapture(event.pointerId);
  state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (state.pointers.size === 2) {
    const centre = pointerDistance();
    state.pinch = { gap: centre.gap, zoom: state.zoom };
    state.drag = null;
    return;
  }
  state.drag = {
    x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY, moved: 0,
  };
}

function onPointerMove(event) {
  if (!state.pointers.has(event.pointerId)) return;
  state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (state.pinch && state.pointers.size === 2) {
    const centre = pointerDistance();
    if (state.pinch.gap > 8) {
      zoomAt(state.pinch.zoom * (centre.gap / state.pinch.gap), centre.x, centre.y);
    }
    return;
  }
  if (!state.drag) return;
  const dx = event.clientX - state.drag.x;
  const dy = event.clientY - state.drag.y;
  state.drag.moved = Math.max(state.drag.moved, Math.hypot(dx, dy));
  if (state.zoom > 1.01) {
    state.panX = state.drag.panX + dx;
    state.panY = state.drag.panY + dy;
    applyTransform();
  }
}

function onPointerUp(event) {
  const down = state.drag;
  state.pointers.delete(event.pointerId);
  if (state.pointers.size < 2) state.pinch = null;
  if (state.pointers.size > 0) return;
  state.drag = null;
  if (!down) return;

  const dx = event.clientX - down.x;
  if (state.zoom <= 1.01 && Math.abs(dx) > SWIPE_DISTANCE
      && Math.abs(dx) > Math.abs(event.clientY - down.y)) {
    step(dx < 0 ? 1 : -1);
    return;
  }
  if (down.moved > 12) return;

  const now = Date.now();
  const near = Math.hypot(event.clientX - state.lastTapAt[0],
                          event.clientY - state.lastTapAt[1]) < DOUBLE_TAP_SLOP;
  if (now - state.lastTap < DOUBLE_TAP_MS && near) {
    state.lastTap = 0;
    if (state.zoom > 1.01) resetZoom();
    else zoomAt(2.6, event.clientX, event.clientY);
    return;
  }
  state.lastTap = now;
  state.lastTapAt = [event.clientX, event.clientY];
}

function onWheel(event) {
  event.preventDefault();
  zoomAt(state.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX, event.clientY);
}

function onKey(event) {
  if (!isOpen()) return;
  if (event.key === "ArrowLeft") step(-1);
  if (event.key === "ArrowRight") step(1);
  if (event.key === "+" || event.key === "=") {
    const box = ui.stage.getBoundingClientRect();
    zoomAt(state.zoom * 1.4, box.left + box.width / 2, box.top + box.height / 2);
  }
  if (event.key === "-" || event.key === "0") resetZoom();
}

/**
 * Wire the overlay once.  `actions` carries what the viewer cannot do itself:
 * `rotate(page)`, `save(page)`, `remove(page)` and `onClose()`, all optional.
 */
export function setupViewer(elements, actions = {}) {
  Object.assign(ui, elements);
  state.actions = actions;

  ui.close.addEventListener("click", close);
  ui.root.addEventListener("close", forget);
  ui.previous.addEventListener("click", () => step(-1));
  ui.next.addEventListener("click", () => step(1));
  ui.stage.addEventListener("pointerdown", onPointerDown);
  ui.stage.addEventListener("pointermove", onPointerMove);
  ui.stage.addEventListener("pointerup", onPointerUp);
  ui.stage.addEventListener("pointercancel", onPointerUp);
  ui.stage.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKey);

  ui.rotate.addEventListener("click", async () => {
    const page = state.pages[state.index];
    if (!page || !actions.rotate) return;
    ui.rotate.disabled = true;
    try {
      await actions.rotate(page);
      show();
    } finally {
      ui.rotate.disabled = false;
    }
  });
  ui.save.addEventListener("click", () => {
    const page = state.pages[state.index];
    if (page && actions.save) actions.save(page);
  });
  ui.remove.addEventListener("click", async () => {
    const page = state.pages[state.index];
    if (!page || !actions.remove) return;
    await actions.remove(page);
    state.pages = state.pages.filter((entry) => entry.id !== page.id);
    if (!state.pages.length) { close(); return; }
    state.index = Math.min(state.index, state.pages.length - 1);
    show();
  });
}

/** Open the overlay on `pages[index]`. */
export function openViewer(pages, index = 0) {
  state.pages = pages.slice();
  state.index = Math.min(Math.max(0, index), Math.max(0, state.pages.length - 1));
  if (!state.pages.length) return;
  if (!ui.root.open) ui.root.showModal();
  show();
}

/** Follow a change made elsewhere (a page removed, the order edited). */
export function refreshViewer(pages) {
  if (!isOpen()) return;
  const current = state.pages[state.index];
  state.pages = pages.slice();
  const found = current ? state.pages.findIndex((page) => page.id === current.id) : -1;
  if (!state.pages.length) { close(); return; }
  state.index = found >= 0 ? found : Math.min(state.index, state.pages.length - 1);
  show();
}
