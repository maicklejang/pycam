/* Geometry: corner ordering, aspect estimation and perspective warping.
 *
 * This is a direct port of docscan/transform.py - see there for the reasoning
 * behind the aspect ratio recovery.
 */

import { withMats } from "./cv.js";

export const PAPER_RATIOS = {
  a4: 210 / 297,
  a3: 297 / 420,
  a5: 148 / 210,
  letter: 8.5 / 11,
  legal: 8.5 / 14,
  square: 1,
};

const MIN_RATIO = 0.15;
const MAX_RATIO = 1 / MIN_RATIO;

/** Order four [x, y] corners as top-left, top-right, bottom-right, bottom-left. */
export function orderCorners(points) {
  if (points.length !== 4) throw new Error("exactly four corners are required");
  const centreX = points.reduce((sum, p) => sum + p[0], 0) / 4;
  const centreY = points.reduce((sum, p) => sum + p[1], 0) / 4;
  const sorted = points
    .map((p) => ({ p, angle: Math.atan2(p[1] - centreY, p[0] - centreX) }))
    .sort((a, b) => a.angle - b.angle)
    .map((entry) => entry.p);
  // rotate so that the corner closest to the origin comes first
  let start = 0;
  let best = Infinity;
  sorted.forEach((p, index) => {
    const sum = p[0] + p[1];
    if (sum < best) { best = sum; start = index; }
  });
  return sorted.slice(start).concat(sorted.slice(0, start));
}

/** Convex, without very sharp corners? */
export function quadIsSane(quad, minAngleCos = 0.6) {
  if (!quad || quad.length !== 4) return false;
  if (!quad.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return false;
  let positive = 0;
  let negative = 0;
  for (let index = 0; index < 4; index += 1) {
    const current = quad[index];
    const previous = quad[(index + 3) % 4];
    const following = quad[(index + 1) % 4];
    const ax = previous[0] - current[0];
    const ay = previous[1] - current[1];
    const bx = following[0] - current[0];
    const by = following[1] - current[1];
    const lengthA = Math.hypot(ax, ay);
    const lengthB = Math.hypot(bx, by);
    if (lengthA < 1e-6 || lengthB < 1e-6) return false;
    if (Math.abs((ax * bx + ay * by) / (lengthA * lengthB)) > minAngleCos) return false;
    const cross = ax * by - ay * bx;
    if (cross > 0) positive += 1; else negative += 1;
  }
  return positive === 4 || negative === 4;
}

export function quadArea(quad) {
  let total = 0;
  for (let index = 0; index < 4; index += 1) {
    const [x1, y1] = quad[index];
    const [x2, y2] = quad[(index + 1) % 4];
    total += x1 * y2 - x2 * y1;
  }
  return Math.abs(total) / 2;
}

/** Scale a quad around its centroid; negative margins shrink it. */
export function expandQuad(quad, margin) {
  if (!margin) return quad;
  const centreX = quad.reduce((sum, p) => sum + p[0], 0) / 4;
  const centreY = quad.reduce((sum, p) => sum + p[1], 0) / 4;
  const factor = 1 + margin;
  return quad.map(([x, y]) => [centreX + (x - centreX) * factor, centreY + (y - centreY) * factor]);
}

export function scaleQuad(quad, factor) {
  return quad.map(([x, y]) => [x * factor, y * factor]);
}

/** (width, height) from the longest pair of opposing edges. */
export function edgeLengths(ordered) {
  const [tl, tr, br, bl] = ordered;
  const width = Math.max(Math.hypot(tr[0] - tl[0], tr[1] - tl[1]),
                         Math.hypot(br[0] - bl[0], br[1] - bl[1]));
  const height = Math.max(Math.hypot(bl[0] - tl[0], bl[1] - tl[1]),
                          Math.hypot(br[0] - tr[0], br[1] - tr[1]));
  return [width, height];
}

function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * The two vanishing directions and the principal point of a quad.
 *
 * The shared first half of the Zhang & He rectification: n2 and n3 are the
 * images of the rectangle's two edge directions, and everything the focal
 * length and the aspect ratio need is in them.
 */
function rectificationVectors(ordered, width, height) {
  const [tl, tr, br, bl] = ordered;
  const m1 = [tl[0], tl[1], 1];
  const m2 = [tr[0], tr[1], 1];
  const m3 = [bl[0], bl[1], 1];
  const m4 = [br[0], br[1], 1];
  const u0 = width / 2;
  const v0 = height / 2;

  const denominatorK2 = dot3(cross3(m2, m4), m3);
  const denominatorK3 = dot3(cross3(m3, m4), m2);
  if (Math.abs(denominatorK2) < 1e-9 || Math.abs(denominatorK3) < 1e-9) return null;
  const k2 = dot3(cross3(m1, m4), m3) / denominatorK2;
  const k3 = dot3(cross3(m1, m4), m2) / denominatorK3;
  if (Math.abs(k2 - 1) < 1e-6 && Math.abs(k3 - 1) < 1e-6) return null;

  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  if (Math.abs(n2[2]) < 1e-9 || Math.abs(n3[2]) < 1e-9) return null;
  return { n2, n3, u0, v0 };
}

/**
 * Camera focal length in pixels, from the perspective of a rectangle.
 *
 * Returns null for a shot that carries no perspective: the corners of a
 * fronto-parallel page say nothing about the lens.
 */
export function projectiveFocal(ordered, width, height) {
  const vectors = rectificationVectors(ordered, width, height);
  if (!vectors) return null;
  const { n2, n3, u0, v0 } = vectors;
  const focalSquared = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0
                          + n2[2] * n3[2] * u0 * u0)
                         + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0
                            + n2[2] * n3[2] * v0 * v0)) / (n2[2] * n3[2]);
  if (!Number.isFinite(focalSquared) || focalSquared <= 0) return null;
  return Math.sqrt(focalSquared);
}

/**
 * Recover the true width/height ratio of the rectangle behind a quad.
 *
 * The perspective distortion determines the camera focal length, which in turn
 * gives the original aspect ratio (Zhang & He).  Returns null when the shape
 * carries no perspective information (a fronto-parallel shot).
 */
export function projectiveAspectRatio(ordered, width, height) {
  const vectors = rectificationVectors(ordered, width, height);
  if (!vectors) return null;
  const { n2, n3, u0, v0 } = vectors;
  const focal = projectiveFocal(ordered, width, height);
  if (focal === null) return null;

  // n . (A^-T A^-1) n  with A = [[f,0,u0],[0,f,v0],[0,0,1]]
  const metric = (n) => {
    const x = (n[0] - u0 * n[2]) / focal;
    const y = (n[1] - v0 * n[2]) / focal;
    return x * x + y * y + n[2] * n[2];
  };
  const numerator = metric(n2);
  const denominator = metric(n3);
  if (numerator <= 0 || denominator <= 0) return null;
  const ratio = Math.sqrt(numerator / denominator);
  if (!Number.isFinite(ratio) || ratio < MIN_RATIO || ratio > MAX_RATIO) return null;
  return ratio;
}

/** The width/height ratio used for the rectified output. */
export function targetAspectRatio(ordered, width, height, mode = "auto") {
  const [edgeWidth, edgeHeight] = edgeLengths(ordered);
  const edgeRatio = edgeHeight > 1e-6 ? edgeWidth / edgeHeight : 1;
  if (!mode || mode === "none" || mode === "edges") return edgeRatio;
  if (PAPER_RATIOS[mode] !== undefined) {
    const ratio = PAPER_RATIOS[mode];
    return edgeRatio <= 1 ? ratio : 1 / ratio;
  }
  if (mode === "auto" || mode === "projective") {
    const ratio = projectiveAspectRatio(ordered, width, height);
    if (ratio === null) return edgeRatio;
    if (mode === "auto") {
      const relative = edgeRatio > 1e-6 ? ratio / edgeRatio : 0;
      if (relative < 0.5 || relative > 2) return edgeRatio;
    }
    return ratio;
  }
  throw new Error("unknown aspect mode: " + mode);
}

/** Output size in pixels for the rectified page. */
export function outputSize(ordered, width, height, aspect = "auto", maxSide = 0) {
  const [edgeWidth, edgeHeight] = edgeLengths(ordered);
  const ratio = targetAspectRatio(ordered, width, height, aspect);
  let outWidth;
  let outHeight;
  if (edgeWidth >= edgeHeight) {
    outWidth = edgeWidth;
    outHeight = edgeWidth / ratio;
  } else {
    outHeight = edgeHeight;
    outWidth = edgeHeight * ratio;
  }
  if (maxSide) {
    const longest = Math.max(outWidth, outHeight);
    if (longest > maxSide) {
      const scale = maxSide / longest;
      outWidth *= scale;
      outHeight *= scale;
    }
  }
  return [Math.max(1, Math.round(outWidth)), Math.max(1, Math.round(outHeight))];
}

/**
 * Rectify `quad` of `source` into a straight rectangle.
 * Returns a new Mat which the caller owns.
 */
export function fourPointTransform(source, quad,
                                   { aspect = "auto", margin = 0, size = null,
                                     maxSide = 0 } = {}) {
  const cv = window.cv;
  const ordered = orderCorners(expandQuad(quad, margin));
  const [width, height] = size
    || outputSize(ordered, source.cols, source.rows, aspect, maxSide);
  const destination = new cv.Mat();
  return withMats((keep) => {
    const sourceTri = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [
      ordered[0][0], ordered[0][1], ordered[1][0], ordered[1][1],
      ordered[2][0], ordered[2][1], ordered[3][0], ordered[3][1],
    ]));
    const destinationTri = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1,
    ]));
    const matrix = keep(cv.getPerspectiveTransform(sourceTri, destinationTri));
    const interpolation = quadArea(ordered) > width * height ? cv.INTER_AREA : cv.INTER_CUBIC;
    cv.warpPerspective(source, destination, matrix, new cv.Size(width, height),
                       interpolation, cv.BORDER_REPLICATE, new cv.Scalar());
    return destination;
  });
}

/** Rotate by a multiple of 90 degrees, clockwise. Returns a new Mat. */
export function rotateImage(source, degrees) {
  const cv = window.cv;
  const turns = ((Math.round((degrees % 360) / 90) % 4) + 4) % 4;
  if (turns === 0) return source.clone();
  const destination = new cv.Mat();
  const code = turns === 1 ? cv.ROTATE_90_CLOCKWISE
    : turns === 2 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
  cv.rotate(source, destination, code);
  return destination;
}
