"""Validate uploaded meal photos and produce the analysis and thumbnail JPEGs."""

from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP"}
ANALYSIS_SIDE = 1024
THUMBNAIL_SIDE = 720


class ImageError(ValueError):
    """The uploaded file is not a usable image."""


def prepare_images(raw: bytes) -> tuple[bytes, bytes]:
    """Return (analysis_jpeg, thumbnail_jpeg) for an uploaded image."""
    try:
        with Image.open(BytesIO(raw)) as probe:
            image_format = probe.format
            probe.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ImageError("The file is not a valid image") from exc

    if image_format not in ALLOWED_FORMATS:
        raise ImageError("Only JPEG, PNG or WEBP images are supported")

    # verify() leaves the image unusable, so decode it again.
    with Image.open(BytesIO(raw)) as opened:
        image = ImageOps.exif_transpose(opened)
        image = _flatten_to_rgb(image)

    analysis = _to_jpeg(_fit(image.copy(), ANALYSIS_SIDE))
    thumbnail = _to_jpeg(_fit(image.copy(), THUMBNAIL_SIDE))
    return analysis, thumbnail


def _flatten_to_rgb(image: Image.Image) -> Image.Image:
    if image.mode == "RGB":
        return image
    rgba = image.convert("RGBA")
    background = Image.new("RGB", rgba.size, (255, 255, 255))
    background.paste(rgba, mask=rgba.getchannel("A"))
    return background


def _fit(image: Image.Image, side: int) -> Image.Image:
    image.thumbnail((side, side), Image.LANCZOS)
    return image


def _to_jpeg(image: Image.Image) -> bytes:
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=85)
    return buffer.getvalue()
