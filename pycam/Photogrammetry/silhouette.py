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

Photos of a real object need a bit more care than the synthetic ones of the demo: the exposure
drifts between the shots, the object casts a shadow onto the turntable and the paper in the
background is never lit evenly.  Every method below therefore

  * matches the brightness of the reference photo to the current one before comparing them,
  * suppresses shadows (they darken the background without changing its color),
  * measures the color difference in a way that does not depend on the brightness, and
  * picks the region that belongs to the object instead of simply the biggest one.

All morphological helpers below work on plain numpy arrays.  OpenCV and scipy are used when
they are available, since they are considerably faster for big images.
"""

import numpy as np

from pycam.Photogrammetry.images import to_gray

MASK_METHODS = ("auto", "background", "chroma", "threshold")

# silhouettes below this rating (see "score_mask") are treated as doubtful
DOUBTFUL_SCORE = 0.55


class SilhouetteConfig:
    """ the parameters of the silhouette extraction """

    def __init__(self, method="auto", threshold=None, open_radius=2, close_radius=3,
                 fill_holes=True, keep_largest=True, min_area_fraction=0.0005,
                 border_width=8, invert=False, shadow_tolerance=0.18, match_exposure=True,
                 denoise_radius=1, prefer_center=True, refine_edges="auto"):
        """ @param shadow_tolerance: how much a shadow may change the color of the background
            (0 disables the shadow removal)
        @param match_exposure: compensate the exposure difference between a photo and the
            reference photo of the empty turntable
        @param denoise_radius: size of the averaging window that hides the sensor noise
        @param prefer_center: keep the region in the middle of the photo instead of the
            biggest one (the object is what the camera is aimed at)
        @param refine_edges: follow the real edges of the object with GrabCut (needs OpenCV).
            "auto" applies it only to the photos whose silhouette looks doubtful, which keeps
            the dimensions of a clean capture untouched.
        """
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
        self.shadow_tolerance = float(shadow_tolerance)
        self.match_exposure = bool(match_exposure)
        self.denoise_radius = int(denoise_radius)
        self.prefer_center = bool(prefer_center)
        self.refine_edges = refine_edges if refine_edges == "auto" else bool(refine_edges)

    def as_dict(self):
        return {"method": self.method, "threshold": self.threshold,
                "open_radius": self.open_radius, "close_radius": self.close_radius,
                "fill_holes": self.fill_holes, "keep_largest": self.keep_largest,
                "min_area_fraction": self.min_area_fraction, "border_width": self.border_width,
                "invert": self.invert, "shadow_tolerance": self.shadow_tolerance,
                "match_exposure": self.match_exposure, "denoise_radius": self.denoise_radius,
                "prefer_center": self.prefer_center, "refine_edges": self.refine_edges}

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


def _box_blur(values, radius=1):
    """ average an array over a square window - a cheap way of hiding the sensor noise """
    if radius < 1:
        return np.asarray(values, dtype=np.float32)
    values = np.asarray(values, dtype=np.float32)
    padded = np.pad(values, radius, mode="edge")
    sums = np.pad(padded.cumsum(axis=0).cumsum(axis=1), ((1, 0), (1, 0)), mode="constant")
    size = 2 * radius + 1
    total = (sums[size:, size:] - sums[:-size, size:]
             - sums[size:, :-size] + sums[:-size, :-size])
    return total / float(size * size)


def component_properties(mask):
    """ describe every connected region of a mask

    @returns: a tuple of the label array and a list of dictionaries (one per region, ordered
        by their label) containing the area, the centroid and the bounding box
    """
    labels, count = label_components(mask)
    if count < 1:
        return labels, []
    flat = labels.reshape(-1)
    areas = np.bincount(flat, minlength=count + 1).astype(float)
    rows = np.repeat(np.arange(mask.shape[0], dtype=float), mask.shape[1])
    columns = np.tile(np.arange(mask.shape[1], dtype=float), mask.shape[0])
    row_sums = np.bincount(flat, weights=rows, minlength=count + 1)
    column_sums = np.bincount(flat, weights=columns, minlength=count + 1)
    properties = []
    for label in range(1, count + 1):
        area = areas[label]
        if area <= 0:
            properties.append({"label": label, "area": 0.0, "centroid": (0.0, 0.0)})
            continue
        properties.append({"label": label, "area": area,
                           "centroid": (row_sums[label] / area, column_sums[label] / area)})
    return labels, properties


def select_object_component(mask, prefer_center=True):
    """ keep the single region that looks like the object

    The biggest region is not always the right one: a shadow on the turntable, a bright window
    in the background or the edge of the paper can easily cover more pixels than the object
    itself.  The camera however is aimed at the object, so regions in the middle of the photo
    are much more likely to be the wanted one.
    """
    if not mask.any():
        return mask
    if not prefer_center:
        return keep_largest_component(mask)
    labels, properties = component_properties(mask)
    if len(properties) <= 1:
        return mask
    center = (mask.shape[0] / 2.0, mask.shape[1] / 2.0)
    # half of the diagonal - the distance of a corner from the middle of the photo
    reach = float(np.hypot(*center))
    best_score, best_label = -1.0, properties[0]["label"]
    for item in properties:
        distance = np.hypot(item["centroid"][0] - center[0], item["centroid"][1] - center[1])
        # a region in the middle counts fully, one in a corner only by about a tenth
        weight = float(np.exp(-0.5 * (distance / (0.45 * reach)) ** 2))
        score = item["area"] * weight
        if score > best_score:
            best_score, best_label = score, item["label"]
    return labels == best_label


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
    """ estimate the background color from the border of a photo

    The median of every border strip is taken separately and the median of those four values
    is returned.  A single strip that is covered by the object - or by a dark table edge -
    therefore cannot spoil the estimate.
    """
    image = np.asarray(image)
    if image.ndim == 2:
        image = image[:, :, None]
    width = max(int(border_width), 1)
    channels = image.shape[2]
    strips = (image[:width], image[-width:], image[:, :width], image[:, -width:])
    medians = [np.median(strip.reshape(-1, channels), axis=0) for strip in strips]
    result = np.median(np.stack(medians, axis=0), axis=0)
    return result if channels > 1 else result.reshape(())


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


def _as_color_volume(reference, shape):
    """ turn a single color or a reference photo into an array matching the given photo """
    reference = np.asarray(reference, dtype=np.float32)
    if reference.ndim == 1:
        return np.broadcast_to(reference.reshape(1, 1, -1), shape)
    return reference


def exposure_gain(image, background, border_width=8, limit=2.0):
    """ return the per channel factor that maps the reference photo onto the current photo

    Hardly any camera keeps its exposure and its white balance perfectly constant over a
    series of photos.  Comparing the border of the two photos - which shows the background in
    both of them - reveals that drift, and compensating it avoids a "silhouette" that covers
    the whole photo.
    """
    current = np.median(border_pixels(image, border_width).astype(np.float32), axis=0)
    reference = np.median(border_pixels(background, border_width).astype(np.float32), axis=0)
    gain = np.ones(current.shape, dtype=np.float32)
    usable = reference > 1.0
    gain[usable] = current[usable] / reference[usable]
    return np.clip(gain, 1.0 / limit, limit)


def shadow_pixels(image, background, tolerance=0.18):
    """ mark the pixels that are merely a shadow of the object on the background

    A shadow scales all three color channels by roughly the same factor, while a real object
    changes the color itself.  Without this test the shadow ends up in the silhouette and the
    model grows a skirt around its base.
    """
    if tolerance <= 0:
        return np.zeros(np.asarray(image).shape[:2], dtype=bool)
    image = np.asarray(image, dtype=np.float32)
    background = _as_color_volume(background, image.shape)
    ratio = image / np.maximum(background, 8.0)
    lowest = ratio.min(axis=2)
    highest = ratio.max(axis=2)
    # darker than the background, but not black, and without a change of the color
    return (highest <= 0.97) & (lowest >= 0.25) & ((highest - lowest) <= tolerance)


def color_distance(image, reference, brightness_weight=0.35):
    """ return the per pixel distance between a photo and a color (or a reference photo)

    The distance is dominated by the *color* difference, which barely changes when a part of
    the scene lies in the shade.  The brightness difference is added with a small weight, so
    that a gray object in front of gray paper is still found.
    """
    image = np.asarray(image, dtype=np.float32)
    if image.ndim == 2:
        reference = np.asarray(reference, dtype=np.float32)
        return np.abs(image - reference.reshape(()))
    reference = _as_color_volume(reference, image.shape)
    image_total = image.sum(axis=2, keepdims=True) + 1.0
    reference_total = reference.sum(axis=2, keepdims=True) + 1.0
    chroma = np.abs(image / image_total - reference / reference_total).sum(axis=2) * 255.0
    brightness = np.abs(image.mean(axis=2) - reference.mean(axis=2))
    return chroma + brightness_weight * brightness


def _threshold_for(distance, threshold, floor=10.0):
    if threshold is not None:
        return float(threshold)
    # never trust a threshold below a typical amount of sensor noise
    return max(otsu_threshold(np.clip(distance, 0, 255)), floor)


def _mask_from_background(image, background, config):
    image = np.asarray(image, dtype=np.float32)
    background = np.asarray(background, dtype=np.float32)
    if config.match_exposure:
        background = background * exposure_gain(image, background, config.border_width)
    difference = np.abs(image - background)
    distance = difference.max(axis=2) if difference.ndim == 3 else difference
    distance = _box_blur(distance, config.denoise_radius)
    mask = distance > _threshold_for(distance, config.threshold, 10.0)
    if image.ndim == 3:
        mask &= ~shadow_pixels(image, background, config.shadow_tolerance)
    return mask


def _mask_from_chroma(image, config):
    reference = background_color(image, config.border_width)
    distance = _box_blur(color_distance(image, reference), config.denoise_radius)
    mask = distance > _threshold_for(distance, config.threshold, 8.0)
    if np.asarray(image).ndim == 3:
        mask &= ~shadow_pixels(image, reference, config.shadow_tolerance)
    return mask


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


def refine_mask_edges(image, mask, iterations=3, working_size=360):
    """ move the outline of a mask onto the real edges of the object (needs OpenCV)

    The color models of GrabCut are seeded with the mask that one of the methods above
    produced: its inner part is taken as object, everything well outside of it as background
    and the strip in between is decided by GrabCut.  This recovers thin details and removes
    the halo that the morphological cleanup leaves behind.
    """
    cv2 = _get_opencv()
    if (cv2 is None) or (not mask.any()) or mask.all():
        return mask
    image = np.asarray(image)
    if image.ndim != 3:
        return mask
    height, width = mask.shape
    scale = min(1.0, float(working_size) / max(height, width))
    if scale < 1.0:
        size = (max(int(round(width * scale)), 16), max(int(round(height * scale)), 16))
        small_image = cv2.resize(image, size, interpolation=cv2.INTER_AREA)
        small_mask = cv2.resize(mask.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST) > 0
    else:
        small_image, small_mask = image, mask
    # the width of the strip that GrabCut is allowed to decide about
    margin = max(int(round(0.02 * max(small_mask.shape))), 2)
    inner = erode(small_mask, margin)
    outer = dilate(small_mask, 2 * margin)
    if not inner.any():
        # a thin object would vanish completely - keep its core as a certainty
        inner = small_mask
    trimap = np.full(small_mask.shape, cv2.GC_PR_BGD, dtype=np.uint8)
    trimap[small_mask] = cv2.GC_PR_FGD
    trimap[inner] = cv2.GC_FGD
    trimap[~outer] = cv2.GC_BGD
    if not (trimap == cv2.GC_BGD).any():
        return mask
    try:
        cv2.grabCut(np.ascontiguousarray(small_image[:, :, ::-1]), trimap, None,
                    np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64),
                    max(int(iterations), 1), cv2.GC_INIT_WITH_MASK)
    except cv2.error:
        # GrabCut refuses to work on degenerate color distributions - keep what we have
        return mask
    refined = (trimap == cv2.GC_FGD) | (trimap == cv2.GC_PR_FGD)
    if not refined.any():
        return mask
    if scale < 1.0:
        refined = cv2.resize(refined.astype(np.uint8), (width, height),
                             interpolation=cv2.INTER_NEAREST) > 0
    return refined


def extract_mask(image, background=None, config=None, method=None):
    """ reduce a photo to the silhouette of the object

    @param image: an RGB array of bytes
    @param background: an optional reference photo of the scene without the object
    @param config: an optional SilhouetteConfig
    @param method: overrides the method of the configuration (used by the automatic choice)
    @returns: a boolean array - True marks the object
    """
    config = config or SilhouetteConfig()
    image = np.asarray(image)
    method = method or config.method
    if method == "auto":
        method = "background" if background is not None else "chroma"
    if (method == "background") and (background is None):
        raise ValueError("the 'background' method requires a reference photo of the empty scene")
    if method == "background":
        background = np.asarray(background)
        if background.shape != image.shape:
            raise ValueError("the reference photo ({}) does not match the photo ({})"
                             .format(background.shape, image.shape))
        mask = _mask_from_background(image, background, config)
    elif method == "chroma":
        mask = _mask_from_chroma(image, config)
    else:
        mask = _mask_from_threshold(image, config.threshold, config.border_width)
    if config.invert:
        mask = ~mask
    mask = clean_mask(mask, config)
    if config.refine_edges and mask.any():
        # a clean capture is left alone: following the edges costs a little accuracy, which is
        # only worth it when the silhouette does not look like a plausible object yet
        if (config.refine_edges != "auto") or (score_mask(mask) < DOUBTFUL_SCORE):
            mask = clean_mask(refine_mask_edges(image, mask), config)
    return mask


def clean_mask(mask, config=None):
    """ remove speckles and holes from a raw mask """
    config = config or SilhouetteConfig()
    if config.open_radius > 0:
        mask = open_mask(mask, config.open_radius)
    if config.close_radius > 0:
        mask = close_mask(mask, config.close_radius)
    if config.keep_largest:
        mask = select_object_component(mask, config.prefer_center)
    if config.fill_holes:
        mask = fill_holes(mask)
    if config.min_area_fraction > 0:
        if mask.sum() < config.min_area_fraction * mask.size:
            mask = np.zeros_like(mask)
    return mask


def score_mask(mask):
    """ rate how much a silhouette looks like the object of a turntable scan (0 .. 1)

    This is what makes the automatic choice of the method possible: every method is tried on a
    few photos and the one with the most plausible silhouettes wins.
    """
    quality = mask_quality(mask)
    area = quality["area_fraction"]
    if area <= 0:
        return 0.0
    # an object that is framed reasonably covers somewhere around a tenth of the photo
    score = float(np.exp(-0.5 * (np.log(area / 0.12) / 1.1) ** 2))
    # a real object fills a good part of its own bounding box, noise does not
    score *= min(1.0, quality["fill_ratio"] / 0.45)
    # and it sits where the camera is aimed at
    score *= max(0.15, 1.0 - quality["center_offset"])
    if quality["touches_border"]:
        score *= 0.55
    return float(score)


def choose_method(images, background=None, config=None):
    """ pick the silhouette method that works best for a set of photos

    @param images: a few representative photos of the session
    @param background: an optional reference photo of the empty turntable
    @returns: a tuple of the chosen method name and a dictionary of all scores
    """
    config = config or SilhouetteConfig()
    if config.method != "auto":
        return config.method, {}
    candidates = ["chroma", "threshold"]
    if background is not None:
        candidates.insert(0, "background")
    # the automatic choice only compares the methods - the expensive refinement is applied
    # to the winner afterwards
    trial = SilhouetteConfig.from_dict(dict(config.as_dict(), method="auto",
                                            refine_edges=False))
    scores = {}
    for name in candidates:
        values = []
        for image in images:
            try:
                values.append(score_mask(extract_mask(image, background=background,
                                                      config=trial, method=name)))
            except ValueError:
                values.append(0.0)
        scores[name] = float(np.mean(values)) if values else 0.0
    best = max(scores, key=lambda name: scores[name])
    # a reference photo is so much more reliable than the alternatives that it only loses
    # when it clearly fails (an object of the same color as the turntable, for example)
    if (background is not None) and (scores.get("background", 0.0) >= 0.7 * scores[best]):
        best = "background"
    return best, scores


def mask_quality(mask):
    """ return a few numbers that describe how plausible a silhouette looks """
    area = float(mask.sum())
    rows = np.nonzero(mask.any(axis=1))[0]
    columns = np.nonzero(mask.any(axis=0))[0]
    touches_border = bool(mask[0].any() or mask[-1].any() or mask[:, 0].any()
                          or mask[:, -1].any())
    fill_ratio = 0.0
    center_offset = 1.0
    if area > 0:
        box = float(len(rows) * len(columns))
        fill_ratio = area / box if box > 0 else 0.0
        center = (mask.shape[0] / 2.0, mask.shape[1] / 2.0)
        centroid = ((rows[0] + rows[-1] + 1) / 2.0, (columns[0] + columns[-1] + 1) / 2.0)
        distance = np.hypot(centroid[0] - center[0], centroid[1] - center[1])
        center_offset = float(min(distance / np.hypot(*center), 1.0))
    return {"area_fraction": area / mask.size,
            "height_fraction": (len(rows) / mask.shape[0]) if len(rows) else 0.0,
            "width_fraction": (len(columns) / mask.shape[1]) if len(columns) else 0.0,
            "fill_ratio": fill_ratio,
            "center_offset": center_offset,
            "touches_border": touches_border}
