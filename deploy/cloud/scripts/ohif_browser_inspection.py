"""Small safe helpers for inspecting a synthetic OHIF browser proof."""

from __future__ import annotations

import struct
import zlib
from playwright.sync_api import Error as PlaywrightError


class ProofError(RuntimeError):
    pass


def decode_chromium_png(data: bytes) -> tuple[int, int, int, bytes]:
    """Decode the non-interlaced 8-bit RGB(A) PNG emitted by Chromium screenshots."""
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ProofError("Chromium canvas screenshot was not a PNG.")
    offset = 8
    compressed = bytearray()
    width = height = color_type = bit_depth = 0
    while offset < len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        offset += length + 12
        if kind == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            if bit_depth != 8 or color_type not in (2, 6) or compression or filtering or interlace:
                raise ProofError("Chromium canvas PNG used an unsupported pixel format.")
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
    channels = 3 if color_type == 2 else 4
    if not width or not height or width > 8192 or height > 8192:
        raise ProofError("Chromium canvas screenshot dimensions were invalid.")
    raw = zlib.decompress(compressed)
    stride = width * channels
    if len(raw) != height * (stride + 1):
        raise ProofError("Chromium canvas PNG pixel data length was invalid.")
    pixels = bytearray(height * stride)

    def paeth(left: int, above: int, upper_left: int) -> int:
        estimate = left + above - upper_left
        distances = (abs(estimate - left), abs(estimate - above), abs(estimate - upper_left))
        return (left, above, upper_left)[distances.index(min(distances))]

    source = 0
    for row in range(height):
        filter_type = raw[source]
        source += 1
        row_start = row * stride
        above_start = row_start - stride
        for index in range(stride):
            value = raw[source + index]
            left = pixels[row_start + index - channels] if index >= channels else 0
            above = pixels[above_start + index] if row else 0
            upper_left = pixels[above_start + index - channels] if row and index >= channels else 0
            if filter_type == 1:
                value += left
            elif filter_type == 2:
                value += above
            elif filter_type == 3:
                value += (left + above) // 2
            elif filter_type == 4:
                value += paeth(left, above, upper_left)
            elif filter_type != 0:
                raise ProofError("Chromium canvas PNG used an unknown row filter.")
            pixels[row_start + index] = value & 255
        source += stride
    return width, height, channels, bytes(pixels)


def grayscale_canvas_samples(png: bytes) -> dict[str, object]:
    width, height, channels, pixels = decode_chromium_png(png)
    points = ((0.38, 0.38), (0.62, 0.38), (0.38, 0.62), (0.62, 0.62))
    samples = []
    for x_ratio, y_ratio in points:
        x = min(width - 1, int(width * x_ratio))
        y = min(height - 1, int(height * y_ratio))
        offset = (y * width + x) * channels
        samples.append(list(pixels[offset : offset + 3]))
    luminance = [round(0.2126 * r + 0.7152 * g + 0.0722 * b) for r, g, b in samples]
    channel_spread = max(max(rgb) - min(rgb) for rgb in samples)
    ordered = all(right - left >= 20 for left, right in zip(luminance, luminance[1:]))
    passed = width >= 64 and height >= 64 and ordered and luminance[0] <= 100 and luminance[-1] >= 150 and channel_spread <= 25
    return {"width": width, "height": height, "rgbSamplesInPatternOrder": samples,
            "luminanceSamples": luminance, "monotonicContrastPattern": passed}


def safe_error_category(message: object) -> str:
    value = str(message).lower()
    for marker, category in (("webgl", "webgl"), ("cornerstone", "viewer_runtime"),
                             ("dicom", "dicom_runtime"), ("fetch", "fetch"),
                             ("network", "network"), ("decode", "decode"),
                             ("undefined", "undefined_value"), ("not found", "not_found")):
        if marker in value:
            return category
    return "other"


def inspect_viewer_text_signals(frame) -> dict[str, bool]:
    return frame.evaluate(
        """() => {
          const text = (document.body?.innerText || '').toLowerCase();
          return Object.fromEntries(['error','failed','loading','no studies','no series',
            'no images','retry','not found','skip all','scroll through images',
            'investigational use only','confirm and continue'].map(term => [term, text.includes(term)]));
        }"""
    )


def inspect_pixel_pattern(frame) -> dict[str, object]:
    canvases = frame.locator("canvas")
    count = min(canvases.count(), 20)
    results = []
    for index in range(count):
        try:
            result = grayscale_canvas_samples(canvases.nth(index).screenshot(timeout=2_000))
        except (PlaywrightError, ProofError, zlib.error):
            continue
        result["canvasIndex"] = index
        results.append(result)
        if result["monotonicContrastPattern"]:
            return {"passed": True, "matchingCanvas": result, "inspectedCanvasCount": count}
    return {"passed": False, "matchingCanvas": None, "inspectedCanvasCount": count, "samples": results[:20]}
