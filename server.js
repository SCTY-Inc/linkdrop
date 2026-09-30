#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const DEFAULT_PORT = 18790;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readLimited(req, maxBytes) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > maxBytes) throw Object.assign(new Error("Capture is too large"), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Capture is too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function httpUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function safeName(value, fallback = "attachment") {
  const base = path.basename(value || fallback).normalize("NFKC");
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]+/gu, "-").replace(/\s+/g, "-").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned.toLowerCase() === "capture.md" ? `attachment-${cleaned}` : cleaned;
}

function slug(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/, "") || "capture";
}

function quoted(value) {
  return JSON.stringify(value);
}

async function parseCapture(req, maxBytes) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.startsWith("application/json")) {
    let data;
    try {
      data = JSON.parse((await readLimited(req, maxBytes)).toString("utf8"));
    } catch (error) {
      if (error.status) throw error;
      throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw Object.assign(new Error("Request body must be an object"), { status: 400 });
    }
    const explicitUrl = cleanString(data.url, 8_000);
    const text = cleanString(data.text ?? data.content, 1_000_000);
    const url = httpUrl(explicitUrl || text);
    return {
      url,
      text: explicitUrl ? text : url ? "" : text,
      title: cleanString(data.title, 300),
      note: cleanString(data.note, 10_000),
      channel: cleanString(data.channel, 80),
      file: null,
    };
  }

  if (contentType.startsWith("multipart/form-data")) {
    const body = await readLimited(req, maxBytes);
    const request = new Request("http://drop.local/capture", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
    let form;
    try {
      form = await request.formData();
    } catch {
      throw Object.assign(new Error("Invalid upload form"), { status: 400 });
    }
    const content = cleanString(form.get("content"), 1_000_000);
    const explicitUrl = cleanString(form.get("url"), 8_000);
    const url = httpUrl(explicitUrl || content);
    const upload = form.get("file");
    const file = upload && typeof upload.arrayBuffer === "function" && upload.size > 0
      ? {
          name: safeName(upload.name),
          mediaType: cleanString(upload.type, 200) || "application/octet-stream",
          bytes: Buffer.from(await upload.arrayBuffer()),
        }
      : null;
    return {
      url,
      text: explicitUrl ? content : url ? "" : content,
      title: cleanString(form.get("title"), 300),
      note: cleanString(form.get("note"), 10_000),
      channel: cleanString(form.get("channel"), 80),
      file,
    };
  }

  throw Object.assign(new Error("Use JSON or multipart form data"), { status: 415 });
}

function captureTitle(capture) {
  if (capture.title) return capture.title;
  if (capture.file) return capture.file.name;
  if (capture.url) return new URL(capture.url).hostname.replace(/^www\./, "");
  return "Text capture";
}

function captureRecord(capture, capturedAt, hash, attachmentName) {
  const title = captureTitle(capture);
  const sourceType = capture.file ? "file" : capture.url ? "link" : "text";
  const frontmatter = [
    "---",
    `title: ${quoted(title)}`,
    'type: "source"',
    'status: "raw"',
    'privacy_tier: "private"',
    `source_type: ${quoted(sourceType)}`,
    `captured_at: ${quoted(capturedAt)}`,
    `channel: ${quoted(capture.channel)}`,
    `content_sha256: ${quoted(hash)}`,
  ];
  if (capture.url) frontmatter.push(`url: ${quoted(capture.url)}`);
  if (capture.note) frontmatter.push(`note: ${quoted(capture.note)}`);
  if (attachmentName) {
    frontmatter.push(`attachment: ${quoted(attachmentName)}`);
    frontmatter.push(`media_type: ${quoted(capture.file.mediaType)}`);
  }
  frontmatter.push("---", "", `# ${title}`, "");

  const body = [];
  if (capture.url) body.push("## Source", "", `<${capture.url}>`, "");
  if (capture.text) body.push(capture.file ? "## Accompanying text" : "## Content", "", capture.text, "");
  if (attachmentName) body.push("## Attachment", "", `[${attachmentName}](./${encodeURIComponent(attachmentName)})`, "");
  if (capture.note) body.push("## Note", "", capture.note, "");
  return [...frontmatter, ...body].join("\n");
}

async function saveCapture(captureDir, capture, now) {
  if (!capture.url && !capture.text && !capture.file) {
    throw Object.assign(new Error("Add a link, text, or file"), { status: 400 });
  }
  if (!capture.channel) capture.channel = "api";

  const fileHash = capture.file
    ? crypto.createHash("sha256").update(capture.file.bytes).digest("hex")
    : "";
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      url: capture.url,
      text: capture.text,
      title: capture.title,
      note: capture.note,
      fileName: capture.file?.name || "",
      fileHash,
    }))
    .digest("hex");
  const capturedAt = now().toISOString();
  const directoryName = `${capturedAt.slice(0, 10)}-${hash.slice(0, 12)}-${slug(captureTitle(capture))}`;
  const relativePath = `${directoryName}/capture.md`;
  const destination = path.join(captureDir, directoryName);

  await fs.mkdir(captureDir, { recursive: true, mode: 0o700 });
  try {
    await fs.access(destination);
    return { path: relativePath, duplicate: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporary = path.join(captureDir, `.tmp-${process.pid}-${crypto.randomUUID()}`);
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    const attachmentName = capture.file ? safeName(capture.file.name) : "";
    if (capture.file) {
      await fs.writeFile(path.join(temporary, attachmentName), capture.file.bytes, { mode: 0o600 });
    }
    await fs.writeFile(
      path.join(temporary, "capture.md"),
      captureRecord(capture, capturedAt, hash, attachmentName),
      { mode: 0o600 },
    );
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      await fs.rm(temporary, { recursive: true, force: true });
      return { path: relativePath, duplicate: true };
    }
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { path: relativePath, duplicate: false };
}

const DROP_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="apple-mobile-web-app-title" content="Drop">
  <link rel="icon" type="image/svg+xml" href="icon.svg">
  <link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">
  <title>Drop</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px; background: #0c0c0c; color: #f4f4f1; font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; }
    main { width: min(100%, 620px); }
    h1 { margin: 0 0 4px; font-size: clamp(28px, 7vw, 44px); letter-spacing: -0.04em; }
    p { margin: 0 0 24px; color: #999; }
    form { display: grid; gap: 14px; }
    label { display: grid; gap: 7px; color: #bbb; font-size: 13px; }
    textarea, input, button { width: 100%; border: 1px solid #333; border-radius: 10px; background: #151515; color: inherit; font: inherit; }
    textarea, input { padding: 13px 14px; }
    textarea { min-height: 150px; resize: vertical; }
    input[type=file] { padding: 10px; }
    button { min-height: 50px; border-color: #f4f4f1; background: #f4f4f1; color: #111; font-weight: 700; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .55; }
    #status { min-height: 24px; margin: 0; color: #aaa; }
    @media (prefers-color-scheme: light) {
      body { background: #f5f5f1; color: #111; }
      p, #status { color: #666; }
      label { color: #444; }
      textarea, input { border-color: #ccc; background: #fff; }
      button { border-color: #111; background: #111; color: #fff; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Drop</h1>
    <p>Capture now. Sort it out later.</p>
    <form id="drop-form">
      <label>Paste a link or text<textarea name="content" autofocus placeholder="https://… or anything worth keeping"></textarea></label>
      <label>File<input name="file" type="file"></label>
      <label>Note (optional)<input name="note" placeholder="Why does this matter?"></label>
      <button type="submit">Save</button>
      <p id="status" role="status" aria-live="polite"></p>
    </form>
  </main>
  <script>
    const form = document.querySelector("#drop-form");
    const button = form.querySelector("button");
    const status = document.querySelector("#status");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      status.textContent = "Saving…";
      button.disabled = true;
      const body = new FormData(form);
      body.set("channel", "web-drop");
      try {
        const response = await fetch("capture", { method: "POST", body });
        const receipt = await response.json();
        if (!response.ok) throw new Error(receipt.error || "Capture failed");
        status.textContent = receipt.duplicate ? "Already captured." : "Captured.";
        form.elements.content.value = "";
        form.elements.file.value = "";
        form.elements.note.value = "";
        form.elements.content.focus();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;

function createDropServer({ captureDir, now = () => new Date(), maxBytes = DEFAULT_MAX_BYTES }) {
  if (!captureDir) throw new Error("CAPTURE_DIR is required");

  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://drop.local").pathname;
    if (req.method === "GET" && (pathname === "/icon.svg" || pathname === "/apple-touch-icon.png")) {
      const fileName = pathname.slice(1);
      const content = await fs.readFile(path.join(__dirname, fileName));
      res.writeHead(200, {
        "content-type": fileName.endsWith(".svg") ? "image/svg+xml" : "image/png",
        "cache-control": "public, max-age=86400",
      });
      return res.end(content);
    }
    if (req.method === "GET" && pathname === "/health") return json(res, 200, { status: "ok" });
    if (req.method === "GET" && (pathname === "/" || pathname === "/shortcut")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      return res.end(DROP_PAGE);
    }
    if (req.method !== "POST" || (pathname !== "/capture" && pathname !== "/links")) {
      return json(res, 404, { error: "Not found" });
    }
    try {
      const capture = await parseCapture(req, maxBytes);
      if (!capture.channel) {
        capture.channel = pathname === "/links" ? "ios-share-sheet" : "api";
      }
      const receipt = await saveCapture(captureDir, capture, now);
      return json(res, receipt.duplicate ? 200 : 201, { success: true, ...receipt });
    } catch (error) {
      console.error("Capture failed:", error.message);
      return json(res, error.status || 500, { error: error.status ? error.message : "Capture failed" });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const server = createDropServer({
    captureDir: process.env.CAPTURE_DIR || "/raw",
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`Drop listening on http://0.0.0.0:${port}`);
    console.log(`Capture directory: ${process.env.CAPTURE_DIR || "/raw"}`);
  });
}

module.exports = { createDropServer, saveCapture };
