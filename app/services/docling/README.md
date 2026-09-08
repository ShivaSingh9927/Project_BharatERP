# Docling table-reading sidecar

A fourth reader for the invoice pipeline (bills-and-expenses.md §4.9). It reads
table structure with a machine-learned model, so it handles layouts the
whitespace clusterer cannot — Amazon's single-space columns, stacked
sub-tables — and, with OCR on, scanned and photographed invoices that have no
text layer at all.

It slots in AFTER the coordinate reader and BEFORE the language model: it reads
difficult geometry deterministically and **on the premises**, so fewer
documents ever reach a third-party model. Whatever it returns still faces the
same acceptance gates as every other reader.

## Run it

```bash
python3 -m venv .venv
.venv/bin/pip install -r services/docling/requirements.txt
.venv/bin/python services/docling/server.py      # 127.0.0.1:8422
```

The first request pays a one-time model load (~15 s); the process stays warm
after that. Digital PDFs need no OCR and are read in seconds; pass `X-OCR: on`
only for scans.

The pipeline uses it only when reachable. Point the ingest at it with
`DOCLING_URL=http://127.0.0.1:8422` (or set `DOCLING_ENABLED=1` for the
default port). Without it, the pipeline falls through to the model exactly as
before.

## Do not expose it

Loopback only. It authenticates nothing — the same rule as the review server.
