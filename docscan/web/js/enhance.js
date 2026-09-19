/* Image clean-up - a port of docscan/enhance.py.
 *
 * One deliberate difference: the illumination background is estimated on a
 * downscaled copy and scaled back up.  The background is low frequency by
 * definition, so the result is the same, but it avoids running a large median
 * filter over a full resolution photo, which is painfully slow in WebAssembly.
 */

import { withMats } from "./cv.js";
import { applyLut, mergeChannels, odd, percentile8u, splitChannels, toGray } from "./mat.js";

export const MODES = ["color", "magic", "gray", "bw", "none"];

export const MODE_LABELS = {
  color: "컬러",
  magic: "선명",
  gray: "회색",
  bw: "흑백",
  none: "원본",
};

export const MODE_DESCRIPTIONS = {
  color: "조명을 고르게 펴고 흰 배경을 살린 자연스러운 컬러",
  magic: "대비와 채도를 올린 스캐너 앱 느낌",
  gray: "회색조, 인쇄와 용량에 유리",
  bw: "순수 흑백, 글자 문서에 가장 작은 파일",
  none: "보정 없이 기울기만 보정",
};

const BACKGROUND_SIZE = 512;

/** Estimate the illumination of one channel by growing its bright areas. */
function backgroundOf(channel, kernelSize, blurSize) {
  const cv = window.cv;
  return withMats((keep) => {
    const kernel = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE,
                                                 new cv.Size(kernelSize, kernelSize)));
    const dilated = keep(new cv.Mat());
    cv.dilate(channel, dilated, kernel);
    const background = new cv.Mat();
    cv.medianBlur(dilated, background, blurSize);
    return background;
  });
}

/** Flatten uneven lighting by dividing the image by its own background. */
export function removeShadows(image, strength = 1) {
  const cv = window.cv;
  if (strength <= 0) return image.clone();
  const longest = Math.max(image.rows, image.cols);
  const scale = Math.min(1, BACKGROUND_SIZE / longest);
  const smallSize = new cv.Size(Math.max(16, Math.round(image.cols * scale)),
                                Math.max(16, Math.round(image.rows * scale)));
  const kernelSize = odd(Math.max(image.cols, image.rows) * scale * 0.012, 3);
  const blurSize = odd(Math.max(image.cols, image.rows) * scale * 0.02, 3);

  const channels = splitChannels(image);
  const flattened = [];
  try {
    for (const channel of channels) {
      flattened.push(withMats((keep) => {
        const small = keep(new cv.Mat());
        cv.resize(channel, small, smallSize, 0, 0, cv.INTER_AREA);
        const smallBackground = keep(backgroundOf(small, kernelSize, blurSize));
        const background = keep(new cv.Mat());
        cv.resize(smallBackground, background, new cv.Size(image.cols, image.rows),
                  0, 0, cv.INTER_LINEAR);
        const normalised = new cv.Mat();
        cv.divide(channel, background, normalised, 255);
        if (strength < 1) {
          const blended = new cv.Mat();
          cv.addWeighted(normalised, strength, channel, 1 - strength, 0, blended);
          normalised.delete();
          return blended;
        }
        return normalised;
      }));
    }
    return flattened.length === 1 ? flattened[0].clone() : mergeChannels(flattened);
  } finally {
    channels.forEach((channel) => channel.delete());
    if (flattened.length !== 1) flattened.forEach((channel) => channel.delete());
    else flattened[0].delete();
  }
}

/** Push the darkest and brightest percentiles to pure black and white. */
export function stretchLevels(image, lowPercentile = 1, highPercentile = 99) {
  const cv = window.cv;
  return withMats((keep) => {
    const reference = keep(toGray(image));
    const low = percentile8u(reference, lowPercentile);
    const high = percentile8u(reference, highPercentile);
    if (high - low < 1) return image.clone();
    const scale = 255 / (high - low);
    const result = new cv.Mat();
    image.convertTo(result, -1, scale, -low * scale);
    return result;
  });
}

/** Map near white pixels to pure white with a smooth lightness curve. */
export function whiten(image, whitePoint = 225) {
  const cv = window.cv;
  const point = Math.min(255, Math.max(32, Math.round(whitePoint)));
  const table = new Uint8Array(256);
  for (let value = 0; value < 256; value += 1) {
    table[value] = Math.min(255, Math.round((value * 255) / point));
  }
  if (image.channels() === 1) return applyLut(image, Array.from(table));
  return withMats((keep) => {
    const lab = keep(new cv.Mat());
    cv.cvtColor(image, lab, cv.COLOR_RGB2Lab);
    const channels = splitChannels(lab).map((channel) => keep(channel));
    const lightness = keep(applyLut(channels[0], Array.from(table)));
    const merged = keep(mergeChannels([lightness, channels[1], channels[2]]));
    const result = new cv.Mat();
    cv.cvtColor(merged, result, cv.COLOR_Lab2RGB);
    return result;
  });
}

export function unsharpMask(image, amount = 0.6, radius = 1.4) {
  const cv = window.cv;
  if (amount <= 0) return image.clone();
  return withMats((keep) => {
    const blurred = keep(new cv.Mat());
    cv.GaussianBlur(image, blurred, new cv.Size(0, 0), radius);
    const result = new cv.Mat();
    cv.addWeighted(image, 1 + amount, blurred, -amount, 0, result);
    return result;
  });
}

/** Scale each channel so that its bright pixels become neutral white. */
export function autoWhiteBalance(image, percent = 97) {
  const cv = window.cv;
  if (image.channels() < 3) return image.clone();
  const channels = splitChannels(image);
  const balanced = [];
  try {
    for (const channel of channels) {
      const reference = percentile8u(channel, percent);
      const gain = reference > 1 ? Math.min(255 / reference, 3) : 1;
      const scaled = new cv.Mat();
      channel.convertTo(scaled, -1, gain, 0);
      balanced.push(scaled);
    }
    return mergeChannels(balanced);
  } finally {
    channels.forEach((channel) => channel.delete());
    balanced.forEach((channel) => channel.delete());
  }
}

export function boostSaturation(image, factor = 1.15) {
  const cv = window.cv;
  if (image.channels() < 3 || factor === 1) return image.clone();
  return withMats((keep) => {
    const hsv = keep(new cv.Mat());
    cv.cvtColor(image, hsv, cv.COLOR_RGB2HSV);
    const channels = splitChannels(hsv).map((channel) => keep(channel));
    const saturation = keep(new cv.Mat());
    channels[1].convertTo(saturation, -1, factor, 0);
    const merged = keep(mergeChannels([channels[0], saturation, channels[2]]));
    const result = new cv.Mat();
    cv.cvtColor(merged, result, cv.COLOR_HSV2RGB);
    return result;
  });
}

/** CLAHE on the lightness channel only, so colours stay intact. */
export function localContrast(image, clipLimit = 2, tile = 8) {
  const cv = window.cv;
  const clahe = new cv.CLAHE(clipLimit, new cv.Size(tile, tile));
  try {
    if (image.channels() === 1) {
      const result = new cv.Mat();
      clahe.apply(image, result);
      return result;
    }
    return withMats((keep) => {
      const lab = keep(new cv.Mat());
      cv.cvtColor(image, lab, cv.COLOR_RGB2Lab);
      const channels = splitChannels(lab).map((channel) => keep(channel));
      const lightness = keep(new cv.Mat());
      clahe.apply(channels[0], lightness);
      const merged = keep(mergeChannels([lightness, channels[1], channels[2]]));
      const result = new cv.Mat();
      cv.cvtColor(merged, result, cv.COLOR_Lab2RGB);
      return result;
    });
  } finally {
    clahe.delete();
  }
}

export function toGrayscale(image, shadow = 1) {
  return withMats((keep) => {
    const gray = keep(toGray(image));
    const flattened = keep(removeShadows(gray, shadow));
    const stretched = keep(stretchLevels(flattened));
    return whiten(stretched, 235);
  });
}

/** Crisp bi-level page; the parameters match the measured optimum in Python. */
export function toBlackWhite(image, shadow = 1, offset = 10, blockRatio = 0.025) {
  const cv = window.cv;
  return withMats((keep) => {
    const gray = keep(toGray(image));
    const flattened = keep(removeShadows(gray, shadow));
    const blockSize = odd(Math.max(image.rows, image.cols) * blockRatio, 15);
    const binary = keep(new cv.Mat());
    cv.adaptiveThreshold(flattened, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                         cv.THRESH_BINARY, blockSize, offset);
    // remove the speckles the threshold leaves in empty areas
    const denoised = new cv.Mat();
    cv.medianBlur(binary, denoised, 3);
    return denoised;
  });
}

export function toMagicColour(image, shadow = 1) {
  return withMats((keep) => {
    const flattened = keep(removeShadows(image, shadow));
    const balanced = keep(autoWhiteBalance(flattened));
    const stretched = keep(stretchLevels(balanced, 2, 99.5));
    const contrasted = keep(localContrast(stretched, 1.3));
    const whitened = keep(whiten(contrasted, 225));
    const saturated = keep(boostSaturation(whitened, 1.2));
    return unsharpMask(saturated, 0.5);
  });
}

export function toColour(image, shadow = 1) {
  return withMats((keep) => {
    const flattened = keep(removeShadows(image, shadow));
    const balanced = keep(autoWhiteBalance(flattened, 98));
    const whitened = keep(whiten(balanced, 240));
    return unsharpMask(whitened, 0.3);
  });
}

/** Apply a colour mode to an already rectified page; returns a new Mat. */
export function enhance(image, mode = "color", shadow = 1) {
  if (!MODES.includes(mode)) throw new Error("unknown mode: " + mode);
  if (mode === "none") return image.clone();
  if (mode === "gray") return toGrayscale(image, shadow);
  if (mode === "bw") return toBlackWhite(image, shadow);
  if (mode === "magic") return toMagicColour(image, shadow);
  return toColour(image, shadow);
}
