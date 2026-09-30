# linkdrop

A link inbox for humans and agents: share sheet -> markdown -> JSON API.

Accepts a link, text, or one file with an optional note. Writes one immutable capture bundle and returns. Capture does not fetch, classify, or summarize. `enrich.js` optionally fetches public context for one captured link and writes a create-only `enriched.md` sidecar.

## Run

Node 22+. No dependencies.

```sh
CAPTURE_DIR=./captures PORT=18790 node server.js
curl localhost:18790/health
curl -X POST localhost:18790/links -H 'content-type: application/json' \
  -d '{"content":"https://example.com","title":"Example"}'
```

The server binds `0.0.0.0` and has no authentication. Keep it on a private network. `Dockerfile` and `docker-compose.yml` are included.

## API

- `GET /` web form
- `GET /health`
- `POST /links`, `POST /capture`: JSON (`url`, `text` or `content`, `title`, `note`, `channel`) or multipart (`content`, `file`, `title`, `note`, `channel`; one file)

Shortcut payload: `{"content": "Shortcut Input", "title": "Name", "note": "optional"}` with `Content-Type: application/json`.

## Storage

```text
$CAPTURE_DIR/YYYY-MM-DD-<content-hash>-<title>/
├── capture.md
├── enriched.md        # after enrich.js
└── <attachment>       # file captures only
```

Same-day exact retries return the first receipt. Nothing is rewritten.

| Variable | Purpose |
|---|---|
| `CAPTURE_DIR` | capture root; default `/raw` |
| `PORT` | HTTP port; default `18790` |

## Enrichment

```sh
CAPTURE_DIR=./captures ./enrich.js <capture-id>
```

Needs the `treg` CLI (`TREG_BIN`) and, for X articles, `x-search.sh` (`X_SEARCH_BIN`).

## Test

```sh
node --test
```

## License

MIT
