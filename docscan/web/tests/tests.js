/* Browser side tests of the docscan web app.
 *
 * They run against the same synthetic photos as the python test suite and
 * compare the results with what python produced (see make-fixtures.py), so a
 * drift between the two implementations shows up here.
 */

import { loadOpenCV } from "../js/cv.js";
import { findDocument, touchesBorder, fullFrameQuad } from "../js/detect.js";
import { enhance, MODES, MODE_LABELS } from "../js/enhance.js";
import { matFromSource, matToCanvas, toGray } from "../js/mat.js";
import { buildPdf } from "../js/pdf.js";
import { clearPages, loadPages, removePage, savePage } from "../js/store.js";
import {
  edgeLengths, fourPointTransform, orderCorners, outputSize, projectiveAspectRatio,
  quadArea, quadIsSane, targetAspectRatio,
} from "../js/transform.js";

const A4 = 210 / 297;
const CORNER_TOLERANCE = 8;      // px; the detector works on a downscaled copy

const results = [];

function check(name, body) {
  return Promise.resolve().then(body).then(
    (note) => results.push({ name, ok: true, note: note || "" }),
    (error) => results.push({ name, ok: false, note: error && error.message }));
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function close(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance,
         `${message || "value"}: ${actual} is not within ${tolerance} of ${expected}`);
}

/** Project a rectangle of the given ratio with a virtual pinhole camera. */
function projectQuad(ratio, rotation, distance, focal, width, height) {
  const [rx, ry, rz] = rotation;
  const theta = Math.hypot(rx, ry, rz) || 1e-9;
  const k = [rx / theta, ry / theta, rz / theta];
  const cosine = Math.cos(theta);
  const sine = Math.sin(theta);
  const skew = [[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]];
  const R = [0, 1, 2].map((row) => [0, 1, 2].map((column) => (
    (row === column ? cosine : 0) + (1 - cosine) * k[row] * k[column] + sine * skew[row][column]
  )));
  const corners = [[-ratio / 2, -0.5, 0], [ratio / 2, -0.5, 0],
                   [ratio / 2, 0.5, 0], [-ratio / 2, 0.5, 0]];
  return corners.map((point) => {
    const camera = [0, 1, 2].map((row) => R[row][0] * point[0] + R[row][1] * point[1]
                                 + R[row][2] * point[2] + (row === 2 ? distance : 0));
    return [(focal * camera[0]) / camera[2] + width / 2,
            (focal * camera[1]) / camera[2] + height / 2];
  });
}

async function loadMat(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return matFromSource(canvas);
}

function pdfString(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
}

export async function runAll(fixturesUrl = "./fixtures/") {
  const cv = await loadOpenCV();
  let fixtures = null;
  try {
    fixtures = await (await fetch(fixturesUrl + "fixtures.json")).json();
  } catch (error) { /* tests that need fixtures are skipped below */ }

  /* -- geometry --------------------------------------------------------- */

  await check("orderCorners is independent of the input order", () => {
    const corners = [[10, 20], [110, 20], [110, 220], [10, 220]];
    const reference = JSON.stringify(orderCorners(corners));
    for (let shift = 0; shift < 4; shift += 1) {
      const rolled = corners.slice(shift).concat(corners.slice(0, shift));
      assert(JSON.stringify(orderCorners(rolled)) === reference, "rotated input differs");
      assert(JSON.stringify(orderCorners(rolled.slice().reverse())) === reference,
             "reversed input differs");
    }
  });

  await check("quadIsSane accepts a rectangle and rejects degenerate quads", () => {
    assert(quadIsSane([[0, 0], [100, 0], [100, 50], [0, 50]]), "rectangle rejected");
    assert(!quadIsSane([[0, 0], [100, 0], [101, 1], [0, 50]]), "sharp corner accepted");
    assert(!quadIsSane([[0, 0], [100, 0], [0, 50], [100, 50]]), "bow tie accepted");
    assert(!quadIsSane([[0, 0], [0, 0], [100, 50], [0, 50]]), "duplicate corner accepted");
  });

  await check("quadArea uses the shoelace formula", () => {
    close(quadArea([[0, 0], [100, 0], [100, 50], [0, 50]]), 5000, 1e-6, "area");
  });

  await check("projectiveAspectRatio recovers a tilted page", () => {
    for (const ratio of [A4, 1, 11 / 8.5, 0.5]) {
      for (const rotation of [[0.35, 0.45, 0.15], [0.6, 0.1, 0], [0.5, -0.4, 0.3]]) {
        const quad = orderCorners(projectQuad(ratio, rotation, 1.4, 900, 1280, 720));
        const estimate = projectiveAspectRatio(quad, 1280, 720);
        assert(estimate !== null, "no estimate for ratio " + ratio);
        close(estimate, ratio, 0.02 * ratio, "ratio " + ratio);
      }
    }
    return "4 ratios x 3 angles";
  });

  await check("projectiveAspectRatio gives up on a parallelogram", () => {
    const quad = orderCorners([[100, 100], [400, 100], [430, 300], [130, 300]]);
    assert(projectiveAspectRatio(quad, 1280, 720) === null, "expected null");
  });

  await check("targetAspectRatio honours a fixed paper size", () => {
    const portrait = orderCorners(projectQuad(A4, [0.35, 0.45, 0.15], 1.4, 900, 1280, 720));
    const landscape = orderCorners(projectQuad(1 / A4, [0.35, 0.45, 0.15], 1.4, 900, 1280, 720));
    close(targetAspectRatio(portrait, 1280, 720, "a4"), A4, 1e-9, "portrait");
    close(targetAspectRatio(landscape, 1280, 720, "a4"), 1 / A4, 1e-9, "landscape");
    close(targetAspectRatio(portrait, 1280, 720, "edges"),
          edgeLengths(portrait)[0] / edgeLengths(portrait)[1], 1e-9, "edges");
  });

  await check("outputSize honours the maximum side", () => {
    const quad = orderCorners([[0, 0], [2000, 0], [2000, 1000], [0, 1000]]);
    const [width, height] = outputSize(quad, 4000, 3000, "edges", 500);
    assert(width === 500 && height === 250, `got ${width}x${height}`);
  });

  await check("fourPointTransform rectifies a projected page", () => {
    const quad = projectQuad(A4, [0.3, 0.4, 0.1], 1.6, 900, 1280, 720);
    const source = new cv.Mat(720, 1280, cv.CV_8UC3, new cv.Scalar(0, 0, 0));
    const warped = fourPointTransform(source, quad, { aspect: "auto" });
    const ratio = warped.cols / warped.rows;
    source.delete();
    warped.delete();
    close(ratio, A4, 0.03 * A4, "output ratio");
  });

  await check("touchesBorder detects an outline at the frame edge", () => {
    assert(touchesBorder(fullFrameQuad(1280, 720), 1280, 720), "full frame not detected");
    assert(!touchesBorder([[100, 100], [600, 100], [600, 500], [100, 500]], 1280, 720),
           "inner quad reported as clipped");
  });

  /* -- detection against the python results ------------------------------ */

  if (fixtures) {
    await check("findDocument matches the python detector on every fixture", async () => {
      const notes = [];
      for (const item of fixtures.cases) {
        const image = await loadMat(fixturesUrl + item.name);
        try {
          const detection = findDocument(image, {});
          assert(Boolean(detection) === (item.python.error !== null),
                 `${item.name}: detection disagrees with python`);
          if (!detection) continue;
          const truth = orderCorners(item.truth);
          const error = Math.max(...detection.quad.map(
            (point, index) => Math.hypot(point[0] - truth[index][0],
                                         point[1] - truth[index][1])));
          assert(error < CORNER_TOLERANCE,
                 `${item.name}: corners off by ${error.toFixed(1)} px`);
          // the port must not be noticeably worse than python
          assert(error <= item.python.error + 2,
                 `${item.name}: ${error.toFixed(2)} px vs python ${item.python.error} px`);
          notes.push(error.toFixed(2));
        } finally {
          image.delete();
        }
      }
      return `max corner error ${Math.max(...notes.map(Number)).toFixed(2)} px`;
    });

    await check("the fast profile still finds the page", async () => {
      const image = await loadMat(fixturesUrl + fixtures.source);
      try {
        assert(findDocument(image, { fast: true, workingSize: 400 }) !== null, "no detection");
      } finally {
        image.delete();
      }
    });

    /* -- enhancement against the python results -------------------------- */

    await check("every colour mode matches the python output", async () => {
      const source = await loadMat(fixturesUrl + fixtures.source);
      const detection = findDocument(source, {});
      const worst = [];
      for (const mode of MODES) {
        const expected = fixtures.modes[mode];
        const rectified = fourPointTransform(source, detection.quad,
                                             { aspect: "auto", margin: -0.004 });
        const actual = enhance(rectified, mode);
        const reference = await loadMat(fixturesUrl + expected.file);
        const left = toGray(actual);
        const right = toGray(reference);
        const difference = new cv.Mat();
        try {
          assert(actual.cols === expected.width && actual.rows === expected.height,
                 `${mode}: size ${actual.cols}x${actual.rows} != `
                 + `${expected.width}x${expected.height}`);
          cv.absdiff(left, right, difference);
          const mad = cv.mean(difference)[0];
          assert(mad < 3, `${mode}: mean difference ${mad.toFixed(2)} is too large`);
          worst.push(mad);
        } finally {
          [rectified, actual, reference, left, right, difference].forEach((mat) => mat.delete());
        }
      }
      source.delete();
      return `max mean difference ${Math.max(...worst).toFixed(2)}/255`;
    });
  }

  await check("bw mode returns a bi-level image", () => {
    const source = new cv.Mat(200, 160, cv.CV_8UC3, new cv.Scalar(240, 240, 240));
    cv.rectangle(source, new cv.Point(20, 20), new cv.Point(140, 60),
                 new cv.Scalar(20, 20, 20, 255), -1);
    const result = enhance(source, "bw");
    try {
      assert(result.channels() === 1, "not single channel");
      const values = new Set(result.data);
      assert([...values].every((value) => value === 0 || value === 255),
             "values other than 0/255: " + [...values].slice(0, 5));
    } finally {
      source.delete();
      result.delete();
    }
  });

  await check("every mode has a label", () => {
    MODES.forEach((mode) => assert(MODE_LABELS[mode], "missing label for " + mode));
  });

  /* -- PDF --------------------------------------------------------------- */

  await check("buildPdf writes a valid document with a korean title", async () => {
    const colour = document.createElement("canvas");
    colour.width = 120; colour.height = 180;
    const context = colour.getContext("2d");
    context.fillStyle = "#eee"; context.fillRect(0, 0, 120, 180);
    context.fillStyle = "#c33"; context.fillRect(20, 20, 60, 40);

    const bilevel = document.createElement("canvas");
    bilevel.width = 120; bilevel.height = 180;
    const binary = bilevel.getContext("2d");
    binary.fillStyle = "#fff"; binary.fillRect(0, 0, 120, 180);
    binary.fillStyle = "#000"; binary.fillRect(10, 10, 50, 30);

    const blob = await buildPdf([colour, bilevel], { dpi: 300, title: "테스트 스캔" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = pdfString(bytes);
    assert(text.startsWith("%PDF-1.4"), "missing header");
    assert(text.trimEnd().endsWith("%%EOF"), "missing trailer");
    assert(/\/Count 2\b/.test(text), "wrong page count");

    const start = Number(/startxref\s+(\d+)/.exec(text)[1]);
    const header = /^xref\s+0 (\d+)\s+/.exec(text.slice(start));
    const count = Number(header[1]);
    const table = start + header[0].length;
    for (let number = 1; number < count; number += 1) {
      // entry 0 is the free object, every entry is exactly 20 bytes wide
      const offset = Number(text.slice(table + number * 20, table + number * 20 + 10));
      assert(text.startsWith(`${number} 0 obj`, offset),
             `xref entry ${number} points at "${text.slice(offset, offset + 12)}"`);
    }
    assert(/\/Filter \/DCTDecode/.test(text), "colour page is not a JPEG");
    assert(/\/BitsPerComponent 1 \/Filter \/FlateDecode/.test(text),
           "bi-level page is not stored as 1 bit");
    const hex = /\/Title <FEFF([0-9A-F]+)>/.exec(text)[1];
    const title = hex.match(/.{4}/g)
      .map((unit) => String.fromCharCode(parseInt(unit, 16))).join("");
    assert(title === "테스트 스캔", "title round trip failed: " + title);
    return `${bytes.length} bytes, ${count - 1} objects`;
  });

  await check("a page rendered from a Mat survives the PDF round trip", async () => {
    const source = new cv.Mat(120, 90, cv.CV_8UC3, new cv.Scalar(250, 250, 250));
    const canvas = document.createElement("canvas");
    matToCanvas(source, canvas);
    const blob = await buildPdf([canvas], { pageSize: "a4" });
    const text = pdfString(new Uint8Array(await blob.arrayBuffer()));
    assert(/\/MediaBox \[0 0 595\.28\d* 841\.89\d*\]/.test(text), "A4 page box missing");
    source.delete();
  });

  /* -- storage ----------------------------------------------------------- */

  await check("pages survive a store round trip", async () => {
    await clearPages();
    const page = {
      id: "test-page", blob: new Blob(["x"], { type: "image/png" }),
      thumbBlob: new Blob(["y"], { type: "image/jpeg" }), width: 2, height: 3, mode: "bw",
    };
    await savePage(page);
    let stored = await loadPages();
    assert(stored.length === 1 && stored[0].id === "test-page", "page was not stored");
    assert(stored[0].width === 2 && stored[0].mode === "bw", "metadata lost");
    await removePage("test-page");
    stored = await loadPages();
    assert(stored.length === 0, "page was not removed");
  });

  return results;
}
