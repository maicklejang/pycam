"""Rendering of synthetic document photos used by the tests.

A page is rendered, projected into a virtual camera with a known pose and
pasted onto a background.  That gives the tests photos with exactly known
page corners, so detection and rectification can be checked numerically.
"""

import numpy as np

import cv2

BACKGROUNDS = ("wood", "dark", "light", "cloth")


def render_page(width=620, ratio=210.0 / 297.0, lines=14, seed=0):
    """Render a sheet of paper with a few lines of "text"."""
    generator = np.random.default_rng(seed)
    height = int(round(width / ratio))
    page = np.full((height, width, 3), 250, np.uint8)
    for index in range(lines):
        position = 40 + index * int((height - 80) / lines)
        end = width - 40 - int(generator.integers(0, width // 4))
        cv2.line(page, (40, position), (end, position), (40, 40, 40), 3)
    return page


def render_background(kind, size, seed=0):
    generator = np.random.default_rng(seed + 11)
    height, width = size
    if kind == "wood":
        image = np.full((height, width, 3), (60, 90, 130), np.uint8)
        image = cv2.add(image, generator.integers(0, 35, (height, width, 3),
                                                  dtype=np.int16).astype(np.uint8))
        for row in range(0, height, 23):
            cv2.line(image, (0, row), (width, row), (45, 70, 110), 2)
        return image
    if kind == "dark":
        return np.full((height, width, 3), (25, 25, 28), np.uint8)
    if kind == "cloth":
        image = np.full((height, width, 3), (110, 120, 140), np.uint8)
        return cv2.add(image, generator.integers(0, 60, (height, width, 3),
                                                 dtype=np.int16).astype(np.uint8))
    return np.full((height, width, 3), (200, 200, 205), np.uint8)


def project_quad(ratio, rotation, distance, focal, size):
    """Return the image corners of a rectangle seen by a virtual camera."""
    height, width = size
    camera = np.array([[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1.0]])
    corners = np.array([[-ratio / 2, -0.5, 0], [ratio / 2, -0.5, 0],
                        [ratio / 2, 0.5, 0], [-ratio / 2, 0.5, 0]], dtype=float)
    projected, _ = cv2.projectPoints(corners, np.asarray(rotation, dtype=float),
                                     np.array([0.0, 0.0, distance]), camera, None)
    return projected.reshape(-1, 2).astype(np.float32)


def photograph(background="wood", rotation=(0.35, 0.4, 0.12), distance=1.7, focal=900.0,
               size=(720, 1280), ratio=210.0 / 297.0, lighting=0.0, noise=0.0, seed=0):
    """Return (photo, true page corners) of a synthetic document photo."""
    page = render_page(ratio=ratio, seed=seed)
    image = render_background(background, size, seed=seed)
    quad = project_quad(ratio, rotation, distance, focal, size)
    page_height, page_width = page.shape[:2]
    source = np.array([[0, 0], [page_width - 1, 0], [page_width - 1, page_height - 1],
                       [0, page_height - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(source, quad)
    warped = cv2.warpPerspective(page, matrix, (size[1], size[0]))
    mask = cv2.warpPerspective(np.full((page_height, page_width), 255, np.uint8),
                               matrix, (size[1], size[0]))
    image[mask > 0] = warped[mask > 0]
    if lighting:
        rows, columns = np.mgrid[0:size[0], 0:size[1]]
        falloff = np.exp(-(((columns - size[1] * 0.3) ** 2 + (rows - size[0] * 0.2) ** 2)
                           / (0.35 * size[1] ** 2)))
        shade = ((1.0 - lighting) + lighting * falloff).astype(np.float32)
        image = np.clip(image.astype(np.float32) * shade[..., None], 0, 255).astype(np.uint8)
    image = cv2.GaussianBlur(image, (3, 3), 0)
    if noise:
        generator = np.random.default_rng(seed + 5)
        image = np.clip(image.astype(np.float32)
                        + generator.normal(0, noise, image.shape), 0, 255).astype(np.uint8)
    return image, quad


def render_curved_photo(page=None, arc=0.9, page_width=1.0, page_height=1.4,
                        rotation=(0.25, 0.30, 0.08), distance=3.2, focal=1500.0,
                        size=(1080, 1920), background="wood", seed=0, radius=None,
                        with_truth=False):
    """Photograph a page that is curled around a cylinder.

    Unlike :func:`photograph`, which pastes a flat sheet, this renders the page
    by intersecting every camera ray with the cylinder, so the result has the
    bowed text lines and the bulging border of a real curled page.  ``arc`` is
    how far the sheet is wrapped, in radians; the radius follows from it so
    that the sheet keeps the same width, which makes a nearly flat page
    (``arc`` close to zero) comparable with a curled one.  The true page
    corners are returned as well.
    """
    height, width = size
    arc = max(float(arc), 1e-4)
    if radius is None:
        radius = page_width / (2.0 * np.sin(arc / 2.0))
    centre_x, centre_y = width / 2.0, height / 2.0
    rotation_matrix = cv2.Rodrigues(np.asarray(rotation, dtype=np.float64))[0]
    translation = np.array([0.0, 0.0, distance], dtype=np.float64)
    if page is None:
        page = render_page(width=1240, lines=26, seed=seed)

    rows, columns = np.mgrid[0:height, 0:width].astype(np.float64)
    rays = np.stack([(columns - centre_x) / focal, (rows - centre_y) / focal,
                     np.ones_like(columns)], axis=-1)
    direction = rays @ rotation_matrix                    # rotation^T applied to each ray
    offset = -(rotation_matrix.T @ translation)

    a = direction[..., 0] ** 2 + direction[..., 2] ** 2
    b = 2 * (direction[..., 0] * offset[0] + direction[..., 2] * (offset[2] - radius))
    c = offset[0] ** 2 + (offset[2] - radius) ** 2 - radius ** 2
    discriminant = b * b - 4 * a * c
    usable = discriminant >= 0
    root = np.sqrt(np.where(usable, discriminant, 0.0))
    near = (-b - root) / (2 * a)
    far = (-b + root) / (2 * a)
    distance_along = np.where(near > 0, near, far)
    usable &= distance_along > 0

    surface = direction * distance_along[..., None] + offset
    angle = np.arctan2(surface[..., 0], radius - surface[..., 2])
    across = angle / arc + 0.5
    down = surface[..., 1] / page_height + 0.5
    usable &= (across >= 0) & (across <= 1) & (down >= 0) & (down <= 1)

    page_height_px, page_width_px = page.shape[:2]
    map_x = np.clip(across * (page_width_px - 1), 0, page_width_px - 1).astype(np.float32)
    map_y = np.clip(down * (page_height_px - 1), 0, page_height_px - 1).astype(np.float32)
    warped = cv2.remap(page, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    image = render_background(background, size, seed=seed)
    image[usable] = warped[usable]

    def project(across_value, down_value):
        theta = (across_value - 0.5) * arc
        point = np.array([radius * np.sin(theta), (down_value - 0.5) * page_height,
                          radius * (1 - np.cos(theta))])
        camera = rotation_matrix @ point + translation
        return [focal * camera[0] / camera[2] + centre_x,
                focal * camera[1] / camera[2] + centre_y]

    corners = np.array([project(0, 0), project(1, 0), project(1, 1), project(0, 1)])
    if not with_truth:
        return image, corners
    truth = {"across": across, "down": down, "usable": usable,
             "ratio": page_height / page_width}
    return image, corners, truth


def flatness(map_x, map_y, truth, step=8):
    """How much warp a flattening left behind, in per cent of the page width.

    ``truth`` comes from :func:`render_curved_photo`: for every photo pixel it
    holds the point of the page that is shown there.  Reading it through a
    flattening's sampling maps therefore gives the page coordinate of every
    output pixel, and a perfect result makes that an affine function of the
    output pixel - so what is left over after the best affine fit is exactly
    the warp that survived.

    ``across`` is the error along the page width, ``down`` along its height;
    both are scaled to the page width so that they can be compared.
    """
    height, width = map_x.shape[:2]
    rows, columns = np.mgrid[0:height:step, 0:width:step]
    sample_x = np.ascontiguousarray(map_x[::step, ::step], dtype=np.float32)
    sample_y = np.ascontiguousarray(map_y[::step, ::step], dtype=np.float32)

    def read(plane):
        return cv2.remap(plane.astype(np.float32), sample_x, sample_y,
                         cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    across, down = read(truth["across"]), read(truth["down"])
    # ignore anything that is not the page, and the last per cent at its rim
    usable = ((read(truth["usable"].astype(np.float32)) > 0.99)
              & (across > 0.02) & (across < 0.98) & (down > 0.02) & (down < 0.98))
    if np.count_nonzero(usable) < 200:
        return None
    design = np.stack([columns[usable] / width, rows[usable] / height,
                       np.ones(np.count_nonzero(usable))], axis=-1)
    result = {"samples": int(np.count_nonzero(usable))}
    for name, target, scale in (("across", across[usable], 1.0),
                                ("down", down[usable], truth["ratio"])):
        fit = np.linalg.lstsq(design, target, rcond=None)[0]
        error = np.abs(target - design @ fit) * scale * 100.0
        result[name] = float(np.sqrt(np.mean(error ** 2)))
        result[name + "_max"] = float(np.max(error))
    result["worst"] = max(result["across"], result["down"])
    return result
