# Structure sidecar — candidate tables, ranked by nothing

Reads a PDF several different ways and returns **every** table any strategy can
see, with a bounding box per cell. It decides nothing: the acceptance gate in
`src/parse/candidateTables.ts` grades each candidate and keeps one only if the
arithmetic ties and no rival reading ties as well.

This replaces recognising layouts with searching over them. A wrong candidate
is not a bug here — returning too few is.

## Strategies

| | reads |
|---|---|
| `lines` | column boundaries the vendor **drew** on the page |
| `default` | rules where present, text alignment where not |
| `text` | pure text alignment, for unruled tables |
| `words` | rows rebuilt from word positions — last structural resort |
| `ocr-words` | scans, at 300 dpi |

Measured on the corpus: 18 of 20 documents carry vector ruling lines, and
reading them fixes failures the whitespace clusterer cannot — a currency glyph
landing inside a numeric column, and columns separated by a single space.

It also repairs the pre-Unicode rupee fonts ("Rupee Foradian" and relatives),
which draw ₹ on the backtick codepoint with no ToUnicode map, so every
extractor yields "`" where the page shows ₹.

## Run it

```bash
python3 -m venv .venv
.venv/bin/pip install -r services/parser/requirements.txt
.venv/bin/python services/parser/server.py      # 127.0.0.1:8423
```

Point the ingest at it with `PARSER_URL=http://127.0.0.1:8423`, or
`PARSER_ENABLED=1` for the default port. Without it the pipeline behaves
exactly as it did before.

## Do not expose it

Loopback only. It authenticates nothing — the same rule as the review server
and the Docling sidecar.
