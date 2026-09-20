/* docscan web app: camera, live outline preview and export.
 *
 * The heavy lifting lives in detect.js / transform.js / enhance.js, which are
 * ports of the python modules of the same name.  This file only wires them to
 * the camera, the canvas overlay and the export buttons.
 */

import { loadOpenCV } from "./cv.js";
import { CurvedQuad, flatten, refineEdges, straightenTextLines } from "./curve.js";
import { openViewer, refreshViewer, setupViewer } from "./viewer.js";
import { findDocument, touchesBorder } from "./detect.js";
import { openEditor } from "./editor.js";
import { MODE_DESCRIPTIONS, MODE_LABELS, MODES, enhance } from "./enhance.js";
import { matFromSource, matToCanvas } from "./mat.js";
import { fourPointTransform } from "./transform.js";
import { buildPdf } from "./pdf.js";
import { clearPages, loadPages, removePage, savePage, savePages } from "./store.js";

const DETECT_SIZE = 400;          // analysis width of the live preview
const DETECT_INTERVAL = 90;       // ms between two live detections
const STABLE_FRAMES = 6;          // detections a page must hold still for
const STABLE_TOLERANCE = 0.015;   // fraction of the frame diagonal
const AUTO_COOLDOWN = 2500;       // ms between two automatic captures
const MARGIN = -0.004;            // crop a hair inside the detected outline

const ui = {
  status: document.getElementById("status"),
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  splash: document.getElementById("splash"),
  splashText: document.getElementById("splash-text"),
  permission: document.getElementById("permission"),
  permissionText: document.getElementById("permission-text"),
  retryCamera: document.getElementById("retry-camera"),
  permissionPick: document.getElementById("permission-pick"),
  flash: document.getElementById("flash"),
  toast: document.getElementById("toast"),
  modes: document.getElementById("modes"),
  shutter: document.getElementById("shutter"),
  auto: document.getElementById("auto"),
  gallery: document.getElementById("gallery"),
  pageCount: document.getElementById("page-count"),
  pick: document.getElementById("pick"),
  manual: document.getElementById("manual"),
  file: document.getElementById("file"),
  torch: document.getElementById("torch"),
  flip: document.getElementById("flip"),
  save: document.getElementById("save"),
  install: document.getElementById("install"),
  sheet: document.getElementById("sheet"),
  sheetCount: document.getElementById("sheet-count"),
  sheetClose: document.getElementById("sheet-close"),
  sheetEmpty: document.getElementById("sheet-empty"),
  sheetPdf: document.getElementById("sheet-pdf"),
  sheetImages: document.getElementById("sheet-images"),
  sheetClear: document.getElementById("sheet-clear"),
  thumbs: document.getElementById("thumbs"),
  viewer: {
    root: document.getElementById("viewer"),
    image: document.getElementById("viewer-image"),
    stage: document.getElementById("viewer-stage"),
    position: document.getElementById("viewer-position"),
    hint: document.getElementById("viewer-hint"),
    previous: document.getElementById("viewer-previous"),
    next: document.getElementById("viewer-next"),
    rotate: document.getElementById("viewer-rotate"),
    save: document.getElementById("viewer-save"),
    remove: document.getElementById("viewer-remove"),
    close: document.getElementById("viewer-close"),
  },
};

const state = {
  cv: null,
  stream: null,
  track: null,
  facing: "environment",
  mode: localStorage.getItem("docscan.mode") || "color",
  auto: localStorage.getItem("docscan.auto") === "1",
  // checking the region by hand after every shot is the default: the detector
  // is good, but it is the user who knows what the page is
  manual: localStorage.getItem("docscan.manual") !== "0",
  flatten: localStorage.getItem("docscan.flatten") !== "0",
  detection: null,
  smoothed: null,
  previousQuad: null,
  stableCount: 0,
  lastDetect: 0,
  lastCapture: 0,
  busy: false,
  pages: [],
  installPrompt: null,
};

/* -- small helpers ------------------------------------------------------- */

function setStatus(text, tone = "") {
  ui.status.textContent = text;
  ui.status.className = "status" + (tone ? " status--" + tone : "");
}

let toastTimer = null;
function toast(text, milliseconds = 1800) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, milliseconds);
}

function flash() {
  ui.flash.hidden = false;
  ui.flash.style.animation = "none";
  void ui.flash.offsetWidth;                 // restart the animation
  ui.flash.style.animation = "";
  setTimeout(() => { ui.flash.hidden = true; }, 360);
}

function timestampName(extension) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `scan-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${extension}`;
}

/** Offer a file to the user: the share sheet on a phone, a download elsewhere. */
async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return "shared";
    } catch (error) {
      if (error && error.name === "AbortError") return "cancelled";
      // fall through to the download
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
  return "downloaded";
}

/* -- pages --------------------------------------------------------------- */

function canvasFromMat(mat) {
  const canvas = document.createElement("canvas");
  matToCanvas(mat, canvas);
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function addPage(canvas, mode) {
  // bi-level pages stay lossless so that the PDF can embed them as 1 bit
  const lossless = mode === "bw";
  const blob = await canvasToBlob(canvas, lossless ? "image/png" : "image/jpeg", 0.92);
  const thumbnail = document.createElement("canvas");
  const scale = Math.min(1, 220 / Math.max(canvas.width, canvas.height));
  thumbnail.width = Math.max(1, Math.round(canvas.width * scale));
  thumbnail.height = Math.max(1, Math.round(canvas.height * scale));
  thumbnail.getContext("2d").drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
  const thumbBlob = await canvasToBlob(thumbnail, "image/jpeg", 0.7);

  const page = {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    blob,
    thumbBlob,
    width: canvas.width,
    height: canvas.height,
    mode,
    created: Date.now(),
    order: state.pages.length,
  };
  state.pages.push(page);
  await savePage(page).catch(() => { /* private mode: keep the page in memory */ });
  refreshPages();
  return page;
}

/** Re-encode a stored page, turned by 90 degrees clockwise. */
async function rotatePage(page) {
  const bitmap = await createImageBitmap(page.blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.height;
  canvas.height = bitmap.width;
  const context = canvas.getContext("2d");
  context.translate(canvas.width, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const lossless = page.mode === "bw";
  page.blob = await canvasToBlob(canvas, lossless ? "image/png" : "image/jpeg", 0.92);
  page.width = canvas.width;
  page.height = canvas.height;

  const thumbnail = document.createElement("canvas");
  const scale = Math.min(1, 220 / Math.max(canvas.width, canvas.height));
  thumbnail.width = Math.max(1, Math.round(canvas.width * scale));
  thumbnail.height = Math.max(1, Math.round(canvas.height * scale));
  thumbnail.getContext("2d").drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
  page.thumbBlob = await canvasToBlob(thumbnail, "image/jpeg", 0.7);
  await savePage(page).catch(() => {});
}


function refreshPages() {
  const count = state.pages.length;
  ui.pageCount.textContent = String(count);
  ui.sheetCount.textContent = String(count);
  ui.save.disabled = count === 0;
  ui.sheetPdf.disabled = count === 0;
  ui.sheetImages.disabled = count === 0;
  ui.sheetClear.disabled = count === 0;
  ui.sheetEmpty.hidden = count > 0;
}

/** Save one page on its own, as the file it already is. */
async function savePageFile(page) {
  const extension = page.blob.type === "image/png" ? "png" : "jpg";
  await deliver(page.blob, timestampName(extension));
}

/**
 * Write the order back onto the pages and store it.
 *
 * The number has to reach the page objects the app holds, not only the
 * database: anything that saves a single page later (a rotation, say) carries
 * its own copy of it, and a stale one would put the page back where it was.
 */
async function renumberPages() {
  state.pages.forEach((page, index) => { page.order = index; });
  await savePages(state.pages).catch(() => { /* private mode: order stays for now */ });
}

/** Forget a page, everywhere. */
async function dropPage(page) {
  state.pages = state.pages.filter((entry) => entry.id !== page.id);
  await removePage(page.id).catch(() => {});
  await renumberPages();
  refreshPages();
  renderThumbs();
}

/**
 * Move a page to another place in the stack.
 *
 * Pages come out in the order they were shot, which is rarely the order they
 * belong in - a page shot again because the first try was blurred lands at
 * the end.  The order is stored with the pages, so it survives a reload and
 * is what the PDF is built from.
 */
async function movePage(from, to) {
  if (to < 0 || to >= state.pages.length || from === to) return;
  const [page] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, page);
  await renumberPages();
  renderThumbs(page.id);
  refreshViewer(state.pages);
}

function renderThumbs(highlight = null) {
  ui.thumbs.innerHTML = "";
  state.pages.forEach((page, index) => {
    const item = document.createElement("div");
    item.className = "thumb" + (page.id === highlight ? " thumb--moving" : "");
    const image = document.createElement("img");
    image.alt = `${index + 1}번째 페이지`;
    image.src = URL.createObjectURL(page.thumbBlob || page.blob);
    image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
    image.addEventListener("click", () => openViewer(state.pages, index));
    const badge = document.createElement("span");
    badge.className = "thumb__index";
    badge.textContent = `${index + 1} · ${MODE_LABELS[page.mode] || page.mode}`;

    const order = document.createElement("div");
    order.className = "thumb__order";
    const earlier = document.createElement("button");
    earlier.textContent = "◀";
    earlier.title = "앞으로";
    earlier.setAttribute("aria-label", `${index + 1}번째 페이지를 앞으로`);
    earlier.disabled = index === 0;
    earlier.addEventListener("click", () => movePage(index, index - 1));
    const later = document.createElement("button");
    later.textContent = "▶";
    later.title = "뒤로";
    later.setAttribute("aria-label", `${index + 1}번째 페이지를 뒤로`);
    later.disabled = index === state.pages.length - 1;
    later.addEventListener("click", () => movePage(index, index + 1));
    order.append(earlier, later);

    const tools = document.createElement("div");
    tools.className = "thumb__tools";
    const turn = document.createElement("button");
    turn.textContent = "회전";
    turn.addEventListener("click", async () => {
      turn.disabled = true;
      await rotatePage(page);
      renderThumbs();
      refreshViewer(state.pages);
    });
    const single = document.createElement("button");
    single.textContent = "저장";
    single.addEventListener("click", () => savePageFile(page));
    const drop = document.createElement("button");
    drop.textContent = "삭제";
    drop.addEventListener("click", () => dropPage(page));
    tools.append(turn, single, drop);
    item.append(image, badge, order, tools);
    ui.thumbs.appendChild(item);
  });
}

async function canvasesForExport() {
  const canvases = [];
  for (const page of state.pages) {
    const bitmap = await createImageBitmap(page.blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    canvases.push(canvas);
  }
  return canvases;
}

async function exportPdf() {
  if (!state.pages.length) return;
  const label = ui.save.textContent;
  ui.save.disabled = true;
  ui.save.textContent = "만드는 중…";
  try {
    const canvases = await canvasesForExport();
    const name = timestampName("pdf");
    const blob = await buildPdf(canvases, { dpi: 300, quality: 92, title: name });
    const how = await deliver(blob, name);
    if (how !== "cancelled") {
      toast(`PDF ${state.pages.length}장 저장 완료 (${Math.round(blob.size / 1024)} kB)`);
    }
  } catch (error) {
    toast("PDF를 만들지 못했습니다: " + error.message, 3500);
  } finally {
    ui.save.textContent = label;
    refreshPages();
  }
}

async function exportImages() {
  for (const page of state.pages) {
    const extension = page.blob.type === "image/png" ? "png" : "jpg";
    // eslint-disable-next-line no-await-in-loop
    await deliver(page.blob, timestampName(extension));
  }
}

/* -- scanning ------------------------------------------------------------ */

/**
 * Run the full pipeline on a source (video frame, image) and store the page.
 *
 * `outline` is what the user approved in the editor; without one the page is
 * detected, and with `flattenPage` its border is followed so a curled sheet
 * can be flattened instead of merely straightened.
 */
async function scanSource(source, { outline = null, flattenPage = state.flatten } = {}) {
  const image = matFromSource(source);
  const owned = [];
  try {
    let used = outline;
    if (!used) {
      const found = findDocument(image, {});
      if (found) {
        used = flattenPage ? refineEdges(image, found.quad)
          : CurvedQuad.fromQuad(found.quad);
      }
    } else if (flattenPage && used.isStraight) {
      // a region picked by hand is placed by eye; with flattening asked for,
      // the border around it is measured and the corners land on the paper.
      // An edge the user bent on purpose is left exactly as drawn.
      used = refineEdges(image, used.corners);
    }

    let page;
    if (!used) {
      page = image.clone();
    } else if (used.isStraight) {
      page = fourPointTransform(image, used.corners, { aspect: "auto", margin: MARGIN });
    } else {
      page = flatten(image, used, { aspect: "auto" });
    }
    owned.push(page);

    if (used && flattenPage) {
      // the border only tells so much: in the middle of a curled page the text
      // lines are the only evidence of what is left of the bend
      const straightened = straightenTextLines(page);
      owned.push(straightened);
      page = straightened;
    }

    const finished = enhance(page, state.mode);
    owned.push(finished);
    const canvas = canvasFromMat(finished);
    await addPage(canvas, state.mode);
    return {
      cropped: Boolean(used),
      flattened: Boolean(used && !used.isStraight),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    image.delete();
    owned.forEach((mat) => { if (mat && !mat.isDeleted()) mat.delete(); });
  }
}

/** Let the user confirm the region; resolves to the scan options or null. */
async function confirmRegion(canvas) {
  if (!state.manual) return { outline: null, flattenPage: state.flatten };
  const chosen = await openEditor(canvas, { flatten: state.flatten });
  if (!chosen) return null;
  state.flatten = chosen.flatten;
  localStorage.setItem("docscan.flatten", chosen.flatten ? "1" : "0");
  return { outline: chosen.outline, flattenPage: chosen.flatten };
}

function videoFrameCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = ui.video.videoWidth;
  canvas.height = ui.video.videoHeight;
  canvas.getContext("2d").drawImage(ui.video, 0, 0);
  return canvas;
}

async function capture() {
  if (state.busy || !ui.video.videoWidth) return;
  state.busy = true;
  ui.shutter.disabled = true;
  flash();
  try {
    const frame = videoFrameCanvas();
    state.lastCapture = performance.now();
    state.stableCount = 0;
    // the region is confirmed on the full frame: the preview only ever
    // detects on a downscaled copy
    const chosen = await confirmRegion(frame);
    if (!chosen) {
      toast("취소했습니다");
      return;
    }
    const result = await scanSource(frame, chosen);
    state.lastCapture = performance.now();
    toast(result.cropped
      ? `${state.pages.length}번째 페이지 (${result.width}×${result.height})`
        + (result.flattened ? " · 평탄화" : "")
      : "문서를 찾지 못해 전체 화면을 저장했습니다");
  } catch (error) {
    toast("촬영 실패: " + error.message, 3000);
  } finally {
    state.busy = false;
    ui.shutter.disabled = false;
  }
}

async function scanFiles(files) {
  for (const file of files) {
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      // eslint-disable-next-line no-await-in-loop
      const chosen = await confirmRegion(canvas);
      if (!chosen) continue;
      // eslint-disable-next-line no-await-in-loop
      const result = await scanSource(canvas, chosen);
      toast(result.cropped
        ? `${file.name}: ${result.width}×${result.height}`
          + (result.flattened ? " · 평탄화" : "")
        : `${file.name}: 문서를 찾지 못했습니다`);
    } catch (error) {
      toast(`${file.name}: 열 수 없습니다`, 3000);
    }
  }
}

/* -- live preview -------------------------------------------------------- */

function smoothQuad(previous, current, factor = 0.5) {
  if (!previous || !current) return current;
  return current.map((point, index) => [
    previous[index][0] * (1 - factor) + point[0] * factor,
    previous[index][1] * (1 - factor) + point[1] * factor,
  ]);
}

function drawOverlay() {
  const canvas = ui.overlay;
  const context = canvas.getContext("2d");
  const rect = ui.video.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(rect.width * ratio)
      || canvas.height !== Math.round(rect.height * ratio)) {
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  if (!state.smoothed || !ui.video.videoWidth) return;

  // the video is letterboxed inside its box by object-fit: contain
  const scale = Math.min(rect.width / ui.video.videoWidth,
                         rect.height / ui.video.videoHeight);
  const offsetX = (rect.width - ui.video.videoWidth * scale) / 2;
  const offsetY = (rect.height - ui.video.videoHeight * scale) / 2;
  const points = state.smoothed.map(([x, y]) => [offsetX + x * scale, offsetY + y * scale]);

  const outside = touchesBorder(state.smoothed, ui.video.videoWidth, ui.video.videoHeight);
  const ready = state.auto && state.stableCount >= Math.ceil(STABLE_FRAMES / 2) && !outside;
  const colour = outside ? "#f0a33a" : ready ? "#ffe066" : "#35c26a";

  context.beginPath();
  points.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
  context.closePath();
  context.fillStyle = colour + "22";
  context.fill();
  context.strokeStyle = colour;
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.stroke();
  points.forEach(([x, y]) => {
    context.beginPath();
    context.arc(x, y, 7, 0, Math.PI * 2);
    context.fillStyle = colour;
    context.fill();
    context.strokeStyle = "#fff";
    context.lineWidth = 1.5;
    context.stroke();
  });
}

function detectFrame() {
  if (state.busy || !ui.video.videoWidth) return;
  const width = ui.video.videoWidth;
  const height = ui.video.videoHeight;
  const scale = Math.min(1, DETECT_SIZE / Math.max(width, height));
  const canvas = detectFrame.canvas || (detectFrame.canvas = document.createElement("canvas"));
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d").drawImage(ui.video, 0, 0, canvas.width, canvas.height);

  const mat = matFromSource(canvas);
  try {
    const found = findDocument(mat, { fast: true, workingSize: DETECT_SIZE });
    const quad = found ? found.quad.map(([x, y]) => [x / scale, y / scale]) : null;
    state.detection = found ? { ...found, quad } : null;
    if (quad && state.previousQuad) {
      const diagonal = Math.hypot(width, height);
      const movement = Math.max(...quad.map(
        (point, index) => Math.hypot(point[0] - state.previousQuad[index][0],
                                     point[1] - state.previousQuad[index][1])));
      state.stableCount = movement < STABLE_TOLERANCE * diagonal ? state.stableCount + 1 : 0;
    } else {
      state.stableCount = 0;
    }
    state.previousQuad = quad;
    state.smoothed = quad ? smoothQuad(state.smoothed, quad) : null;

    if (!quad) {
      setStatus("문서를 찾는 중 — 배경과 대비되는 곳에 두세요");
    } else if (touchesBorder(quad, width, height)) {
      setStatus("문서가 화면을 벗어났어요 — 조금 뒤로", "warn");
    } else {
      setStatus(`문서 감지됨 (${Math.round(state.detection.areaRatio * 100)}%)`, "good");
    }
  } finally {
    mat.delete();
  }
}

function loop() {
  const now = performance.now();
  if (now - state.lastDetect > DETECT_INTERVAL) {
    state.lastDetect = now;
    try {
      detectFrame();
    } catch (error) {
      setStatus("검출 오류: " + error.message, "warn");
    }
    if (state.auto && state.detection && !state.busy
        && state.stableCount >= STABLE_FRAMES
        && now - state.lastCapture > AUTO_COOLDOWN
        && !touchesBorder(state.detection.quad, ui.video.videoWidth, ui.video.videoHeight)) {
      capture();
    }
  }
  drawOverlay();
  requestAnimationFrame(loop);
}

/* -- camera -------------------------------------------------------------- */

async function startCamera() {
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  ui.permission.hidden = true;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: state.facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  } catch (error) {
    showCameraProblem(error);
    return false;
  }
  ui.video.srcObject = state.stream;
  await ui.video.play().catch(() => {});
  state.track = state.stream.getVideoTracks()[0];

  const capabilities = state.track.getCapabilities ? state.track.getCapabilities() : {};
  ui.torch.hidden = !capabilities.torch;
  ui.flip.hidden = !(navigator.mediaDevices.enumerateDevices);
  ui.splash.hidden = true;
  setStatus("문서를 찾는 중…");
  return true;
}

function showCameraProblem(error) {
  const reasons = {
    NotAllowedError: "카메라 권한이 거부되었습니다. 브라우저 주소창의 자물쇠 아이콘에서 "
      + "카메라를 허용한 뒤 다시 시도하세요.",
    NotFoundError: "사용할 수 있는 카메라가 없습니다.",
    NotReadableError: "다른 앱이 카메라를 사용 중입니다. 그 앱을 닫고 다시 시도하세요.",
    SecurityError: "카메라는 HTTPS에서만 열 수 있습니다. https 주소로 접속하세요.",
  };
  const isInsecure = !window.isSecureContext;
  ui.splash.hidden = true;
  ui.permission.hidden = false;
  ui.permissionText.textContent = isInsecure
    ? "이 페이지가 HTTPS가 아니라 카메라를 쓸 수 없습니다. https 주소로 접속하거나, "
      + "아래에서 사진을 불러와 스캔하세요."
    : (reasons[error && error.name] || `카메라를 열 수 없습니다 (${error && error.name}).`);
  setStatus("카메라 없음 — 사진 불러오기를 쓸 수 있습니다", "warn");
}

/* -- start up ------------------------------------------------------------ */

function buildModeChips() {
  MODES.forEach((mode) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = MODE_LABELS[mode] || mode;
    chip.title = MODE_DESCRIPTIONS[mode] || "";
    chip.setAttribute("aria-pressed", String(mode === state.mode));
    chip.addEventListener("click", () => {
      state.mode = mode;
      localStorage.setItem("docscan.mode", mode);
      [...ui.modes.children].forEach((other) => other.setAttribute(
        "aria-pressed", String(other === chip)));
      toast(MODE_DESCRIPTIONS[mode] || mode);
    });
    ui.modes.appendChild(chip);
  });
}

function wireEvents() {
  ui.shutter.addEventListener("click", capture);
  ui.auto.addEventListener("click", () => {
    state.auto = !state.auto;
    state.stableCount = 0;
    localStorage.setItem("docscan.auto", state.auto ? "1" : "0");
    ui.auto.setAttribute("aria-pressed", String(state.auto));
    toast(state.auto ? "자동 촬영: 문서를 가만히 들고 계세요" : "자동 촬영 끔");
  });
  ui.auto.setAttribute("aria-pressed", String(state.auto));

  ui.manual.addEventListener("click", () => {
    state.manual = !state.manual;
    localStorage.setItem("docscan.manual", state.manual ? "1" : "0");
    ui.manual.setAttribute("aria-pressed", String(state.manual));
    toast(state.manual ? "촬영 후 영역을 확인합니다" : "자동 영역으로 바로 저장합니다");
  });
  ui.manual.setAttribute("aria-pressed", String(state.manual));

  ui.pick.addEventListener("click", () => ui.file.click());
  ui.permissionPick.addEventListener("click", () => ui.file.click());
  ui.file.addEventListener("change", async () => {
    const files = [...ui.file.files];
    ui.file.value = "";
    if (files.length) await scanFiles(files);
  });

  ui.retryCamera.addEventListener("click", startCamera);
  ui.flip.addEventListener("click", async () => {
    state.facing = state.facing === "environment" ? "user" : "environment";
    await startCamera();
  });
  ui.torch.addEventListener("click", async () => {
    if (!state.track) return;
    const on = ui.torch.getAttribute("aria-pressed") === "true";
    try {
      await state.track.applyConstraints({ advanced: [{ torch: !on }] });
      ui.torch.setAttribute("aria-pressed", String(!on));
    } catch (error) {
      toast("이 기기에서는 플래시를 켤 수 없습니다");
    }
  });

  ui.save.addEventListener("click", exportPdf);
  ui.sheetPdf.addEventListener("click", exportPdf);
  ui.sheetImages.addEventListener("click", exportImages);
  ui.sheetClear.addEventListener("click", async () => {
    state.pages = [];
    await clearPages().catch(() => {});
    refreshPages();
    renderThumbs();
  });
  ui.gallery.addEventListener("click", () => {
    renderThumbs();
    ui.sheet.showModal();
  });
  ui.sheetClose.addEventListener("click", () => ui.sheet.close());

  setupViewer(ui.viewer, {
    rotate: (page) => rotatePage(page).then(() => renderThumbs()),
    save: savePageFile,
    remove: (page) => dropPage(page),
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    ui.install.hidden = false;
  });
  ui.install.addEventListener("click", async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    ui.install.hidden = true;
  });
}

async function main() {
  buildModeChips();
  wireEvents();
  refreshPages();

  try {
    state.pages = await loadPages();
    refreshPages();
    if (state.pages.length) toast(`이전에 촬영한 ${state.pages.length}장을 복원했습니다`);
  } catch (error) { /* storage unavailable: start empty */ }

  try {
    state.cv = await loadOpenCV((message) => { ui.splashText.textContent = message; });
  } catch (error) {
    ui.splashText.textContent = "이미지 엔진을 불러오지 못했습니다. 인터넷 연결을 확인하고 "
      + "새로고침하세요.";
    setStatus("엔진 로드 실패", "warn");
    return;
  }

  ui.splashText.textContent = "카메라 여는 중…";
  await startCamera();
  requestAnimationFrame(loop);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(new URL("../sw.js", import.meta.url), {
      scope: new URL("../", import.meta.url).pathname,
    }).catch(() => { /* offline support is optional */ });
  }
}

main();
