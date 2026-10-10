"""Making a flat page look photographed: tilt, perspective, crumples, shadow, blur, noise, and a phone's file.

A page rendered flat is put on a desk, turned, pulled out of square, bent by a smooth wave (a crumpled
sheet), shaded, darkened, blurred, covered in sensor noise, scaled down and saved as a JPEG, a PNG or a
WebP, sometimes stored sideways with an EXIF orientation and a GPS position, as a phone does. Every
geometric step is a function of position, so the boxes of the printed fields are carried through exactly:
the ground truth of a photograph is as exact as that of a PDF.

The effects are seeded: the same recipe gives the same photograph on the same library versions. Across
platforms the pixels may differ in the last bit of a float, which is why the seed check compares photographs
with a tolerance and PDFs byte for byte (lb03/synthetic/build.py). This is development tooling.
"""

import io
import math
from typing import Any

import cv2
import numpy as np
from numpy.typing import NDArray
from PIL import Image

from lb03.golden import PhotoEffects

# OpenCV hands back arrays whose element types a type checker can't follow, so they are all just arrays here.
type Array = NDArray[Any]
type Pixels = Array
type Points = Array

DESK = np.array([118.0, 98.0, 80.0], dtype=np.float32)
# How far the desk shows round the page, as a share of the page's long side.
MARGIN_SHARE = 0.07
# The EXIF tags written: orientation, and the GPS block with a position in Brno.
EXIF_ORIENTATION = 0x0112
EXIF_GPS = 0x8825
GPS_POSITION = {1: "N", 2: (49.0, 11.0, 38.0), 3: "E", 4: (16.0, 36.0, 25.0)}


def smooth_field(rng: np.random.Generator, width: int, height: int, cells: tuple[int, int] = (5, 7)) -> Array:
    """Make a smooth random surface from -1 to 1: a small grid of random numbers stretched to the image's size."""
    grid = rng.uniform(-1.0, 1.0, (cells[1], cells[0])).astype(np.float32)
    return cv2.resize(grid, (width, height), interpolation=cv2.INTER_CUBIC)


def desk_texture(width: int, height: int, rng: np.random.Generator) -> Array:
    """Make the desk the page lies on: a brown with a slow variation and a grain."""
    variation = 1.0 + 0.08 * smooth_field(rng, width, height, (4, 4))
    grain = rng.normal(0.0, 4.0, (height, width, 1)).astype(np.float32)
    return DESK[None, None, :] * variation[..., None] + grain


def homography(width: int, height: int, effects: PhotoEffects, rng: np.random.Generator) -> Array:
    """Make the transform that turns the canvas by the recipe's angle and pulls its corners out of square."""
    centre = np.array([width / 2, height / 2])
    corners = np.array([[0, 0], [width, 0], [width, height], [0, height]], dtype=np.float64)
    angle = math.radians(effects.rotation_degrees)
    rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
    turned = (corners - centre) @ rotation.T + centre
    pull = rng.uniform(0.0, effects.perspective, (4, 2)) * np.array([width, height])
    pulled = turned + (centre - turned) / np.maximum(np.abs(centre - turned), 1.0) * pull
    return cv2.getPerspectiveTransform(corners.astype(np.float32), pulled.astype(np.float32)).astype(np.float64)


def sample(field: Array, points: Points) -> Array:
    """Read a field at fractional positions by bilinear interpolation."""
    height, width = field.shape
    x = np.clip(points[:, 0], 0, width - 1.001)
    y = np.clip(points[:, 1], 0, height - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    top = field[y0, x0] * (1 - fx) + field[y0, x0 + 1] * fx
    bottom = field[y0 + 1, x0] * (1 - fx) + field[y0 + 1, x0 + 1] * fx
    return np.asarray((top * (1 - fy) + bottom * fy), dtype=np.float32)


def crumple(image: Array, quads: list[Points], amount: float, rng: np.random.Generator) -> tuple[Array, list[Points]]:
    """Bend the picture by a smooth wave and light the bends, and move the boxes with it.

    The picture is sampled at `x + wave(x)`, so a printed point `p` appears where `x + wave(x) = p`, which is
    found by iterating `x = p - wave(x)`: the wave is gentle, so a handful of steps are exact to a fraction of a pixel.
    """
    height, width = image.shape[:2]
    strength = amount * 0.012 * max(width, height)
    wave_x = strength * smooth_field(rng, width, height)
    wave_y = strength * smooth_field(rng, width, height)
    grid_x, grid_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    bent = cv2.remap(image, grid_x + wave_x, grid_y + wave_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    relief = cv2.GaussianBlur(strength * smooth_field(rng, width, height, (9, 12)), (0, 0), 3)
    light = 1.0 + 0.5 * amount * cv2.Sobel(relief, cv2.CV_32F, 1, 0, ksize=3) / max(strength, 1.0)
    moved = []
    for quad in quads:
        position = quad.copy()
        for _ in range(6):
            position = quad - np.stack([sample(wave_x, position), sample(wave_y, position)], axis=1)
        moved.append(position)
    return bent * light[..., None], moved


def shade(image: Array, strength: float, rng: np.random.Generator) -> Array:
    """Darken one side of the picture with a soft shadow, as a hand or a lamp does."""
    height, width = image.shape[:2]
    angle = rng.uniform(0, 2 * math.pi)
    grid_x, grid_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    along = ((grid_x - width / 2) * math.cos(angle) + (grid_y - height / 2) * math.sin(angle)) / math.hypot(
        width, height
    )
    ramp = np.clip((along + 0.1) / 0.5, 0.0, 1.0)
    ramp = ramp * ramp * (3 - 2 * ramp)
    return np.asarray(image * (1.0 - strength * ramp)[..., None])


def photograph(page: Pixels, quads: list[Points], effects: PhotoEffects, seed: int) -> tuple[Pixels, list[Points]]:
    """Photograph a flat page: return the picture, and each of the page's quads where it ended up, in pixels."""
    rng = np.random.default_rng(np.random.PCG64(seed))
    height, width = page.shape[:2]
    margin = round(MARGIN_SHARE * max(width, height))
    canvas = desk_texture(width + 2 * margin, height + 2 * margin, rng)
    canvas[margin : margin + height, margin : margin + width] = page
    moved = [quad + margin for quad in quads]
    matrix = homography(canvas.shape[1], canvas.shape[0], effects, rng)
    canvas = cv2.warpPerspective(
        canvas, matrix, (canvas.shape[1], canvas.shape[0]), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
    )
    moved = [
        cv2.perspectiveTransform(quad.reshape(1, -1, 2), matrix).reshape(-1, 2).astype(np.float32) for quad in moved
    ]
    if effects.crumple > 0:
        canvas, moved = crumple(canvas, moved, effects.crumple, rng)
    if effects.shadow > 0:
        canvas = shade(canvas, effects.shadow, rng)
    canvas = canvas * effects.brightness
    if effects.blur_pixels > 0:
        canvas = cv2.GaussianBlur(canvas, (0, 0), effects.blur_pixels)
    if effects.noise > 0:
        canvas = (
            canvas
            + rng.normal(0.0, effects.noise, canvas.shape[:2])[..., None]
            + rng.normal(0.0, effects.noise / 2, canvas.shape)
        )
    scale = effects.long_side_pixels / max(canvas.shape[:2])
    size = (round(canvas.shape[1] * scale), round(canvas.shape[0] * scale))
    canvas = cv2.resize(canvas, size, interpolation=cv2.INTER_AREA)
    moved = [quad * scale for quad in moved]
    return np.clip(canvas, 0, 255).astype(np.uint8), moved


def stored_sideways(pixels: Pixels, orientation: int) -> Pixels:
    """Turn an upright picture as a phone stores it for an EXIF orientation: 6 and 8 on their side, 3 upside down."""
    turns = {1: 0, 3: 2, 6: 1, 8: -1}[orientation]
    return np.ascontiguousarray(np.rot90(pixels, turns))


def encode(pixels: Pixels, effects: PhotoEffects) -> bytes:
    """Encode a picture as the recipe's file type, with its EXIF orientation and GPS position when it asks for them."""
    stored = stored_sideways(pixels, effects.exif_orientation)
    image = Image.fromarray(stored, "RGB")
    options: dict[str, object] = {}
    exif = Image.Exif()
    if effects.exif_orientation != 1:
        exif[EXIF_ORIENTATION] = effects.exif_orientation
    if effects.gps:
        exif[EXIF_GPS] = GPS_POSITION
    if len(exif) > 0:
        options["exif"] = exif.tobytes()
    buffer = io.BytesIO()
    if effects.format == "jpeg":
        image.save(buffer, "JPEG", quality=effects.jpeg_quality, **options)
    elif effects.format == "webp":
        image.save(buffer, "WEBP", quality=effects.jpeg_quality, method=4, **options)
    else:
        image.save(buffer, "PNG", compress_level=9)
    return buffer.getvalue()
