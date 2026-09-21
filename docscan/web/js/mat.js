/* Small helpers around OpenCV.js Mats.
 *
 * Note on colour order: the Python version works in BGR because that is what
 * cv2.imread returns, while in the browser an image arrives as RGBA.  The web
 * app converts to RGB once and stays there, so every colour conversion below
 * uses the RGB constants.
 */

import { withMats } from "./cv.js";

/** Read a canvas / image / video frame into an RGB Mat owned by the caller. */
export function matFromSource(source) {
  const cv = window.cv;
  const rgba = cv.imread(source);
  if (rgba.channels() === 3) return rgba;
  const rgb = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  rgba.delete();
  return rgb;
}

/** Draw a Mat (gray or RGB) into a canvas element. */
export function matToCanvas(mat, canvas) {
  window.cv.imshow(canvas, mat);
  return canvas;
}

/** Grayscale copy; returns a new Mat. */
export function toGray(source) {
  const cv = window.cv;
  if (source.channels() === 1) return source.clone();
  const gray = new cv.Mat();
  cv.cvtColor(source, gray, source.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
  return gray;
}

/** Downscale so that the longest side is at most `maxSide`; never upscales. */
export function resizeMax(source, maxSide) {
  const cv = window.cv;
  const longest = Math.max(source.rows, source.cols);
  if (!maxSide || longest <= maxSide) return { mat: source.clone(), scale: 1 };
  const scale = maxSide / longest;
  const resized = new cv.Mat();
  cv.resize(source, resized,
            new cv.Size(Math.max(1, Math.round(source.cols * scale)),
                        Math.max(1, Math.round(source.rows * scale))),
            0, 0, cv.INTER_AREA);
  return { mat: resized, scale };
}

/** Percentile of an 8 bit single channel Mat, via a 256 bin histogram. */
export function percentile8u(mat, percent) {
  const data = mat.data;
  const histogram = new Uint32Array(256);
  for (let index = 0; index < data.length; index += 1) histogram[data[index]] += 1;
  const target = (percent / 100) * data.length;
  let seen = 0;
  for (let value = 0; value < 256; value += 1) {
    seen += histogram[value];
    if (seen >= target) return value;
  }
  return 255;
}

export function median8u(mat) {
  return percentile8u(mat, 50);
}

/**
 * Percentile of a float Mat.  The values are bucketed between 0 and their
 * maximum, which is precise enough for the edge strength normalisation.
 */
export function percentileFloat(mat, percent, buckets = 512) {
  const data = mat.data32F;
  let maximum = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] > maximum) maximum = data[index];
  }
  if (maximum <= 0) return 0;
  const histogram = new Uint32Array(buckets);
  const scale = (buckets - 1) / maximum;
  for (let index = 0; index < data.length; index += 1) {
    histogram[Math.round(data[index] * scale)] += 1;
  }
  const target = (percent / 100) * data.length;
  let seen = 0;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    seen += histogram[bucket];
    if (seen >= target) return bucket / scale;
  }
  return maximum;
}

/** Apply a 256 entry lookup table to an 8 bit Mat in place of a new one. */
export function applyLut(source, table) {
  const cv = window.cv;
  return withMats((keep) => {
    const lut = keep(cv.matFromArray(1, 256, cv.CV_8UC1, table));
    const destination = new cv.Mat();
    cv.LUT(source, lut, destination);
    return destination;
  });
}

/** Odd integer, at least `minimum` - kernel sizes must be odd. */
export function odd(value, minimum = 3) {
  let result = Math.round(value);
  if (result % 2 === 0) result += 1;
  return Math.max(minimum, result);
}

/** Split a Mat into its channels; the caller owns the returned Mats. */
export function splitChannels(source) {
  const cv = window.cv;
  const vector = new cv.MatVector();
  cv.split(source, vector);
  const channels = [];
  for (let index = 0; index < vector.size(); index += 1) channels.push(vector.get(index));
  vector.delete();
  return channels;
}

/** Merge channels into a new Mat; the inputs stay owned by the caller. */
export function mergeChannels(channels) {
  const cv = window.cv;
  const vector = new cv.MatVector();
  channels.forEach((channel) => vector.push_back(channel));
  const merged = new cv.Mat();
  cv.merge(vector, merged);
  vector.delete();
  return merged;
}
