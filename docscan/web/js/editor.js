/* The manual page region editor.
 *
 * After every shot the captured photo is shown here with the detected outline
 * already in place, so the usual gesture is a glance and a tap on 확인.  What
 * the automatic detection cannot know - a page on a busy desk, a torn edge, a
 * book that curls - is a drag away: the four corners set the region and the
 * four edge handles bend the edges, which is what the flattening follows.
 */

import { CurvedQuad } from "./curve.js";
import { findDocument } from "./detect.js";
import { refineEdges } from "./curve.js";
import { matFromSource } from "./mat.js";

const HANDLE_RADIUS = 13;          // drawn size
const GRAB_RADIUS = 30;            // finger sized hit area
const LOUPE_RADIUS = 58;
const LOUPE_ZOOM = 2.6;

const ui = {};

function grab(id) {
  if (!ui[id]) ui[id] = document.getElementById(id);
  return ui[id];
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/** Corners plus the point each edge passes through - what the user drags. */
class Outline {
  constructor(corners, midpoints) {
    this.corners = corners.map((point) => point.slice());
    this.midpoints = midpoints
      ? midpoints.map((point) => point.slice())
      : corners.map((corner, index) => {
        const next = corners[(index + 1) % 4];
        return [(corner[0] + next[0]) / 2, (corner[1] + next[1]) / 2];
      });
  }

  static fromCurved(curved) {
    return new Outline(curved.corners, curved.midpoints);
  }

  toCurved() {
    return CurvedQuad.fromMidpoints(this.corners, this.midpoints);
  }

  /** Move a corner and carry the two edges it belongs to with it. */
  moveCorner(index, x, y) {
    const deltaX = x - this.corners[index][0];
    const deltaY = y - this.corners[index][1];
    this.corners[index] = [x, y];
    for (const edge of [index, (index + 3) % 4]) {
      this.midpoints[edge][0] += deltaX / 2;
      this.midpoints[edge][1] += deltaY / 2;
    }
  }

  moveMidpoint(index, x, y) {
    this.midpoints[index] = [x, y];
  }

  straighten() {
    this.midpoints = this.corners.map((corner, index) => {
      const next = this.corners[(index + 1) % 4];
      return [(corner[0] + next[0]) / 2, (corner[1] + next[1]) / 2];
    });
  }

  get isStraight() {
    return this.toCurved().isStraight;
  }
}

function defaultOutline(width, height) {
  const inset = 0.12;
  return new Outline([
    [width * inset, height * inset],
    [width * (1 - inset), height * inset],
    [width * (1 - inset), height * (1 - inset)],
    [width * inset, height * (1 - inset)],
  ]);
}

/** Detect the page in a photo; falls back to a centred rectangle. */
function detectOutline(photo) {
  const image = matFromSource(photo);
  try {
    const found = findDocument(image, {});
    if (!found) return { outline: defaultOutline(photo.width, photo.height), found: false };
    return { outline: Outline.fromCurved(refineEdges(image, found.quad)), found: true };
  } finally {
    image.delete();
  }
}

/**
 * Show the editor for `photo` and resolve with what the user chose:
 * `{ outline, flatten }`, or null when they backed out.
 */
export function openEditor(photo, { flatten = true, detect = true } = {}) {
  const section = grab("editor");
  const canvas = grab("editor-canvas");
  const hint = grab("editor-hint");
  const context = canvas.getContext("2d");

  const detected = detect ? detectOutline(photo) : null;
  const state = {
    outline: detected ? detected.outline : defaultOutline(photo.width, photo.height),
    flatten,
    dragging: null,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  };

  const size = grab("editor-size");
  // the shot's own resolution, which is what decides whether small print
  // survives: a preview frame and a real still are worlds apart
  size.textContent = `${photo.width}×${photo.height}`;

  hint.textContent = detected && !detected.found
    ? "문서를 찾지 못했습니다 — 모서리를 직접 맞춰주세요"
    : "모서리를 끌어 맞추고, 변의 손잡이로 휜 정도를 조절하세요";

  function layout() {
    const stage = canvas.parentElement.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const scale = Math.min(stage.width / photo.width, stage.height / photo.height);
    const width = Math.max(1, Math.floor(photo.width * scale));
    const height = Math.max(1, Math.floor(photo.height * scale));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    state.scale = (width * ratio) / photo.width;
    state.offsetX = 0;
    state.offsetY = 0;
  }

  const toCanvas = (point) => [point[0] * state.scale, point[1] * state.scale];
  const toPhoto = (x, y) => [x / state.scale, y / state.scale];

  function drawLoupe(point) {
    const [x, y] = toCanvas(point);
    // keep the magnifier away from the finger
    const cx = x < canvas.width / 2 ? canvas.width - LOUPE_RADIUS - 12 : LOUPE_RADIUS + 12;
    const cy = LOUPE_RADIUS + 12;
    context.save();
    context.beginPath();
    context.arc(cx, cy, LOUPE_RADIUS, 0, Math.PI * 2);
    context.closePath();
    context.fillStyle = "#000";
    context.fill();
    context.clip();
    const span = (LOUPE_RADIUS * 2) / LOUPE_ZOOM / state.scale;
    context.drawImage(photo, point[0] - span / 2, point[1] - span / 2, span, span,
                      cx - LOUPE_RADIUS, cy - LOUPE_RADIUS,
                      LOUPE_RADIUS * 2, LOUPE_RADIUS * 2);
    context.strokeStyle = "#35c26a";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(cx - 14, cy);
    context.lineTo(cx + 14, cy);
    context.moveTo(cx, cy - 14);
    context.lineTo(cx, cy + 14);
    context.stroke();
    context.restore();
    context.beginPath();
    context.arc(cx, cy, LOUPE_RADIUS, 0, Math.PI * 2);
    context.strokeStyle = "#fff";
    context.lineWidth = 2;
    context.stroke();
  }

  function draw() {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(photo, 0, 0, canvas.width, canvas.height);

    const corners = state.outline.corners.map(toCanvas);
    const curved = state.outline.toCurved();
    const controls = curved.controls.map(toCanvas);

    context.beginPath();
    context.moveTo(corners[0][0], corners[0][1]);
    for (let index = 0; index < 4; index += 1) {
      const next = corners[(index + 1) % 4];
      context.quadraticCurveTo(controls[index][0], controls[index][1], next[0], next[1]);
    }
    context.closePath();
    context.fillStyle = "rgba(53, 194, 106, 0.16)";
    context.fill();
    context.strokeStyle = "#35c26a";
    context.lineWidth = 3;
    context.stroke();

    const midpoints = state.outline.midpoints.map(toCanvas);
    midpoints.forEach(([x, y]) => {
      context.beginPath();
      context.arc(x, y, HANDLE_RADIUS - 3, 0, Math.PI * 2);
      context.fillStyle = "rgba(255, 224, 102, 0.95)";
      context.fill();
      context.strokeStyle = "#0f1115";
      context.lineWidth = 2;
      context.stroke();
    });
    corners.forEach(([x, y]) => {
      context.beginPath();
      context.arc(x, y, HANDLE_RADIUS, 0, Math.PI * 2);
      context.fillStyle = "#35c26a";
      context.fill();
      context.strokeStyle = "#fff";
      context.lineWidth = 2.5;
      context.stroke();
    });

    if (state.dragging) {
      const point = state.dragging.kind === "corner"
        ? state.outline.corners[state.dragging.index]
        : state.outline.midpoints[state.dragging.index];
      drawLoupe(point);
    }
  }

  function hitTest(x, y) {
    const limit = GRAB_RADIUS * (window.devicePixelRatio || 1);
    let best = null;
    state.outline.corners.forEach((corner, index) => {
      const [cx, cy] = toCanvas(corner);
      const distance = Math.hypot(cx - x, cy - y);
      if (distance <= limit && (!best || distance < best.distance)) {
        best = { kind: "corner", index, distance };
      }
    });
    state.outline.midpoints.forEach((point, index) => {
      const [cx, cy] = toCanvas(point);
      const distance = Math.hypot(cx - x, cy - y);
      if (distance <= limit && (!best || distance < best.distance)) {
        best = { kind: "midpoint", index, distance };
      }
    });
    return best;
  }

  return new Promise((resolve) => {
    const finish = (value) => {
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      buttons.forEach(([element, handler]) => element.removeEventListener("click", handler));
      section.hidden = true;
      resolve(value);
    };

    const pointOf = (event) => {
      const box = canvas.getBoundingClientRect();
      const ratio = canvas.width / box.width;
      return [(event.clientX - box.left) * ratio, (event.clientY - box.top) * ratio];
    };

    function onDown(event) {
      const [x, y] = pointOf(event);
      const hit = hitTest(x, y);
      if (!hit) return;
      state.dragging = hit;
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      draw();
    }

    function onMove(event) {
      if (!state.dragging) return;
      const [x, y] = pointOf(event);
      const [photoX, photoY] = toPhoto(x, y);
      const limitX = clamp(photoX, 0, photo.width - 1);
      const limitY = clamp(photoY, 0, photo.height - 1);
      if (state.dragging.kind === "corner") {
        state.outline.moveCorner(state.dragging.index, limitX, limitY);
      } else {
        state.outline.moveMidpoint(state.dragging.index, limitX, limitY);
      }
      event.preventDefault();
      draw();
    }

    function onUp(event) {
      if (!state.dragging) return;
      state.dragging = null;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch (error) { /* the pointer may already be gone */ }
      draw();
    }

    function onResize() {
      layout();
      draw();
    }

    const flattenButton = grab("editor-flatten");
    const setFlatten = (value) => {
      state.flatten = value;
      flattenButton.setAttribute("aria-pressed", String(value));
    };

    const buttons = [
      [grab("editor-auto"), () => {
        const result = detectOutline(photo);
        state.outline = result.outline;
        hint.textContent = result.found
          ? "자동으로 다시 찾았습니다"
          : "문서를 찾지 못했습니다 — 모서리를 직접 맞춰주세요";
        draw();
      }],
      [grab("editor-all"), () => {
        state.outline = new Outline([[0, 0], [photo.width - 1, 0],
                                     [photo.width - 1, photo.height - 1],
                                     [0, photo.height - 1]]);
        draw();
      }],
      [grab("editor-straight"), () => {
        state.outline.straighten();
        draw();
      }],
      [flattenButton, () => setFlatten(!state.flatten)],
      [grab("editor-cancel"), () => finish(null)],
      [grab("editor-apply"), () => finish({
        outline: state.outline.toCurved(),
        flatten: state.flatten,
      })],
    ];

    buttons.forEach(([element, handler]) => element.addEventListener("click", handler));
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    window.addEventListener("resize", onResize);

    setFlatten(state.flatten);
    section.hidden = false;
    layout();
    draw();
  });
}

export { Outline };
