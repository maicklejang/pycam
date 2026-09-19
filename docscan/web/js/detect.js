/* Detection of the page outline - a port of docscan/detect.py.
 *
 * The strategies and the scoring are the same: several complementary masks
 * produce candidate quads, and each candidate is checked against the real
 * image gradient along all four of its sides.
 */

import { withMats } from "./cv.js";
import { median8u, odd, percentileFloat, resizeMax, toGray } from "./mat.js";
import { orderCorners, quadArea, quadIsSane, scaleQuad } from "./transform.js";

const APPROX_EPSILONS = [0.01, 0.02, 0.03, 0.04, 0.06, 0.08];
const FAST_EPSILONS = [0.02, 0.04, 0.08];

/** Strategy names; the live preview only runs the first few. */
export const STRATEGIES = ["canny", "canny-bilateral", "gradient", "otsu", "otsu-inverted",
                           "saturation"];
const FAST_STRATEGIES = ["canny", "gradient", "otsu"];

export function fullFrameQuad(width, height) {
  return [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]];
}

export function touchesBorder(quad, width, height, tolerance = 0.01) {
  const limit = tolerance * Math.max(width, height);
  return quad.some(([x, y]) => x <= limit || y <= limit
                   || x >= width - 1 - limit || y >= height - 1 - limit);
}

function closeMask(mask, size = 5) {
  const cv = window.cv;
  return withMats((keep) => {
    const kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(size, size)));
    const closed = new cv.Mat();
    cv.morphologyEx(mask, closed, cv.MORPH_CLOSE, kernel);
    return closed;
  });
}

function autoCanny(gray, sigma = 0.33) {
  const cv = window.cv;
  const median = median8u(gray);
  let lower = Math.max(0, Math.round((1 - sigma) * median));
  let upper = Math.min(255, Math.round((1 + sigma) * median));
  if (upper <= lower) { lower = 50; upper = 150; }
  const edges = new cv.Mat();
  cv.Canny(gray, edges, lower, upper);
  return edges;
}

/**
 * Build the requested edge masks.  Returns [{name, mat}]; the caller owns the
 * Mats.  Different scenes fail in different ways, so several are tried.
 */
function edgeMasks(image, names) {
  const cv = window.cv;
  const masks = [];
  withMats((keep) => {
    const gray = keep(toGray(image));
    const blurred = keep(new cv.Mat());
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    let smoothed = null;
    const bilateral = () => {
      if (!smoothed) {
        smoothed = keep(new cv.Mat());
        cv.bilateralFilter(gray, smoothed, 9, 60, 60);
      }
      return smoothed;
    };

    for (const name of names) {
      if (name === "canny") {
        const edges = keep(autoCanny(blurred));
        masks.push({ name, mat: closeMask(edges, 5) });
      } else if (name === "canny-bilateral") {
        const edges = keep(autoCanny(bilateral()));
        masks.push({ name, mat: closeMask(edges, 7) });
      } else if (name === "gradient") {
        const kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
        const gradient = keep(new cv.Mat());
        cv.morphologyEx(bilateral(), gradient, cv.MORPH_GRADIENT, kernel);
        const mask = keep(new cv.Mat());
        cv.threshold(gradient, mask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        masks.push({ name, mat: closeMask(mask, 5) });
      } else if (name === "otsu" || name === "otsu-inverted") {
        const mask = keep(new cv.Mat());
        const type = name === "otsu" ? cv.THRESH_BINARY : cv.THRESH_BINARY_INV;
        cv.threshold(blurred, mask, 0, 255, type + cv.THRESH_OTSU);
        masks.push({ name, mat: closeMask(mask, 7) });
      } else if (name === "saturation" && image.channels() >= 3) {
        // paper is usually the least saturated area of the scene
        const hsv = keep(new cv.Mat());
        cv.cvtColor(image, hsv, cv.COLOR_RGB2HSV);
        const channels = keep(new cv.MatVector());
        cv.split(hsv, channels);
        const saturation = keep(channels.get(1));
        const smoothedSaturation = keep(new cv.Mat());
        cv.GaussianBlur(saturation, smoothedSaturation, new cv.Size(5, 5), 0);
        const mask = keep(new cv.Mat());
        cv.threshold(smoothedSaturation, mask, 0, 255,
                     cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
        for (let index = 0; index < channels.size(); index += 1) {
          if (index !== 1) channels.get(index).delete();
        }
        masks.push({ name, mat: closeMask(mask, 7) });
      }
    }
  });
  return masks;
}

/** Smooth, normalised edge strength map used to verify candidates. */
function gradientMap(image) {
  const cv = window.cv;
  return withMats((keep) => {
    const gray = keep(toGray(image));
    const blurred = keep(new cv.Mat());
    cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
    const dx = keep(new cv.Mat());
    const dy = keep(new cv.Mat());
    cv.Sobel(blurred, dx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(blurred, dy, cv.CV_32F, 0, 1, 3);
    const magnitude = keep(new cv.Mat());
    cv.magnitude(dx, dy, magnitude);
    // blurring makes the support test tolerant against a few pixels of offset
    const smooth = new cv.Mat();
    cv.GaussianBlur(magnitude, smooth, new cv.Size(0, 0), 2.0);
    const reference = percentileFloat(smooth, 99);
    if (reference > 1e-6) {
      const scaled = new cv.Mat();
      smooth.convertTo(scaled, cv.CV_32F, 1 / reference, 0);
      smooth.delete();
      return scaled;
    }
    return smooth;
  });
}

/**
 * Weakest average edge strength along the four sides of a quad.
 *
 * Sides running along the image border are left out of the vote (a page held
 * too close is cut off and has no visible border there), but a candidate made
 * mostly of image borders is rejected: that is a frame, not a page.
 */
function edgeSupport(gradient, quad, samples = 40, borderTolerance = 0.012) {
  const width = gradient.cols;
  const height = gradient.rows;
  const data = gradient.data32F;
  const limit = borderTolerance * Math.max(width, height);
  const supports = [];
  let borderSides = 0;

  for (let side = 0; side < 4; side += 1) {
    const [x1, y1] = quad[side];
    const [x2, y2] = quad[(side + 1) % 4];
    let onBorder = 0;
    let inside = 0;
    let usable = 0;
    let total = 0;
    for (let step = 0; step < samples; step += 1) {
      const t = 0.08 + (0.84 * step) / (samples - 1);
      const column = Math.round(x1 + (x2 - x1) * t);
      const row = Math.round(y1 + (y2 - y1) * t);
      const isInside = column >= 0 && column < width && row >= 0 && row < height;
      const isBorder = column <= limit || column >= width - 1 - limit
                    || row <= limit || row >= height - 1 - limit;
      if (isBorder) onBorder += 1;
      if (isInside) inside += 1;
      if (isInside && !isBorder) {
        total += data[row * width + column];
        usable += 1;
      }
    }
    if (onBorder / samples > 0.8) { borderSides += 1; continue; }
    if (usable === 0) return 0;
    // a side that is mostly outside the frame stays suspicious
    supports.push((total / usable) * Math.min(1, inside / (0.75 * samples)));
  }
  if (borderSides >= 3 || supports.length === 0) return 0;
  return Math.min(...supports) * Math.pow(0.85, borderSides);
}

function scoreCandidate(quad, contourArea, imageArea, gradient) {
  const area = quadArea(quad);
  if (area <= 0) return { score: 0, areaRatio: 0 };
  const areaRatio = area / imageArea;
  const fill = contourArea > 0 ? Math.min(contourArea / area, area / contourArea) : 0;
  const support = edgeSupport(gradient, quad);
  return { score: support * (0.3 + 0.7 * fill) * Math.pow(areaRatio, 0.25), areaRatio };
}

function matToPoints(mat) {
  const data = mat.data32S;
  const points = [];
  for (let index = 0; index < data.length; index += 2) points.push([data[index], data[index + 1]]);
  return points;
}

/** Reduce a contour to four corners, trying several simplification levels. */
function quadCandidates(contour, epsilons) {
  const cv = window.cv;
  const quads = [];
  const perimeter = cv.arcLength(contour, true);
  if (perimeter <= 0) return quads;
  withMats((keep) => {
    const hull = keep(new cv.Mat());
    cv.convexHull(contour, hull, false, true);
    for (const source of [contour, hull]) {
      for (const epsilon of epsilons) {
        const approx = keep(new cv.Mat());
        cv.approxPolyDP(source, approx, epsilon * perimeter, true);
        if (approx.rows === 4) quads.push(matToPoints(approx));
      }
    }
    const rotated = cv.minAreaRect(contour);
    quads.push(cv.RotatedRect.points(rotated).map((point) => [point.x, point.y]));
  });
  return quads;
}

function deduplicate(candidates, tolerance = 0.02) {
  const kept = [];
  for (const candidate of candidates) {
    const xs = candidate.quad.map((p) => p[0]);
    const ys = candidate.quad.map((p) => p[1]);
    const spread = Math.max(Math.max(...xs) - Math.min(...xs),
                            Math.max(...ys) - Math.min(...ys), 1);
    const limit = tolerance * spread;
    const duplicate = kept.some((other) => candidate.quad.every(
      (point, index) => Math.hypot(point[0] - other.quad[index][0],
                                   point[1] - other.quad[index][1]) <= limit));
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

function pointInQuad(quad, point) {
  // winding test with a small tolerance, mirroring cv2.pointPolygonTest
  let sign = 0;
  for (let index = 0; index < 4; index += 1) {
    const [x1, y1] = quad[index];
    const [x2, y2] = quad[(index + 1) % 4];
    const cross = (x2 - x1) * (point[1] - y1) - (y2 - y1) * (point[0] - x1);
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    const distance = cross / length;
    if (Math.abs(distance) <= 2) continue;   // on the edge
    const current = distance > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}

function preferEnclosing(candidates, width, height,
                         { scoreRatio = 0.6, clippedScoreRatio = 0.35, areaRatio = 1.25 } = {}) {
  if (candidates.length < 2) return candidates;
  const best = candidates[0];
  let promoted = best;
  for (const candidate of candidates.slice(1)) {
    const clipped = touchesBorder(candidate.quad, width, height);
    const limit = clipped ? clippedScoreRatio : scoreRatio;
    if (candidate.score < limit * best.score) continue;
    if (quadArea(candidate.quad) < areaRatio * quadArea(promoted.quad)) continue;
    if (best.quad.every((point) => pointInQuad(candidate.quad, point))) promoted = candidate;
  }
  if (promoted === best) return candidates;
  return [promoted].concat(candidates.filter((item) => item !== promoted));
}

/** All plausible page outlines of an RGB Mat, best score first. */
export function detectCandidates(image, {
  minAreaRatio = 0.08, workingSize = 720, maxContours = 8, minScore = 0.05, fast = false,
} = {}) {
  const cv = window.cv;
  const { mat: small, scale } = resizeMax(image, workingSize);
  const candidates = [];
  try {
    const imageArea = small.rows * small.cols;
    const gradient = gradientMap(small);
    const names = fast ? FAST_STRATEGIES : STRATEGIES;
    const epsilons = fast ? FAST_EPSILONS : APPROX_EPSILONS;
    const masks = edgeMasks(small, names);
    try {
      for (const { name, mat } of masks) {
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(mat, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
        const entries = [];
        for (let index = 0; index < contours.size(); index += 1) {
          const contour = contours.get(index);
          entries.push({ contour, area: cv.contourArea(contour) });
        }
        entries.sort((a, b) => b.area - a.area);
        entries.slice(maxContours).forEach((entry) => entry.contour.delete());
        for (const { contour, area } of entries.slice(0, maxContours)) {
          if (area / imageArea >= minAreaRatio) {
            for (const quad of quadCandidates(contour, epsilons)) {
              if (!quadIsSane(quad)) continue;
              const { score, areaRatio } = scoreCandidate(quad, area, imageArea, gradient);
              if (areaRatio < minAreaRatio || areaRatio > 1.05 || score < minScore) continue;
              candidates.push({
                quad: orderCorners(quad), score, areaRatio, method: name,
              });
            }
          }
          contour.delete();
        }
        contours.delete();
        hierarchy.delete();
      }
    } finally {
      masks.forEach(({ mat }) => mat.delete());
      gradient.delete();
    }
    candidates.sort((a, b) => b.score - a.score);
    const unique = preferEnclosing(deduplicate(candidates), small.cols, small.rows);
    return unique.map((candidate) => ({
      ...candidate,
      quad: scale === 1 ? candidate.quad : scaleQuad(candidate.quad, 1 / scale),
    }));
  } finally {
    small.delete();
  }
}

/** Best page outline of an RGB Mat, or null when nothing fits. */
export function findDocument(image, options = {}) {
  const candidates = detectCandidates(image, options);
  if (candidates.length) return candidates[0];
  if (options.fallback) {
    return {
      quad: fullFrameQuad(image.cols, image.rows), score: 0, areaRatio: 1, method: "full-frame",
    };
  }
  return null;
}
