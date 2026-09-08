#!/usr/bin/env python3
"""
A candidate-structure sidecar: every plausible reading of a PDF, none of them believed.
Spec: bills-and-expenses.md BE-21

Why this exists
---------------
The reader used to be one program that decided what a document meant. Each new
vendor layout that defeated it got its own recogniser, and the count grew with
the number of vendors — which, for Indian invoices, is unbounded.

The fix is to stop recognising layouts and start SEARCHING. This service does
the finding: it reads a PDF several different ways and returns every table it
can see, from every strategy, without ranking them. It decides nothing. The
acceptance gate on the TypeScript side grades each candidate and keeps one only
if the arithmetic ties and no rival reading ties as well.

So a wrong candidate is not a bug here. Returning too few is.

The strategies, and why each earns its place
--------------------------------------------
  lines     Column boundaries taken from the rules the vendor DREW on the page.
            Measured on the corpus: 18 of 20 documents carry vector ruling
            lines, and reading them fixes two failures the whitespace
            clusterer cannot — a stray currency glyph landing inside a numeric
            column, and Amazon's columns separated by a single space.
  default   pdfplumber's hybrid: rules where they exist, text alignment where
            they do not. Catches half-ruled tables.
  text      Pure text alignment, for tables drawn with no rules at all.
  words     Row reconstruction from word positions — the last structural
            resort, and the only one that survives a table with neither rules
            nor consistent alignment.

Scanned documents have no text layer and no rules, so they are routed to OCR
and come back as word rows. OCR reads pixels: nothing it produces is a figure
the vendor published, which is exactly why it faces the same gate.

Contract
--------
  GET  /health              -> {"ready": true}
  POST /extract              body: the PDF bytes
       header X-OCR: auto|on|off   default auto — OCR only when the page has
                                   essentially no text of its own
       -> {"pages": int, "route": "digital"|"ocr", "text": str,
           "tables": [{"page": int, "method": str,
                       "cells": [[str, ...], ...],
                       "boxes": [[[x0,y0,x1,y1]|null, ...], ...],
                       "pageWidth": float, "pageHeight": float}]}

Bounding boxes travel with every cell because provenance requires them
(provenance.md PR-3/PR-6): a figure a CA cannot point at on the page is a
figure they cannot check. This is why the structure layer is pdfplumber rather
than a table model — the model gives cells, not coordinates.

Bound to 127.0.0.1. It authenticates nothing and must never be exposed — the
same rule as the review server and the Docling sidecar.
"""

import io
import json
import logging
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pdfplumber

logging.basicConfig(level=logging.INFO, format="%(asctime)s parser %(message)s")
log = logging.getLogger("parser-sidecar")

# A page with less than this much text of its own is a scan, whatever it claims.
DIGITAL_CHARS_PER_PAGE = 50

STRATEGIES = [
    ("lines", {"vertical_strategy": "lines", "horizontal_strategy": "lines"}),
    ("default", {}),
    ("text", {"vertical_strategy": "text", "horizontal_strategy": "text"}),
]


def _rupee_hack_fonts(page) -> bool:
    """
    Whether this page draws text in a pre-Unicode rupee font.

    Before ₹ received a Unicode codepoint, Indian software shipped fonts —
    "Rupee Foradian" and its relatives — that drew the symbol on top of an
    ASCII punctuation slot, usually the backtick. The font is typically not
    embedded and carries no ToUnicode map, so every extractor on earth decodes
    the byte faithfully and yields a backtick.

    The page then appears to hold a stray "`" inside a money column, which the
    acceptance gate correctly refuses as not-a-number. The character is a
    currency mark and always was; only the encoding lied.
    """
    try:
        return any("rupee" in (c.get("fontname") or "").lower() for c in page.chars)
    except Exception:
        return False


def _fix_rupee(text: str, hack: bool) -> str:
    return text.replace("`", "₹") if hack else text


def _clean(cell, hack: bool) -> str:
    if cell is None:
        return ""
    return _fix_rupee(" ".join(str(cell).split()), hack)


def _grid_key(cells) -> str:
    """Identity of a table, so the same grid found by two strategies is returned once."""
    return json.dumps(cells, separators=(",", ":"))


def _tables_for_page(page, pno: int, hack: bool) -> list:
    out, seen = [], set()
    for method, settings in STRATEGIES:
        try:
            found = page.find_tables(settings) if settings else page.find_tables()
        except Exception as e:
            log.warning("page %d strategy %s failed: %s", pno, method, e)
            continue
        for t in found:
            try:
                rows = t.extract()
            except Exception:
                continue
            cells = [[_clean(c, hack) for c in r] for r in rows]
            cells = [r for r in cells if any(r)]
            # A single row is a caption, not a table; a single column is a list.
            if len(cells) < 2 or max(len(r) for r in cells) < 2:
                continue
            key = _grid_key(cells)
            if key in seen:
                continue
            seen.add(key)
            boxes = []
            for r in t.rows:
                boxes.append([list(c) if c else None for c in r.cells])
            out.append({
                "page": pno, "method": method, "cells": cells, "boxes": boxes,
                "pageWidth": float(page.width), "pageHeight": float(page.height),
            })
    return out


AMOUNT = re.compile(r"\d[\d,]*\.\d{2}")


def _word_rows(page, pno: int, hack: bool) -> list:
    """
    Rows rebuilt from word positions — the structural resort of last resort.

    Returned as a table of one column per word-run so the gate can still try
    it; a row that means nothing simply fails to tie, which costs nothing.
    """
    try:
        words = page.extract_words()
    except Exception:
        return []
    buckets: dict = {}
    for w in words:
        buckets.setdefault(round(w["top"] / 3.0), []).append(w)
    rows, boxes = [], []
    for k in sorted(buckets):
        ws = sorted(buckets[k], key=lambda x: x["x0"])
        cells = [_fix_rupee(w["text"], hack) for w in ws]
        rows.append(cells)
        boxes.append([[w["x0"], w["top"], w["x1"], w["bottom"]] for w in ws])
    keep = [i for i, r in enumerate(rows) if any(AMOUNT.search(c) for c in r)]
    if not keep:
        return []
    return [{"page": pno, "method": "words", "cells": rows, "boxes": boxes,
             "pageWidth": float(page.width), "pageHeight": float(page.height)}]


def _ocr_pages(data: bytes) -> tuple:
    """
    Read a scan. Returns (text, tables) with word rows carrying pixel boxes.

    300 dpi rather than 200: measured on the one real scan in the corpus, both
    read every figure on the invoice page correctly, but the lower setting
    misread a weight on a later page (179,684 -> 179,784). A digit is cheap to
    get wrong and expensive to post.
    """
    import numpy as np
    import pymupdf
    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR()
    doc = pymupdf.open(stream=data, filetype="pdf")
    text_parts, tables = [], []
    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=300)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:
            img = img[:, :, :3]
        res, _ = engine(img)
        if not res:
            continue
        scale = 72.0 / 300.0
        items = []
        for box, txt, conf in res:
            x0 = min(p[0] for p in box) * scale
            y0 = min(p[1] for p in box) * scale
            x1 = max(p[0] for p in box) * scale
            y1 = max(p[1] for p in box) * scale
            items.append((y0, x0, x1, y1, txt))
        items.sort()
        text_parts.append("\n".join(t[4] for t in items))
        buckets: dict = {}
        for y0, x0, x1, y1, txt in items:
            buckets.setdefault(round(y0 / 4.0), []).append((x0, x1, y1, txt))
        rows, boxes = [], []
        for k in sorted(buckets):
            ws = sorted(buckets[k])
            rows.append([w[3] for w in ws])
            boxes.append([[w[0], k * 4.0, w[1], w[2]] for w in ws])
        if rows:
            tables.append({"page": i + 1, "method": "ocr-words", "cells": rows,
                           "boxes": boxes, "pageWidth": float(page.rect.width),
                           "pageHeight": float(page.rect.height)})
    return "\n".join(text_parts), tables


def extract(data: bytes, ocr_mode: str = "auto") -> dict:
    tables, text_parts = [], []
    pages = 0
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        pages = len(pdf.pages)
        for pno, page in enumerate(pdf.pages, start=1):
            hack = _rupee_hack_fonts(page)
            txt = page.extract_text() or ""
            text_parts.append(_fix_rupee(txt, hack))
            found = _tables_for_page(page, pno, hack)
            if not found:
                found = _word_rows(page, pno, hack)
            tables.extend(found)
    text = "\n".join(text_parts)

    thin = len(text.strip()) < DIGITAL_CHARS_PER_PAGE * max(pages, 1)
    if ocr_mode == "on" or (ocr_mode == "auto" and thin):
        try:
            otext, otables = _ocr_pages(data)
            if otext.strip():
                return {"pages": pages, "route": "ocr", "text": otext, "tables": otables}
        except Exception as e:
            log.warning("OCR failed: %s", e)
    return {"pages": pages, "route": "digital", "text": text, "tables": tables}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet; we log what we choose to
        pass

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ready": True})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/extract":
            self._send(404, {"error": "not found"})
            return
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n)
        mode = (self.headers.get("X-OCR") or "auto").lower()
        try:
            result = extract(data, mode)
        except Exception as e:
            log.exception("extract failed")
            self._send(500, {"error": f"{type(e).__name__}: {e}"[:300]})
            return
        log.info("%d pages, route=%s, %d candidate tables",
                 result["pages"], result["route"], len(result["tables"]))
        self._send(200, result)


def main() -> None:
    port = int(os.environ.get("PARSER_PORT", "8423"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    log.info("listening on 127.0.0.1:%d (loopback only)", port)
    srv.serve_forever()


if __name__ == "__main__":
    main()
