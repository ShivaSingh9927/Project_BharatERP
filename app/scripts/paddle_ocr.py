#!/usr/bin/env python3
"""
PaddleOCR sidecar: an image path in, positioned text boxes out as JSON.

Spec: bank-and-reconciliation.md §5.1

This deliberately does NOT understand bank statements. It reports where text
is on the page and nothing more; every decision about which column is the
balance, which way the money moved, and whether the statement adds up stays in
TypeScript, where it is tested and where the arithmetic checks live.

That split matters for a reason beyond tidiness. The measured failure mode of
PaddleOCR is not bad digits — across seven sample statements there were none —
it is bad *letters and punctuation*: `cr` read as `cz`, a comma read as a full
stop, the digit 0 read as the letter O. Those are repaired and reported one
layer up, so a repair is always visible in the import warnings rather than
buried in a subprocess.

Usage:
    python3 paddle_ocr.py <image-path>          # JSON to stdout
    python3 paddle_ocr.py --selftest            # deps present and usable?

Output (stdout, one JSON object):
    {
      "ok": true,
      "provider": "paddleocr",
      "version": {...},
      "width": 736, "height": 981,
      "elapsed_ms": 52800,
      "mean_confidence": 0.9871,
      "boxes": [{"x0":.., "y0":.., "x1":.., "y1":.., "text":"..", "score":..}, ..]
    }

Failures also produce JSON — `{"ok": false, "error": ...}` — so the caller
never has to parse a traceback to find out what went wrong.
"""

import json
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")

# Paddle's oneDNN CPU backend crashes on these models with
#   NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support
#     [pir::ArrayAttribute<pir::DoubleAttribute>]
# It is not a tuning flag — with MKL-DNN enabled the pipeline does not run at
# all on CPU. Set before paddle is imported as well as passed explicitly.
os.environ.setdefault("FLAGS_use_mkldnn", "0")


def fail(message: str, code: str = "ocr_failed") -> None:
    json.dump({"ok": False, "error": message, "code": code}, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(1)


def build_engine():
    from paddleocr import PaddleOCR

    # The three preprocessing stages are off on purpose. Orientation
    # classification and unwarping are for photographs of curved pages; a bank
    # statement is a flat render or a flatbed scan, and each stage costs seconds
    # per page on CPU while introducing its own failure mode.
    return PaddleOCR(
        lang="en",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        enable_mkldnn=False,
    )


def selftest() -> None:
    try:
        import paddle
        import paddleocr
    except Exception as e:  # noqa: BLE001 — the caller wants the reason, not a type
        fail(f"PaddleOCR is not installed in this interpreter: {e}", "not_installed")

    try:
        build_engine()
    except Exception as e:  # noqa: BLE001
        fail(f"PaddleOCR is installed but would not start: {e}", "not_usable")

    json.dump({
        "ok": True,
        "paddle": paddle.__version__,
        "paddleocr": paddleocr.__version__,
        "python": sys.version.split()[0],
    }, sys.stdout)
    sys.stdout.write("\n")


def run(path: str) -> None:
    if not os.path.isfile(path):
        fail(f"no such file: {path}", "no_such_file")

    try:
        import paddle
        import paddleocr
    except Exception as e:  # noqa: BLE001
        fail(f"PaddleOCR is not installed in this interpreter: {e}", "not_installed")

    try:
        engine = build_engine()
    except Exception as e:  # noqa: BLE001
        fail(f"PaddleOCR would not start: {e}", "not_usable")

    started = time.time()
    try:
        results = engine.predict(path)
    except Exception as e:  # noqa: BLE001
        fail(f"OCR failed on this image: {e}")
    elapsed_ms = int((time.time() - started) * 1000)

    if not results:
        fail("OCR returned no result for this image", "empty")

    result = results[0]
    polys = result.get("rec_polys") or []
    texts = result.get("rec_texts") or []
    scores = result.get("rec_scores") or []

    boxes = []
    for poly, text, score in zip(polys, texts, scores):
        stripped = str(text).strip()
        if not stripped:
            continue
        xs = [float(p[0]) for p in poly]
        ys = [float(p[1]) for p in poly]
        boxes.append({
            "x0": min(xs), "x1": max(xs),
            "y0": min(ys), "y1": max(ys),
            "text": stripped,
            "score": round(float(score), 4),
        })

    if not boxes:
        fail(
            "OCR found no text in this image. It is probably too low-resolution "
            "to read; 300 DPI or better is needed.", "empty")

    # Reading order, so the caller receives something already roughly sensible
    # even before it clusters rows.
    boxes.sort(key=lambda b: (b["y0"], b["x0"]))

    width = height = None
    try:
        from PIL import Image
        with Image.open(path) as im:
            width, height = im.size
    except Exception:  # noqa: BLE001 — page size is a nicety, not a requirement
        pass

    json.dump({
        "ok": True,
        "provider": "paddleocr",
        "version": {"paddle": paddle.__version__, "paddleocr": paddleocr.__version__},
        "width": width,
        "height": height,
        "elapsed_ms": elapsed_ms,
        "mean_confidence": round(sum(b["score"] for b in boxes) / len(boxes), 4),
        "boxes": boxes,
    }, sys.stdout)
    sys.stdout.write("\n")


def main() -> None:
    args = sys.argv[1:]
    if not args:
        fail("usage: paddle_ocr.py <image-path> | --selftest", "usage")
    if args[0] == "--selftest":
        selftest()
        return
    run(args[0])


if __name__ == "__main__":
    main()
