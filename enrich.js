#!/usr/bin/env node

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");

const execFileAsync = promisify(execFile);
const DEFAULT_CAPTURE_DIR = "/home/deploy/wiki/raw/library/captures";
const DEFAULT_TREG_BIN = "/home/deploy/.local/bin/treg";
const DEFAULT_X_SEARCH_BIN = "/home/deploy/agents/scripts/x-twitter/x-search.sh";
const USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0";

function fields(markdown) {
  if (!markdown.startsWith("---\n")) return {};
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) return {};
  return Object.fromEntries(markdown.slice(4, end).split("\n").flatMap((line) => {
    const index = line.indexOf(":");
    if (index < 0) return [];
    const key = line.slice(0, index).trim();
    const raw = line.slice(index + 1).trim();
    try {
      return [[key, JSON.parse(raw)]];
    } catch {
      return [[key, raw]];
    }
  }));
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function at(value, keys) {
  let current = value;
  for (const key of keys) current = asObject(current)[key];
  return current;
}

function textAt(value, candidates) {
  for (const candidate of candidates) {
    const found = at(value, candidate);
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return "";
}

function numberAt(value, candidates) {
  for (const candidate of candidates) {
    const found = Number(at(value, candidate));
    if (Number.isFinite(found) && found >= 0) return found;
  }
  return null;
}

function excerpt(value, length = 280) {
  return value.replace(/\s+/g, " ").trim().slice(0, length);
}

function enrichmentPlan(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "linkedin.com" || host === "lnkd.in") {
    return {
      endpoint: "treg.linkedin.post.detail",
      args: [
        "--method", "POST",
        "--data", JSON.stringify({ url }),
        "--header", "X-Treg-Route-Max-Cost: 0.005",
      ],
    };
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    return {
      endpoint: "scrapecreators.tiktok.video.detail",
      args: ["--query", `url=${url}`, "--query", "get_transcript=true"],
    };
  }
  if (host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com")) {
    return {
      endpoint: "scrapecreators.x.v1-twitter-tweet",
      args: ["--query", `url=${url}`, "--query", "trim=true", "--query", "cache_max_age=7d"],
    };
  }
  return {
    endpoint: "exa.web.contents.get",
    args: [
      "--method", "POST",
      "--data", JSON.stringify({ urls: [url], text: { maxCharacters: 6000 } }),
    ],
  };
}

function engagement(parts) {
  return parts.filter(([, value]) => value !== null).map(([label, value]) => `${value} ${label}`).join(" · ");
}

function normalizeLinkedIn(payload, url) {
  const output = asObject(payload.output);
  if (!output.post) return null;
  const body = textAt(output, [["text"], ["post", "text"], ["post", "description"]]);
  const title = textAt(output, [["title"], ["post", "title"]]) || excerpt(body, 100) || "LinkedIn post";
  const author = textAt(output, [["post", "author", "name"], ["post", "authorName"], ["post", "actor", "name"]]);
  return {
    title,
    description: excerpt(body),
    body,
    author,
    resolvedUrl: textAt(output, [["post", "url"], ["post", "postUrl"]]) || url,
    engagement: engagement([["likes", numberAt(output, [["likes"]])], ["comments", numberAt(output, [["comments"]])]]),
    extractor: textAt(payload, [["_treg", "served_by"]]) || "treg.linkedin.post.detail",
  };
}

function normalizeTikTok(payload, url) {
  const detail = asObject(payload.aweme_detail ?? at(payload, ["itemInfo", "itemStruct"]) ?? at(payload, ["data", "aweme_detail"]) ?? payload.data);
  const caption = textAt(detail, [["desc"], ["description"], ["text"]]);
  const transcript = textAt(payload, [["transcript"], ["captions", "transcript"]]);
  const body = transcript || caption;
  if (!body) return null;
  const author = textAt(detail, [["author", "nickname"], ["author", "unique_id"], ["author", "uniqueId"]]);
  const stats = asObject(detail.statistics ?? detail.stats);
  return {
    title: author ? `${author} on TikTok` : excerpt(caption || body, 100) || "TikTok video",
    description: excerpt(caption || body),
    body,
    author,
    resolvedUrl: url,
    engagement: engagement([
      ["plays", numberAt(stats, [["play_count"], ["playCount"]])],
      ["likes", numberAt(stats, [["digg_count"], ["diggCount"]])],
      ["comments", numberAt(stats, [["comment_count"], ["commentCount"]])],
      ["shares", numberAt(stats, [["share_count"], ["shareCount"]])],
    ]),
    extractor: "scrapecreators.tiktok.video.detail",
  };
}

function normalizeX(payload, url) {
  const tweet = asObject(payload.tweet ?? payload.data ?? payload);
  const body = textAt(tweet, [
    ["article", "plain_text"],
    ["note_tweet", "text"],
    ["text"],
    ["full_text"],
    ["legacy", "full_text"],
  ]);
  if (!body) return null;
  const author = textAt(tweet, [["author", "name"], ["user", "name"], ["core", "user_results", "result", "legacy", "name"]]);
  return {
    title: author ? `${author} on X` : excerpt(body, 100),
    description: excerpt(body),
    body,
    author,
    resolvedUrl: url,
    engagement: engagement([
      ["likes", numberAt(tweet, [["like_count"], ["favorite_count"], ["legacy", "favorite_count"]])],
      ["replies", numberAt(tweet, [["reply_count"], ["legacy", "reply_count"]])],
      ["reposts", numberAt(tweet, [["retweet_count"], ["legacy", "retweet_count"]])],
      ["views", numberAt(tweet, [["view_count"], ["views", "count"]])],
    ]),
    extractor: "scrapecreators.x.v1-twitter-tweet",
  };
}

function normalizeWeb(payload, url) {
  const result = Array.isArray(payload.results) ? asObject(payload.results[0]) : {};
  const body = textAt(result, [["text"]]);
  if (!body) return null;
  return {
    title: textAt(result, [["title"]]) || new URL(url).hostname,
    description: excerpt(body),
    body,
    author: textAt(result, [["author"]]),
    resolvedUrl: textAt(result, [["url"]]) || url,
    engagement: "",
    extractor: "exa.web.contents.get",
  };
}

function normalizeXArticle(output, fallback, url) {
  const match = output.match(/=== Article Content ===\s*\n([\s\S]*?)\n=== End Article ===/);
  const body = match?.[1]?.trim() || "";
  if (!body) return null;
  const author = output.match(/^@([^\s]+)/m)?.[1];
  return {
    title: body.split("\n").map((line) => line.trim()).find(Boolean) || "X Article",
    description: excerpt(body),
    body,
    author: fallback.author || (author ? `@${author}` : ""),
    resolvedUrl: url,
    engagement: fallback.engagement,
    extractor: "x-twitter.article",
  };
}

function normalize(plan, payload, url) {
  if (plan.endpoint === "treg.linkedin.post.detail") return normalizeLinkedIn(payload, url);
  if (plan.endpoint === "scrapecreators.tiktok.video.detail") return normalizeTikTok(payload, url);
  if (plan.endpoint === "scrapecreators.x.v1-twitter-tweet") return normalizeX(payload, url);
  return normalizeWeb(payload, url);
}

function enrichmentRecord(context, acquiredAt) {
  const metadata = [
    "---",
    `title: ${JSON.stringify(context.title)}`,
    `description: ${JSON.stringify(context.description)}`,
    `resolved_url: ${JSON.stringify(context.resolvedUrl)}`,
    `extractor: ${JSON.stringify(context.extractor)}`,
    `acquired_at: ${JSON.stringify(acquiredAt)}`,
  ];
  if (context.author) metadata.push(`author: ${JSON.stringify(context.author)}`);
  if (context.engagement) metadata.push(`engagement: ${JSON.stringify(context.engagement)}`);
  metadata.push("---", "", `# ${context.title}`, "", context.body, "");
  return metadata.join("\n");
}

async function defaultRunTreg(endpoint, args) {
  const { stdout } = await execFileAsync(process.env.TREG_BIN || DEFAULT_TREG_BIN, ["call", endpoint, ...args], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function defaultRunXArticle(tweetId) {
  const { stdout } = await execFileAsync(process.env.X_SEARCH_BIN || DEFAULT_X_SEARCH_BIN, ["article", tweetId], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function defaultResolveUrl(url) {
  if (new URL(url).hostname.toLowerCase() !== "lnkd.in") return url;
  const response = await fetch(url, {
    method: "HEAD",
    redirect: "follow",
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`LinkedIn short link returned ${response.status}`);
  return response.url;
}

async function enrichCapture({ captureDir, id, runTreg = defaultRunTreg, runXArticle = defaultRunXArticle, resolveUrl = defaultResolveUrl, now = () => new Date() }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) || id.includes("..")) throw new Error("Invalid capture id");
  const bundle = path.join(captureDir, id);
  const enrichedPath = path.join(bundle, "enriched.md");
  try {
    await fs.access(enrichedPath);
    return { status: "available", extractor: "existing", path: `${id}/enriched.md` };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const capture = fields(await fs.readFile(path.join(bundle, "capture.md"), "utf8"));
  const url = typeof capture.url === "string" ? capture.url : "";
  if (!url) throw new Error("Capture has no public URL");
  const resolvedUrl = await resolveUrl(url);
  const plan = enrichmentPlan(resolvedUrl);
  const payload = await runTreg(plan.endpoint, plan.args);
  let context = normalize(plan, payload, resolvedUrl);
  if (plan.endpoint === "scrapecreators.x.v1-twitter-tweet" && /^https:\/\/t\.co\/\S+$/.test(context?.body?.trim() || "")) {
    const tweetId = new URL(resolvedUrl).pathname.match(/\/status\/(\d+)/)?.[1];
    if (!tweetId) throw new Error("X Article wrapper has no tweet id");
    context = normalizeXArticle(await runXArticle(tweetId), context, resolvedUrl);
  }
  if (!context?.body) throw new Error("No public source context was returned");
  await fs.writeFile(enrichedPath, enrichmentRecord(context, now().toISOString()), { flag: "wx", mode: 0o600 });
  return { status: "enriched", extractor: context.extractor, path: `${id}/enriched.md` };
}

async function main() {
  const id = process.argv[2];
  if (!id || process.argv.length !== 3) throw new Error("Usage: enrich.js <capture-id>");
  const receipt = await enrichCapture({ captureDir: process.env.CAPTURE_DIR || DEFAULT_CAPTURE_DIR, id });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { enrichCapture, enrichmentPlan };
