#!/usr/bin/env python3
"""
A table-reading sidecar, backed by Docling.
Spec: bills-and-expenses.md §4.9

Why a service and not a call per document: Docling loads ~800 MB of models,
and paying that on every invocation would make it useless. The converter is
built once at start-up and reused, so a request is just the read.

Why a separate PROCESS at all: the rest of this system is TypeScript, and
Docling is PyTorch. Rather than drag a Python runtime into the Node process,
the reader talks to this over HTTP on the loopback interface only. It holds no
state, sees one PDF at a time, and returns cells — the same shape every other
reader in the pipeline produces, so it faces the same acceptance gates and
earns no trust the coordinate reader has not.

This is a READER. It decides nothing. Whether a table it returns can be
believed is settled downstream by `gradeTable`, exactly as for the deterministic
and model paths.

Contract
--------
  GET  /health                 -> {"ready": true}
  POST /extract                 body: the PDF bytes
       header X-OCR: on|off     default off — digital PDFs need no OCR, and
                                running it anyway cost 4.5 minutes a document
       -> {"tables": [ {"page": int, "cells": [[str, ...], ...]} ]}
          cells[0] is the header row; the rest are data rows.

Bound to 127.0.0.1 by design. It authenticates nothing and must never be
exposed — the same rule as the review server.
"""

import io
import json
import logging
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(level=logging.INFO, format="%(asctime)s docling %(message)s")
log = logging.getLogger("docling-sidecar")

# Built once, at import, and shared. The first conversion still pays a lazy
# model load; everything after is warm.
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions


def _converter(ocr: bool) -> DocumentConverter:
    opts = PdfPipelineOptions()
    opts.do_ocr = ocr
    opts.do_table_structure = True
    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    )


# Two converters: OCR is a different pipeline, and swapping the option on one
# instance is not supported. Both are cheap to hold; the models are shared.
CONV = {"off": _converter(False), "on": _converter(True)}


def _warm() -> None:
    """A one-page blank PDF, to force the lazy model load before first request."""
    blank = (
        b"%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
        b"trailer<</Root 1 0 R>>\n%%EOF"
    )
    try:
        _extract(blank, ocr=False)
        log.info("warm: models loaded")
    except Exception as e:  # a blank PDF may legitimately yield nothing
        log.info("warm: %s", e)


def _extract(pdf: bytes, ocr: bool) -> list[dict]:
    from docling.datamodel.base_models import DocumentStream

    conv = CONV["on" if ocr else "off"]
    stream = DocumentStream(name="bill.pdf", stream=io.BytesIO(pdf))
    doc = conv.convert(stream).document

    tables = []
    for tbl in doc.tables:
        page = tbl.prov[0].page_no if tbl.prov else 1
        df = tbl.export_to_dataframe(doc)
        # Header first, then the body — the shape gradeTable expects.
        cells = [[str(c) for c in df.columns]]
        for _, row in df.iterrows():
            cells.append([str(v) for v in row.tolist()])
        tables.append({"page": int(page), "cells": cells})
    return tables


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, {"ready": True})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/extract":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            self._send(400, {"error": "empty body"})
            return
        pdf = self.rfile.read(length)
        ocr = (self.headers.get("X-OCR", "off").strip().lower() == "on")
        try:
            tables = _extract(pdf, ocr=ocr)
            self._send(200, {"tables": tables})
        except Exception as e:
            log.exception("extract failed")
            self._send(500, {"error": str(e)})

    def log_message(self, *args) -> None:  # quiet; we log what we mean to
        pass


def main() -> None:
    host = os.environ.get("DOCLING_HOST", "127.0.0.1")
    port = int(os.environ.get("DOCLING_PORT", "8422"))
    if host not in ("127.0.0.1", "localhost"):
        # It authenticates nothing. Loopback only, no exceptions.
        log.error("refusing to bind to %s — loopback only", host)
        sys.exit(1)
    _warm()
    log.info("listening on %s:%d", host, port)
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
