> Diátaxis: reference

# Drop

Drop is one fast capture edge for the Wiki raw corpus. It accepts a link, text, or one file with an optional note. It writes one immutable capture bundle and returns immediately.

Capture does not fetch, classify, summarize, browse, or route work. The `enrich.js` action acquires public context for one captured link through Treg and writes one create-only `enriched.md` sidecar. GiveCare BB invokes this owner-native action before it asks Jev to judge an input. **Get source context** retries a failed acquisition.

## Surfaces

- Web form: `http://atum-vps.tail6bb091.ts.net:18790/`
- iOS Share Sheet endpoint: `POST http://atum-vps.tail6bb091.ts.net:18790/links`
- Generic endpoint: `POST http://atum-vps.tail6bb091.ts.net:18790/capture`
- Health: `GET http://atum-vps.tail6bb091.ts.net:18790/health`

Drop is available only on the `scty.org` tailnet. Tailscale owns access control; Drop has no second application key.

The existing iOS Shortcut remains compatible:

```json
{
  "content": "Shortcut Input",
  "title": "Name",
  "note": "optional"
}
```

Send `Content-Type: application/json`. The device must be connected to Tailscale. HTTP is private inside Tailscale's encrypted tunnel; the service is not bound to the public interface.

## Storage

Each capture is a create-only bundle under `CAPTURE_DIR`:

```text
YYYY-MM-DD-<content-hash>-<title>/
├── capture.md
├── enriched.md        # only after explicit source acquisition
└── <attachment>       # only for file captures
```

Exact same-day retries return the first receipt without rewriting it. Enrichment never rewrites `capture.md` or an existing sidecar. Drop stores no database, feed, mutable link file, or generated catalog.

Production mounts `CAPTURE_DIR` at `/home/deploy/wiki/raw/library/captures`.

## Request formats

JSON accepts `url`, `text` or `content`, `title`, `note`, and `channel`.

Multipart form data accepts `content`, `file`, `title`, `note`, and `channel`. One file is supported.

## Environment

| Variable | Required | Purpose |
|---|---:|---|
| `CAPTURE_DIR` | yes in production | Raw capture root; defaults to `/raw` |
| `PORT` | no | HTTP port; defaults to `18790` |

## Verify

```sh
node --test test/*.test.js
docker build -t drop-test .
```

Run one explicit enrichment with the canonical capture root:

```sh
CAPTURE_DIR=/home/deploy/wiki/raw/library/captures ./enrich.js <capture-id>
```

The LinkedIn routed call is capped at $0.005. TikTok and X use fixed-cost post-detail endpoints. Generic pages request text only.
