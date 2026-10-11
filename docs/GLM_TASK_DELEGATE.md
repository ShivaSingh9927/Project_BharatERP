# Local GLM task delegate

The `app/scripts/glm-delegate.ts` command sends one bounded task to Z.ai and
prints its answer. It has no shell, database, browser, or repository-write
tools. Code tasks may return a proposed diff; a human or Codex must review and
apply it. It is separate from Codex's native `spawn_agent` models, which cannot
select a Z.ai provider in this runtime.

## Run a text task

From `app/`, with Node 22 or newer:

```bash
npm run agent:glm -- --model text --task "Review the error handling in this function"
```

Attach repository files explicitly when needed:

```bash
npm run agent:glm -- --model text --file src/domain/example.ts --task "Suggest a focused fix and return a unified diff"
```

For an image or screenshot, use the vision model and select the image explicitly:

```bash
npm run agent:glm -- --model vision --image path/to/screenshot.png --task "Summarize the visible UI issue"
```

The runner defaults to the local credential file at
`/home/shiva/Documents/api_keys/zen_ai_api.txt`. It accepts a one-line raw key
or a one-line `ZAI_API_KEY=...` assignment. Alternatively, set `ZAI_API_KEY`
in the process environment or `ZAI_API_KEY_FILE` to a different key-file path.
Credentials are only read into process memory and are never printed. Do not
put key values in command arguments, task text, or repository files.

Only paths under the repository root may be selected. Text files are limited
to 80 KB and images to 8 MB. Selected contents are transmitted to Z.ai; do not
send client, banking, tax, password-protected document, or other confidential
data unless the firm has approved that external AI use. Provider errors are
reported without printing the provider response body.

## Model and account check

Z.ai's published API pricing lists GLM-4.7-Flash and GLM-4.6V-Flash as free
models at the time this was added. A synthetic request to GLM-4.7-Flash
returned HTTP 429 with Z.ai business code 1305, which Z.ai defines as
temporary service overload. This does not indicate a bad API key or an empty
resource balance. GLM OCR uses the separate `glm-ocr` model and `/layout_parsing`
route, while this delegate uses a text model at `/chat/completions`; OCR can
work while chat completions are temporarily overloaded. Retry the text task
later. No project or client files were sent in the diagnostic requests.
