"""
Copyright 2026 PyCAM contributors

This file is part of PyCAM.

PyCAM is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

PyCAM is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with PyCAM.  If not, see <http://www.gnu.org/licenses/>.


Separation of the object from its background ("silhouette" or "mask" extraction).

The quality of the resulting 3D model depends almost entirely on this step.  Three methods are
available:

  * "background": compare every photo with a reference photo of the empty turntable
    (by far the most reliable approach - take that reference photo!)
  * "chroma": measure the color distance to the background color, which is sampled at the
    border of the photo (works well in front of an evenly colored sheet of paper)
  * "threshold": pick a brightness threshold automatically (Otsu's method)

All morphological helpers below work on plain numpy arrays.  OpenCV and scipy are used when
they are available, since they are considerably faster for big images.
"""

import numpy as np

from pycam.Photogrammetry.images import to_gray

MASK_METHODS = ("auto", "background", "chroma", "threshold")


class SilhouetteConfig:
    """ the parameters of the silhouette extraction """

    def __init__(self, method="auto", threshold=None, open_radius=2, close_radius=3,
                 fill_holes=True, keep_largest=True, min_area_fraction=0.0005,
                 border_width=8, invert=False):
        if method not in MASK_METHODS:
            raise ValueError("unknown silhouette method '{}' (expected one of {})"
                             .format(method, ", ".join(MASK_METHODS)))
        self.method = method
        self.threshold = threshold
        self.open_radius = int(open_radius)
        self.close_radius = int(close_radius)
        self.fill_holes = bool(fill_holes)
        self.keep_largest = bool(keep_largest)
        self.min_area_fraction = float(min_area_fraction)
        self.border_width = int(border_width)
        self.invert = bool(invert)

    def as_dict(self):
        return {"method": self.method, "threshold": self.threshold,
                "open_radius": self.open_radius, "close_radius": self.close_radius,
                "fill_holes": self.fill_holes, "keep_largest": self.keep_largest,
                "min_area_fraction": self.min_area_fraction, "border_width": self.border_width,
                "invert": self.invert}

    @classmethod
    def from_dict(cls, data):
        return cls(**{key: value for key, value in (data or {}).items()})


def _get_opencv():
    try:
        import cv2
    except ImportError:
        return None
    return cv2


def _get_ndimage():
    try:
        from scipy import ndimage
    except ImportError:
        return None
    return ndimage


def _shift_filter(mask, radius, mode):
    """ erode or dilate a mask with a square structuring element (pure numpy fallback) """
    result = mask
    # pixels outside of the image neither grow nor shrink the mask
    outside = (mode == "erode")
    for axis in (0, 1):
        for _ in range(radius):
            shifted_low = np.roll(result, 1, axis=axis)
            shifted_high = np.roll(result, -1, axis=axis)
            border_low = [slice(None)] * 2
            border_low[axis] = slice(0, 1)
            border_high = [slice(None)] * 2
            border_high[axis] = slice(-1, None)
            # the values that were wrapped around by "roll" have to be replaced
            shifted_low[tuple(border_low)] = outside
            shifted_high[tuple(border_high)] = outside
            if mode == "dilate":
                result = result | shifted_low | shifted_high
            else:
                result = result & shifted_low & shifted_high
    return result


def dilate(mask, radius=1):
    """ grow a mask by "radius" pixels """
    if radius < 1:
        return mask
    cv2 = _get_opencv()
    if cv2 is not None:
        kernel = np.ones((2 * radius + 1, 2 * radius + 1), np.uint8)
        return cv2.dilate(mask.astype(np.uint8), kernel) > 0
    ndimage = _get_ndimage()
    if ndimage is not None:
        return ndimage.binary_dilation(mask, np.ones((2 * radius + 1, 2 * radius + 1), bool))
    return _shift_filter(mask, radius, "dilate")


def erode(mask, radius=1):
    """ shrink a mask by "radius" pixels """
    if radius < 1:
        return mask
    cv2 = _get_opencv()
    if cv2 is not None:
        kernel = np.ones((2 * radius + 1, 2 * radius + 1), np.uint8)
        return cv2.erode(mask.astype(np.uint8), kernel) > 0
    ndimage = _get_ndimage()
    if ndimage is not None:
        return ndimage.binary_erosion(mask, np.ones((2 * radius + 1, 2 * radius + 1), bool))
    return _shift_filter(mask, radius, "erode")


def open_mask(mask, radius=1):
    """ remove speckles that are smaller than the given radius """
    return dilate(erode(mask, radius), radius)


def close_mask(mask, radius=1):
    """ close small gaps and cracks """
    return erode(dilate(mask, radius), radius)


def label_components(mask):
    """ assign a distinct label to every connected region of the mask (0 marks the background)

    @returns: a tuple of the label array and the number of labels
    """
    cv2 = _get_opencv()
    if cv2 is not None:
        count, labels = cv2.connectedComponents(mask.astype(np.uint8), connectivity=4)
        return labels, count - 1
    ndimage = _get_ndimage()
    if ndimage is not None:
        labels, count = ndimage.label(mask)
        return labels, count
    return _label_components_numpy(mask)


def _horizontal_runs(mask):
    """ return the horizontal runs of a mask as arrays of rows, start and end columns """
    padded = np.zeros((mask.shape[0], mask.shape[1] + 2), dtype=np.int8)
    padded[:, 1:-1] = mask
    changes = padded[:, 1:] - padded[:, :-1]
    starts = np.argwhere(changes > 0)
    ends = np.argwhere(changes < 0)
    return starts[:, 0], starts[:, 1], ends[:, 1]


def _label_components_numpy(mask):
    """ connected component labeling based on horizontal runs and a union-find structure

    This is the fallback for systems without OpenCV or scipy.  Working on runs instead of
    single pixels keeps it fast enough for photos of a few megapixels.
    """
    labels = np.zeros(mask.shape, dtype=np.int64)
    if not mask.any():
        return labels, 0
    rows, starts, ends = _horizontal_runs(mask)
    parents = list(range(len(rows)))

    def find(item):
        root = item
        while parents[root] != root:
            root = parents[root]
        while parents[item] != root:
            parents[item], item = root, parents[item]
        return root

    def union(first, second):
        root_a, root_b = find(first), find(second)
        if root_a != root_b:
            parents[max(root_a, root_b)] = min(root_a, root_b)

    # the runs are sorted by row - locate the first run of every row
    row_starts = np.searchsorted(rows, np.arange(mask.shape[0] + 1))
    for row in range(1, mask.shape[0]):
        above = range(row_starts[row - 1], row_starts[row])
        current = range(row_starts[row], row_starts[row + 1])
        previous_index = above.start
        for index in current:
            while (previous_index < above.stop) and (ends[previous_index] <= starts[index]):
                previous_index += 1
            neighbor = previous_index
            while (neighbor < above.stop) and (starts[neighbor] < ends[index]):
                union(index, neighbor)
                neighbor += 1
    roots = np.array([find(index) for index in range(len(rows))])
    unique_roots, compact = np.unique(roots, return_inverse=True)
    for index in range(len(rows)):
        labels[rows[index], starts[index]:ends[index]] = compact[index] + 1
    return labels, len(unique_roots)


def keep_largest_component(mask):
    """ drop everything but the biggest connected region """
    if not mask.any():
        return mask
    labels, count = label_components(mask)
    if count <= 1:
        return mask
    sizes = np.bincount(labels.reshape(-1))
    sizes[0] = 0
    return labels == int(np.argmax(sizes))


def fill_holes(mask):
    """ fill regions of background that are completely surrounded by the mask """
    if not mask.any():
        return mask
    background = ~mask
    # a border of background guarantees that the outer region is connected
    padded = np.pad(background, 1, mode="constant", constant_values=True)
    labels, _ = label_components(padded)
    outer_label = labels[0, 0]
    holes = (labels != outer_label)[1:-1, 1:-1] & background
    return mask | holes


def border_pixels(image, border_width=8):
    """ return all pixels along the border of an image (shape: N x channels) """
    image = np.asarray(image)
    if image.ndim == 2:
        image = image[:, :, None]
    width = max(int(border_width), 1)
    channels = image.shape[2]
    strips = (image[:width], image[-width:], image[:, :width], image[:, -width:])
    return np.concatenate([strip.reshape(-1, channels) for strip in strips], axis=0)


def background_color(image, border_width=8):
    """ estimate the background color from the border of a photo """
    return np.median(border_pixels(image, border_width), axis=0)


def otsu_threshold(gray):
    """ find the brightness threshold that separates the image into two classes """
    values = np.asarray(gray).reshape(-1)
    histogram = np.bincount(values.astype(np.uint8), minlength=256).astype(np.float64)
    total = histogram.sum()
    if total <= 0:
        return 128.0
    levels = np.arange(256, dtype=np.float64)
    weight_low = np.cumsum(histogram)
    weight_high = total - weight_low
    sum_low = np.cumsum(histogram * levels)
    sum_total = sum_low[-1]
    valid = (weight_low > 0) & (weight_high > 0)
    mean_low = np.zeros(256)
    mean_high = np.zeros(256)
    mean_low[valid] = sum_low[valid] / weight_low[valid]
    mean_high[valid] = (sum_total - sum_low[valid]) / weight_high[valid]
    variance = np.zeros(256)
    variance[valid] = (weight_low[valid] * weight_high[valid]
                       * (mean_low[valid] - mean_high[valid]) ** 2)
    return float(np.argmax(variance))


def _color_distance(image, reference):
    """ return the per pixel distance between an image and a single color """
    image = np.asarray(image, dtype=np.float32)
    reference = np.asarray(reference, dtype=np.float32)
    if image.ndim == 2:
        return np.abs(image - reference.reshape(()))
    return np.abs(image - reference.reshape(1, 1, -1)).max(axis=2)


def _mask_from_background(image, background, threshold):
    image = np.asarray(image, dtype=np.float32)
    background = np.asarray(background, dtype=np.float32)
    difference = np.abs(image - background)
    distance = difference.max(axis=2) if difference.ndim == 3 else difference
    if threshold is None:
        # never trust a threshold below a typical amount of sensor noise
        threshold = max(otsu_threshold(np.clip(distance, 0, 255)), 12.0)
    return distance > threshold


def _mask_from_chroma(image, threshold, border_width):
    distance = _color_distance(image, background_color(image, border_width))
    if threshold is None:
        threshold = max(otsu_threshold(np.clip(distance, 0, 255)), 12.0)
    return distance > threshold


def _mask_from_threshold(image, threshold, border_width):
    gray = to_gray(image)
    if threshold is None:
        threshold = otsu_threshold(gray)
    bright = gray > threshold
    # the object is whatever is *not* dominating the border of the photo
    border = np.zeros(gray.shape, dtype=bool)
    width = max(int(border_width), 1)
    border[:width] = True
    border[-width:] = True
    border[:, :width] = True
    border[:, -width:] = True
    if bright[border].mean() > 0.5:
        return ~bright
    return bright


def extract_mask(image, background=None, config=None):
    """ reduce a photo to the silhouette of the object

    @param image: an RGB array of bytes
    @param background: an optional reference photo of the scene without the object
    @param config: an optional SilhouetteConfig
    @returns: a boolean array - True marks the object
    """
    config = config or SilhouetteConfig()
    image = np.asarray(image)
    method = config.method
    if method == "auto":
        method = "background" if background is not None else "chroma"
    if (method == "background") and (background is None):
        raise ValueError("the 'background' method requires a reference photo of the empty scene")
    if method == "background":
        background = np.asarray(background)
        if background.shape != image.shape:
            raise ValueError("the reference photo ({}) does not match the photo ({})"
                             .format(background.shape, image.shape))
        mask = _mask_from_background(image, background, config.threshold)
    elif method == "chroma":
        mask = _mask_from_chroma(image, config.threshold, config.border_width)
    else:
        mask = _mask_from_threshold(image, config.threshold, config.border_width)
    if config.invert:
        mask = ~mask
    return clean_mask(mask, config)


def clean_mask(mask, config=None):
    """ remove speckles and holes from a raw mask """
    config = config or SilhouetteConfig()
    if config.open_radius > 0:
        mask = open_mask(mask, config.open_radius)
    if config.close_radius > 0:
        mask = close_mask(mask, config.close_radius)
    if config.keep_largest:
        mask = keep_largest_component(mask)
    if config.fill_holes:
        mask = fill_holes(mask)
    if config.min_area_fraction > 0:
        if mask.sum() < config.min_area_fraction * mask.size:
            mask = np.zeros_like(mask)
    return mask


def mask_quality(mask):
    """ return a few numbers that describe how plausible a silhouette looks """
    area = float(mask.sum())
    rows = np.nonzero(mask.any(axis=1))[0]
    columns = np.nonzero(mask.any(axis=0))[0]
    touches_border = bool(mask[0].any() or mask[-1].any() or mask[:, 0].any()
                          or mask[:, -1].any())
    return {"area_fraction": area / mask.size,
            "height_fraction": (len(rows) / mask.shape[0]) if len(rows) else 0.0,
            "width_fraction": (len(columns) / mask.shape[1]) if len(columns) else 0.0,
            "touches_border": touches_border}
