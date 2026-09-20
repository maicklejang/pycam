/* Curved page outlines and flattening - a port of docscan/curve.py.
 *
 * A photographed page is rarely flat: a book bends, a receipt curls.  The
 * outline is therefore described by four quadratic Bezier edges, and that
 * curved patch is mapped onto a rectangle (a Coons patch).  The control points
 * come either from the user dragging an edge in the editor, or from
 * refineEdges following the real page border.
 */

import { withMats } from "./cv.js";
import { toGray } from "./mat.js";
import { orderCorners, outputSize, projectiveFocal } from "./transform.js";

/** A bulge below this fraction of an edge counts as straight. */
export const STRAIGHT_LIMIT = 0.012;

export function bezierPoint(start, control, end, t) {
  const inverse = 1 - t;
  return [inverse * inverse * start[0] + 2 * inverse * t * control[0] + t * t * end[0],
          inverse * inverse * start[1] + 2 * inverse * t * control[1] + t * t * end[1]];
}

/** Control point of the curve that passes through `middle` at t = 0.5. */
export function controlFromMidpoint(start, end, middle) {
  return [2 * middle[0] - 0.5 * (start[0] + end[0]),
          2 * middle[1] - 0.5 * (start[1] + end[1])];
}

export function midpointFromControl(start, control, end) {
  return bezierPoint(start, control, end, 0.5);
}

/** How many points of each edge a measured border profile keeps. */
export const PROFILE_SAMPLES = 129;

/** Start, direction, length and inward normal of one edge of a quad. */
export function edgeFrame(corners, index) {
  const start = corners[index];
  const end = corners[(index + 1) % 4];
  const direction = [end[0] - start[0], end[1] - start[1]];
  const length = Math.hypot(direction[0], direction[1]);
  if (length < 1e-6) return { start, direction, length: 0, normal: [0, 0] };
  let normal = [-direction[1] / length, direction[0] / length];
  const chord = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const centre = [(corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4,
                  (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4];
  if ((centre[0] - chord[0]) * normal[0] + (centre[1] - chord[1]) * normal[1] < 0) {
    normal = [-normal[0], -normal[1]];
  }
  return { start, direction, length, normal };
}

/**
 * Four corners (TL, TR, BR, BL) plus one Bezier control point per edge.
 *
 * A single quadratic per edge is what a person can drag, and it is enough for
 * the outline the app draws.  It is not enough to flatten a strongly curled
 * sheet, so when the border has been measured in the photo the samples are
 * kept alongside, in `profiles`, and the flattening follows those.  They are
 * offsets from the straight chord along its inward normal, so they only mean
 * anything for these corners: any edit that moves a corner drops them.
 */
export class CurvedQuad {
  constructor(corners, controls, profiles = null) {
    this.corners = corners.map((point) => [point[0], point[1]]);
    this.controls = controls.map((point) => [point[0], point[1]]);
    this.profiles = profiles ? profiles.map((row) => Float64Array.from(row)) : null;
  }

  static fromQuad(quad) {
    const corners = orderCorners(quad);
    const controls = corners.map((corner, index) => {
      const next = corners[(index + 1) % 4];
      return [(corner[0] + next[0]) / 2, (corner[1] + next[1]) / 2];
    });
    return new CurvedQuad(corners, controls);
  }

  /** Build from corners and the point each edge should pass through. */
  static fromMidpoints(corners, midpoints) {
    const ordered = orderCorners(corners);
    const controls = ordered.map((corner, index) => controlFromMidpoint(
      corner, ordered[(index + 1) % 4], midpoints[index]));
    return new CurvedQuad(ordered, controls);
  }

  get midpoints() {
    return this.corners.map((corner, index) => midpointFromControl(
      corner, this.controls[index], this.corners[(index + 1) % 4]));
  }

  edge(index, t) {
    return bezierPoint(this.corners[index], this.controls[index],
                       this.corners[(index + 1) % 4], t);
  }

  /**
   * The page border along an edge - measured if it was measured.
   *
   * `edge` is the Bezier the UI draws; this is what the flattening follows,
   * which is the same curve unless a profile was measured.
   */
  border(index, t) {
    if (!this.profiles) return this.edge(index, t);
    const { start, direction, length, normal } = edgeFrame(this.corners, index);
    if (length < 1e-6) return this.edge(index, t);
    const profile = this.profiles[index];
    const last = profile.length - 1;
    const place = Math.min(last, Math.max(0, t * last));
    const low = Math.floor(place);
    const high = Math.min(last, low + 1);
    const offset = profile[low] + (place - low) * (profile[high] - profile[low]);
    return [start[0] + direction[0] * t + normal[0] * offset,
            start[1] + direction[1] * t + normal[1] * offset];
  }

  /** The same outline as the plain Bezier one - what an edit leaves. */
  withoutProfiles() {
    return new CurvedQuad(this.corners, this.controls);
  }

  /** Corners and edge midpoints, as the editor and the page store want them. */
  asDict() {
    return { corners: this.corners.map((point) => point.slice()), midpoints: this.midpoints };
  }

  edgeLength(index, samples = 64) {
    let total = 0;
    let previous = this.edge(index, 0);
    for (let step = 1; step < samples; step += 1) {
      const point = this.edge(index, step / (samples - 1));
      total += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
      previous = point;
    }
    return total;
  }

  get centre() {
    const sum = this.corners.reduce((total, point) => [total[0] + point[0],
                                                       total[1] + point[1]], [0, 0]);
    return [sum[0] / 4, sum[1] / 4];
  }

  /** Signed sideways offset of an edge in pixels; positive is outwards. */
  edgeBulge(index) {
    const start = this.corners[index];
    const end = this.corners[(index + 1) % 4];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (length < 1e-6) return 0;
    const middle = midpointFromControl(start, this.controls[index], end);
    const chord = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    const centre = this.centre;
    const outward = [chord[0] - centre[0], chord[1] - centre[1]];
    const norm = Math.hypot(outward[0], outward[1]);
    if (norm < 1e-6) return 0;
    return ((middle[0] - chord[0]) * outward[0] + (middle[1] - chord[1]) * outward[1]) / norm;
  }

  edgeCurvature(index) {
    const start = this.corners[index];
    const end = this.corners[(index + 1) % 4];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    return length < 1e-6 ? 0 : this.edgeBulge(index) / length;
  }

  curvature() {
    let worst = 0;
    for (let index = 0; index < 4; index += 1) {
      worst = Math.max(worst, Math.abs(this.edgeCurvature(index)));
    }
    return worst;
  }

  get isStraight() {
    return this.curvature() < STRAIGHT_LIMIT;
  }

  clone() {
    return new CurvedQuad(this.corners, this.controls);
  }
}

/* -- flattening ---------------------------------------------------------- */

function matrix3FromMat(mat) {
  const values = [];
  for (let index = 0; index < 9; index += 1) values.push(mat.doubleAt(0, index));
  return values;
}

function applyMatrix(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** Linear interpolation like np.interp, tolerating unsorted samples. */
function interpolate(target, xs, ys) {
  const order = xs.map((value, index) => index).sort((a, b) => xs[a] - xs[b]);
  const sortedX = order.map((index) => xs[index]);
  const sortedY = order.map((index) => ys[index]);
  const last = sortedX.length - 1;
  const result = new Float64Array(target.length);
  let cursor = 0;
  for (let index = 0; index < target.length; index += 1) {
    const value = target[index];
    if (value <= sortedX[0]) { result[index] = sortedY[0]; continue; }
    if (value >= sortedX[last]) { result[index] = sortedY[last]; continue; }
    while (cursor < last - 1 && sortedX[cursor + 1] < value) cursor += 1;
    while (cursor > 0 && sortedX[cursor] > value) cursor -= 1;
    const span = sortedX[cursor + 1] - sortedX[cursor];
    result[index] = span < 1e-12
      ? sortedY[cursor]
      : sortedY[cursor] + ((value - sortedX[cursor]) / span)
        * (sortedY[cursor + 1] - sortedY[cursor]);
  }
  return result;
}

function lengthFactor(curved, first, second) {
  let best = 1;
  for (const index of [first, second]) {
    const start = curved.corners[index];
    const end = curved.corners[(index + 1) % 4];
    const chord = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (chord < 1e-6) continue;
    best = Math.max(best, curved.edgeLength(index) / chord);
  }
  return best;
}

/**
 * Output size of the flattened page: the straight estimate from transform.js,
 * stretched by how much longer the curved edges are.
 */
export function flattenSize(curved, width, height, aspect = "auto", maxSide = 0) {
  const size = outputSize(curved.corners, width, height, aspect);
  let outWidth = size[0] * lengthFactor(curved, 0, 2);
  let outHeight = size[1] * lengthFactor(curved, 1, 3);
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
 * The four page borders in rectified coordinates, as y(x) for the top and
 * bottom and x(y) for the sides.  Expressing them this way also fixes the
 * spacing: a straight edge seen in perspective is not sampled evenly by its
 * Bezier parameter, and that alone would bend every text line in the result.
 */
function boundaryCurves(curved, width, height, samples = 256) {
  const cv = window.cv;
  return withMats((keep) => {
    const source = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [
      curved.corners[0][0], curved.corners[0][1], curved.corners[1][0], curved.corners[1][1],
      curved.corners[2][0], curved.corners[2][1], curved.corners[3][0], curved.corners[3][1],
    ]));
    const target = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1,
    ]));
    const forward = keep(cv.getPerspectiveTransform(source, target));
    const backward = keep(new cv.Mat());
    cv.invert(forward, backward);
    const matrix = matrix3FromMat(forward);
    const inverse = matrix3FromMat(backward);

    const sampleEdge = (index, reverse) => {
      const xs = new Float64Array(samples);
      const ys = new Float64Array(samples);
      for (let step = 0; step < samples; step += 1) {
        const t = step / (samples - 1);
        const point = curved.border(index, reverse ? 1 - t : t);
        const mapped = applyMatrix(matrix, point[0], point[1]);
        xs[step] = mapped[0];
        ys[step] = mapped[1];
      }
      return { xs, ys };
    };

    const top = sampleEdge(0, false);          // TL -> TR
    const right = sampleEdge(1, false);        // TR -> BR
    const bottom = sampleEdge(2, true);        // BR -> BL, reversed to BL -> BR
    const left = sampleEdge(3, true);          // BL -> TL, reversed to TL -> BL

    const columns = new Float64Array(width);
    for (let x = 0; x < width; x += 1) columns[x] = x;
    const rows = new Float64Array(height);
    for (let y = 0; y < height; y += 1) rows[y] = y;

    return {
      inverse,
      topY: interpolate(columns, Array.from(top.xs), Array.from(top.ys)),
      bottomY: interpolate(columns, Array.from(bottom.xs), Array.from(bottom.ys)),
      leftX: interpolate(rows, Array.from(left.ys), Array.from(left.xs)),
      rightX: interpolate(rows, Array.from(right.ys), Array.from(right.xs)),
    };
  });
}

/**
 * Positions along one axis that sample the real sheet evenly.
 *
 * Where the paper turns away from the camera it is foreshortened, and
 * sampling the rectified rectangle evenly squeezes the text there - the
 * difference between a photo that has been straightened and a page that has
 * been scanned.  The two ends of each ruling (a line across the sheet) say
 * how much: the ruling's image length is its distance, its position is its
 * direction, and together they give the sheet's cross-section up to one scale
 * factor.  Walking that at equal arc length unrolls the sheet.
 */
function arcWalk(first, second, focal, centre) {
  const count = first.length;
  const walked = new Float64Array(count);
  let previous = null;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const a = first[index];
    const b = second[index];
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(span > 1e-6)) return null;
    const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const point = [(middle[0] - centre[0]) / focal / span,
                   (middle[1] - centre[1]) / focal / span, 1 / span];
    if (previous) {
      total += Math.hypot(point[0] - previous[0], point[1] - previous[1],
                          point[2] - previous[2]);
    }
    walked[index] = total;
    previous = point;
  }
  if (!(total > 0)) return null;
  for (let index = 0; index < count; index += 1) walked[index] /= total;
  return walked;
}

/**
 * Sampling positions that undo the curl, and nothing else.
 *
 * A ruling is also foreshortened by its own slant, which the perspective
 * transform has already dealt with, so the walk is compared against the same
 * walk over the straight outline instead of being used on its own.  On a flat
 * page the two are identical and the spacing stays even, to the pixel.
 */
function arcPositions(curvedEnds, straightEnds, focal, centre) {
  const walked = arcWalk(curvedEnds[0], curvedEnds[1], focal, centre);
  const reference = arcWalk(straightEnds[0], straightEnds[1], focal, centre);
  if (!walked || !reference) return null;
  const count = walked.length;
  const index = new Float64Array(count);
  for (let step = 0; step < count; step += 1) index[step] = step;
  // column j should cover as much paper as the flat model says it does
  return interpolate(reference, Array.from(walked), Array.from(index));
}

/**
 * Focal length in pixels to unroll a sheet photographed like this.
 *
 * The perspective of the outline gives it when there is any; a shot taken
 * straight on carries none, and then the usual field of view of a phone
 * camera is a better guess than pretending the lens is flat.
 */
export function cameraFocal(curved, width, height) {
  const longest = Math.max(width, height);
  const focal = projectiveFocal(curved.corners, width, height);
  if (focal === null || !(focal >= 0.3 * longest && focal <= 4 * longest)) {
    return 0.8 * longest;
  }
  return focal;
}

/** Map a curved page outline onto a straight rectangle; returns a new Mat. */
export function flatten(image, curved, { size = null, aspect = "auto", maxSide = 0 } = {}) {
  const cv = window.cv;
  const [width, height] = size
    || flattenSize(curved, image.cols, image.rows, aspect, maxSide);
  const curves = boundaryCurves(curved, width, height);
  const { inverse } = curves;
  let { topY, bottomY, leftX, rightX } = curves;

  const focal = cameraFocal(curved, image.cols, image.rows);
  const centre = [image.cols / 2, image.rows / 2];
  const photoRow = (xs, ys) => xs.map((x, index) => applyMatrix(inverse, x, ys[index]));
  const columnIndex = Array.from({ length: width }, (unused, index) => index);
  const rowIndex = Array.from({ length: height }, (unused, index) => index);
  let columns = Float64Array.from(columnIndex);
  let rows = Float64Array.from(rowIndex);

  const across = arcPositions(
    [photoRow(columnIndex, topY), photoRow(columnIndex, bottomY)],
    [photoRow(columnIndex, columnIndex.map(() => 0)),
     photoRow(columnIndex, columnIndex.map(() => height - 1))],
    focal, centre);
  const down = arcPositions(
    [photoRow(rowIndex.map((index) => leftX[index]), rowIndex),
     photoRow(rowIndex.map((index) => rightX[index]), rowIndex)],
    [photoRow(rowIndex.map(() => 0), rowIndex),
     photoRow(rowIndex.map(() => width - 1), rowIndex)],
    focal, centre);
  if (across) {
    columns = across;
    topY = interpolate(across, columnIndex, Array.from(topY));
    bottomY = interpolate(across, columnIndex, Array.from(bottomY));
  }
  if (down) {
    rows = down;
    leftX = interpolate(down, rowIndex, Array.from(leftX));
    rightX = interpolate(down, rowIndex, Array.from(rightX));
  }

  const mapX = new Float32Array(width * height);
  const mapY = new Float32Array(width * height);
  const right = width - 1;
  const bottomRow = height - 1;
  for (let y = 0; y < height; y += 1) {
    const v = height === 1 ? 0 : y / bottomRow;
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      const u = width === 1 ? 0 : x / right;
      // The Coons patch of four boundary *graphs* (y(x) on top and bottom,
      // x(y) on the sides) reduces to this, with the sampling positions in
      // place of the plain column and row: the bilinear corner surface
      // cancels against the ruled parts it is subtracted from, except for the
      // one term each axis keeps.  Same surface as curve.py builds.
      const sx = columns[x] + (1 - u) * leftX[y] + u * rightX[y] - u * right;
      const sy = rows[y] + (1 - v) * topY[x] + v * bottomY[x] - v * bottomRow;
      const photo = applyMatrix(inverse, sx, sy);
      mapX[rowOffset + x] = photo[0];
      mapY[rowOffset + x] = photo[1];
    }
  }

  return withMats((keep) => {
    const matX = keep(new cv.Mat(height, width, cv.CV_32FC1));
    const matY = keep(new cv.Mat(height, width, cv.CV_32FC1));
    matX.data32F.set(mapX);
    matY.data32F.set(mapY);
    const result = new cv.Mat();
    cv.remap(image, result, matX, matY, cv.INTER_CUBIC, cv.BORDER_REPLICATE,
             new cv.Scalar());
    return result;
  });
}

/* -- following the real page border -------------------------------------- */

function medianOf(values) {
  if (!values.length) return null;
  const sorted = Float64Array.from(values).sort();
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The medians below are measured on a copy no larger than this. */
const LEVEL_SIZE = 480;

/**
 * Median brightness of the page and of the background around it.
 *
 * Measured on a small copy: the medians do not need full resolution, and
 * growing the page polygon by a band that is a percent of the diagonal means a
 * structuring element of well over a hundred pixels at full size - which costs
 * seconds in WebAssembly.
 */
function levels(gray, corners, band) {
  const cv = window.cv;
  return withMats((keep) => {
    const scale = Math.min(1, LEVEL_SIZE / Math.max(gray.rows, gray.cols));
    let small = gray;
    if (scale < 1) {
      small = keep(new cv.Mat());
      cv.resize(gray, small, new cv.Size(Math.max(8, Math.round(gray.cols * scale)),
                                         Math.max(8, Math.round(gray.rows * scale))),
                0, 0, cv.INTER_AREA);
    }
    const inside = keep(cv.Mat.zeros(small.rows, small.cols, cv.CV_8UC1));
    const points = keep(cv.matFromArray(4, 1, cv.CV_32SC2, corners.flatMap(
      (corner) => [Math.round(corner[0] * scale), Math.round(corner[1] * scale)])));
    const polygons = keep(new cv.MatVector());
    polygons.push_back(points);
    cv.fillPoly(inside, polygons, new cv.Scalar(255));
    const size = Math.max(3, Math.round(band * scale) * 2 + 1);
    const kernel = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(size, size)));
    const core = keep(new cv.Mat());
    const grown = keep(new cv.Mat());
    cv.erode(inside, core, kernel);
    cv.dilate(inside, grown, kernel);
    const ring = keep(new cv.Mat());
    cv.subtract(grown, inside, ring);

    const pick = (mask) => {
      const values = [];
      const data = small.data;
      const maskData = mask.data;
      for (let row = 0; row < small.rows; row += 1) {
        const offset = row * small.cols;
        for (let column = 0; column < small.cols; column += 1) {
          if (maskData[offset + column]) values.push(data[offset + column]);
        }
      }
      return values.length < 50 ? null : medianOf(values);
    };
    return { page: pick(core), background: pick(ring) };
  });
}

/**
 * Follow the real page border and return a CurvedQuad.
 *
 * The brightness is read along each edge normal from outside the page inwards;
 * the border is where the profile changes from background to paper and stays
 * there - not simply where the gradient is strongest, because the first line
 * of text is a stronger edge than the rim of the sheet.
 */
export function refineEdges(image, quad, {
  searchRatio = 0.03, samples = 41, offsets = 61, maxCurvature = 0.25, hold = 4,
  rounds = 2,
} = {}) {
  const straight = CurvedQuad.fromQuad(quad);
  const cv = window.cv;
  return withMats((keep) => {
    const gray = keep(toGray(image));
    const blurred = keep(new cv.Mat());
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    const diagonal = Math.hypot(image.rows, image.cols);
    const band = Math.max(3, searchRatio * diagonal);
    const { page, background } = levels(blurred, straight.corners, band);
    if (page === null || background === null || Math.abs(page - background) < 12) {
      return straight;
    }

    const data = blurred.data;
    const width = blurred.cols;
    const height = blurred.rows;
    const valueAt = (x, y) => {
      const column = Math.min(width - 1, Math.max(0, Math.round(x)));
      const row = Math.min(height - 1, Math.max(0, Math.round(y)));
      if (x < 0 || x >= width || y < 0 || y >= height) return background;
      return data[row * width + column];
    };

    /**
     * Offsets of the real border from one chord, as a quadratic in t.
     *
     * The edge is sampled at a number of positions and, at each of them, the
     * brightness is read along the edge normal from outside the page inwards.
     * The border is where the profile changes from background to paper and
     * stays there - not simply where the gradient is strongest, because the
     * first line of text is a stronger edge than the rim of the sheet, and a
     * textured surface (wood, cloth) is full of strong edges of its own.
     */
    const measure = (corners, index) => {
      const { start, direction, length, normal } = edgeFrame(corners, index);
      if (length < 1e-6) return null;
      const ts = [];
      const shifts = [];
      for (let sample = 0; sample < samples; sample += 1) {
        // skip the corners: the border bends there and the fit would chase it
        const t = 0.1 + (0.8 * sample) / (samples - 1);
        const baseX = start[0] + direction[0] * t;
        const baseY = start[1] + direction[1] * t;
        let run = 0;
        let found = null;
        for (let step = 0; step < offsets; step += 1) {
          const shift = -band + (2 * band * step) / (offsets - 1);
          const value = valueAt(baseX + normal[0] * shift, baseY + normal[1] * shift);
          const pageLike = Math.abs(value - page) < Math.abs(value - background);
          run = pageLike ? run + 1 : 0;
          if (run >= hold) {
            found = shift - (2 * band * (hold - 1)) / (offsets - 1);
            break;
          }
        }
        if (found !== null) { ts.push(t); shifts.push(found); }
      }
      if (ts.length < Math.max(4, Math.floor(samples / 2))) return null;
      const fit = polyfit2(ts, shifts);
      if (!fit) return null;
      let spread = 0;
      for (let sample = 0; sample < ts.length; sample += 1) {
        const residual = shifts[sample] - polyval2(fit, ts[sample]);
        spread += residual * residual;
      }
      if (Math.sqrt(spread / ts.length) > 0.3 * band) return null;
      return fit;
    };

    const profilePoint = (corners, index, fit, t) => {
      const { start, direction, normal } = edgeFrame(corners, index);
      const offset = polyval2(fit, t);
      return [start[0] + direction[0] * t + normal[0] * offset,
              start[1] + direction[1] * t + normal[1] * offset];
    };

    /**
     * Where the end of one fitted border crosses the start of the next.
     *
     * A detector can only fit a straight quad, and the extreme points of a
     * curled sheet's silhouette are not its corners - at a strong curl they
     * miss by tens of pixels, and every later step is anchored to them.  The
     * borders are measured away from the corners, where they behave, so
     * extending them until they cross puts the corner back where the paper
     * actually ends.
     */
    const meetingPoint = (corners, index, fits, reach = 0.35, count = 257) => {
      const following = (index + 1) % 4;
      const first = [];
      const second = [];
      for (let step = 0; step < count; step += 1) {
        const offset = -reach + (2 * reach * step) / (count - 1);
        first.push(profilePoint(corners, index, fits[index], 1 + offset));
        second.push(profilePoint(corners, following, fits[following], offset));
      }
      let best = Infinity;
      let point = null;
      for (let a = 0; a < count; a += 1) {
        for (let b = 0; b < count; b += 1) {
          const distance = Math.hypot(first[a][0] - second[b][0], first[a][1] - second[b][1]);
          if (distance < best) {
            best = distance;
            point = [(first[a][0] + second[b][0]) / 2, (first[a][1] + second[b][1]) / 2];
          }
        }
      }
      return { point, gap: best };
    };

    let corners = straight.corners.map((corner) => [corner[0], corner[1]]);
    let fits = null;
    for (let round = 0; round < Math.max(1, rounds); round += 1) {
      const measured = [0, 1, 2, 3].map((index) => measure(corners, index));
      if (measured.some((fit) => fit === null)) break;
      fits = measured;
      if (round + 1 >= rounds) break;
      const moved = corners.map((corner) => [corner[0], corner[1]]);
      for (let index = 0; index < 4; index += 1) {
        const { point, gap } = meetingPoint(corners, index, fits);
        if (gap < 0.02 * diagonal) moved[(index + 1) % 4] = point;
      }
      let travelled = 0;
      for (let index = 0; index < 4; index += 1) {
        travelled = Math.max(travelled, Math.hypot(moved[index][0] - corners[index][0],
                                                   moved[index][1] - corners[index][1]));
      }
      corners = moved;
      if (travelled < 0.5) break;
    }
    if (!fits) return straight;

    const controls = CurvedQuad.fromQuad(corners).controls.map((p) => [p[0], p[1]]);
    const profiles = [];
    let bent = false;
    for (let index = 0; index < 4; index += 1) {
      const row = new Float64Array(PROFILE_SAMPLES);
      profiles.push(row);
      const { start, direction, length, normal } = edgeFrame(corners, index);
      if (length < 1e-6) continue;
      const ends = [polyval2(fits[index], 0), polyval2(fits[index], 1)];
      for (let step = 0; step < PROFILE_SAMPLES; step += 1) {
        const t = step / (PROFILE_SAMPLES - 1);
        // the ends belong to the corners, which the borders already agreed on
        row[step] = polyval2(fits[index], t) - ((1 - t) * ends[0] + t * ends[1]);
      }
      const bulge = row[(PROFILE_SAMPLES - 1) >> 1];
      if (Math.abs(bulge) > maxCurvature * length) { row.fill(0); continue; }
      if (row.some((value) => value !== 0)) bent = true;
      if (Math.abs(bulge) < STRAIGHT_LIMIT * length) continue;
      const middle = [start[0] + direction[0] / 2 + normal[0] * bulge,
                      start[1] + direction[1] / 2 + normal[1] * bulge];
      controls[index] = controlFromMidpoint(start, [start[0] + direction[0],
                                                    start[1] + direction[1]], middle);
    }
    return new CurvedQuad(corners, controls, bent ? profiles : null);
  });
}

/** Least squares fit of a quadratic; returns [a, b, c] for a*t^2 + b*t + c. */
function polyfit2(ts, values) {
  let s0 = 0; let s1 = 0; let s2 = 0; let s3 = 0; let s4 = 0;
  let t0 = 0; let t1 = 0; let t2 = 0;
  for (let index = 0; index < ts.length; index += 1) {
    const t = ts[index];
    const y = values[index];
    const tt = t * t;
    s0 += 1; s1 += t; s2 += tt; s3 += tt * t; s4 += tt * tt;
    t0 += y; t1 += y * t; t2 += y * tt;
  }
  const m = [[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]];
  const rhs = [t2, t1, t0];
  const determinant = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(determinant) < 1e-12) return null;
  const solve = (column) => {
    const copy = m.map((row) => row.slice());
    for (let row = 0; row < 3; row += 1) copy[row][column] = rhs[row];
    return (copy[0][0] * (copy[1][1] * copy[2][2] - copy[1][2] * copy[2][1])
      - copy[0][1] * (copy[1][0] * copy[2][2] - copy[1][2] * copy[2][0])
      + copy[0][2] * (copy[1][0] * copy[2][1] - copy[1][1] * copy[2][0])) / determinant;
  };
  return [solve(0), solve(1), solve(2)];
}

function polyval2(fit, t) {
  return fit[0] * t * t + fit[1] * t + fit[2];
}

/* -- straightening the text lines ---------------------------------------- */

/** Rough binary mask of the writing on an already rectified page. */
function inkMask(image) {
  const cv = window.cv;
  return withMats((keep) => {
    const gray = keep(toGray(image));
    const longest = Math.max(gray.rows, gray.cols);
    const kernelSize = Math.max(3, (Math.round(longest * 0.012) | 1));
    const kernel = keep(cv.Mat.ones(kernelSize, kernelSize, cv.CV_8UC1));
    const dilated = keep(new cv.Mat());
    cv.dilate(gray, dilated, kernel);
    const background = keep(new cv.Mat());
    cv.medianBlur(dilated, background, Math.max(3, (Math.round(longest * 0.02) | 1)));
    const flattened = keep(new cv.Mat());
    cv.divide(gray, background, flattened, 255);
    const block = Math.max(15, (Math.round(longest * 0.025) | 1));
    const mask = new cv.Mat();
    cv.adaptiveThreshold(flattened, mask, 1, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                         cv.THRESH_BINARY_INV, block, 10);
    return mask;
  });
}

/** Blur a profile down its length, exactly as curve.py does. */
function smoothProfile(profile) {
  const cv = window.cv;
  return withMats((keep) => {
    const column = keep(new cv.Mat(profile.length, 1, cv.CV_32FC1));
    column.data32F.set(Float32Array.from(profile));
    const blurred = keep(new cv.Mat());
    cv.GaussianBlur(column, blurred, new cv.Size(1, 9), 0);
    return Float64Array.from(blurred.data32F);
  });
}

/** Row positions of the text lines in one vertical band. */
function bandPeaks(profile, minimum) {
  const smooth = smoothProfile(profile);
  const peaks = [];
  for (let row = 1; row < smooth.length - 1; row += 1) {
    if (smooth[row] >= minimum && smooth[row] >= smooth[row - 1]
        && smooth[row] > smooth[row + 1]) {
      const start = row;
      while (row < smooth.length - 1 && smooth[row + 1] === smooth[start]) row += 1;
      peaks.push((start + row) / 2);
    }
  }
  return peaks;
}

/**
 * Vertical displacement that makes the text lines of a page straight.
 *
 * The page is split into vertical bands; the text lines are the peaks of each
 * band's ink profile, and following a peak across the bands traces one line.
 * How far a line wanders from its own average is the residual bend.
 * Returns null when the page does not hold enough text to measure.
 */
/** Peaks that wander less than this are noise, not a bend (pixels). */
const NO_BEND = 3.0;

export function textLineField(image, { bands = 14, minLines = 5, maxShiftRatio = 0.08 } = {}) {
  const mask = inkMask(image);
  try {
    const height = mask.rows;
    const width = mask.cols;
    if (bands < 4 || width < bands * 8) return null;
    const data = mask.data;
    const edges = [];
    for (let index = 0; index <= bands; index += 1) {
      edges.push(Math.round((index * width) / bands));
    }
    const centres = [];
    const profiles = [];
    for (let index = 0; index < bands; index += 1) {
      const profile = new Float64Array(height);
      for (let row = 0; row < height; row += 1) {
        let total = 0;
        const offset = row * width;
        for (let column = edges[index]; column < edges[index + 1]; column += 1) {
          total += data[offset + column];
        }
        profile[row] = total;
      }
      profiles.push(profile);
      centres.push((edges[index] + edges[index + 1]) / 2);
    }

    const peaksOf = profiles.map((profile) => Math.max(...profile));
    const strength = medianOf(peaksOf);
    if (!strength || strength < 3) return null;
    const peaks = profiles.map((profile) => bandPeaks(profile, 0.35 * strength));

    const middle = bands >> 1;
    if (peaks[middle].length < minLines) return null;
    const tolerance = Math.max(4, height * 0.02);

    const lines = [];
    for (const seed of peaks[middle]) {
      const positions = new Map([[middle, seed]]);
      for (const direction of [-1, 1]) {
        let current = seed;
        let index = middle + direction;
        while (index >= 0 && index < bands) {
          if (!peaks[index].length) break;
          let nearest = peaks[index][0];
          for (const candidate of peaks[index]) {
            if (Math.abs(candidate - current) < Math.abs(nearest - current)) {
              nearest = candidate;
            }
          }
          if (Math.abs(nearest - current) > tolerance) break;
          positions.set(index, nearest);
          current = nearest;
          index += direction;
        }
      }
      if (positions.size >= Math.floor(bands * 0.7)) lines.push(positions);
    }
    if (lines.length < minLines) return null;

    const samples = lines.map((positions) => {
      const indexes = [...positions.keys()].sort((a, b) => a - b);
      const values = indexes.map((index) => positions.get(index));
      const mean = values.reduce((total, value) => total + value, 0) / values.length;
      const shift = values.map((value) => value - mean);
      const all = new Float64Array(bands);
      const grid = [];
      for (let index = 0; index < bands; index += 1) grid.push(index);
      const filled = interpolate(grid, indexes, shift);
      all.set(filled);
      return { y: mean, shift: all };
    }).sort((a, b) => a.y - b.y);

    let largest = 0;
    for (const sample of samples) {
      for (const value of sample.shift) largest = Math.max(largest, Math.abs(value));
    }
    if (largest > maxShiftRatio * height) return null;   // implausible: not text lines
    // wander of the detected peaks, not a bend worth resampling for: the
  // border based flattening leaves this much on a page it got right
  if (largest < NO_BEND) return new Float32Array(height * width);

    const columns = [];
    for (let column = 0; column < width; column += 1) columns.push(column);
    const perLine = samples.map(
      (sample) => interpolate(columns, centres, Array.from(sample.shift)));
    const lineY = samples.map((sample) => sample.y);

    const field = new Float32Array(height * width);
    const rows = [];
    for (let row = 0; row < height; row += 1) rows.push(row);
    for (let column = 0; column < width; column += 1) {
      const values = perLine.map((line) => line[column]);
      const down = interpolate(rows, lineY, values);
      for (let row = 0; row < height; row += 1) field[row * width + column] = down[row];
    }
    return field;
  } finally {
    mask.delete();
  }
}

/**
 * Remove the residual bend of the text lines of a rectified page.
 *
 * Following the border gets the shape of the sheet right, but a strongly
 * curled page keeps a bow in the middle, where there is no border to follow.
 * The text itself is the only evidence there.
 *
 * The result is always a new Mat - a copy when there was nothing to correct -
 * so the caller can delete the input and the output without having to know
 * which case it hit.
 */
export function straightenTextLines(image, options = {}) {
  const cv = window.cv;
  const field = textLineField(image, options);
  if (!field || !field.some((value) => value !== 0)) return image.clone();
  const height = image.rows;
  const width = image.cols;
  const mapX = new Float32Array(width * height);
  const mapY = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * width;
    for (let column = 0; column < width; column += 1) {
      mapX[offset + column] = column;
      mapY[offset + column] = row + field[offset + column];
    }
  }
  return withMats((keep) => {
    const matX = keep(new cv.Mat(height, width, cv.CV_32FC1));
    const matY = keep(new cv.Mat(height, width, cv.CV_32FC1));
    matX.data32F.set(mapX);
    matY.data32F.set(mapY);
    const result = new cv.Mat();
    cv.remap(image, result, matX, matY, cv.INTER_CUBIC, cv.BORDER_REPLICATE,
             new cv.Scalar());
    return result;
  });
}
