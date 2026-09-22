const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { enrichCapture, enrichmentPlan } = require("../enrich.js");

async function fixture(url) {
  const root = await mkdtemp(path.join(tmpdir(), "drop-enrich-test-"));
  const id = "2026-09-22-capture-lnkd-in";
  await mkdir(path.join(root, id));
  await writeFile(
    path.join(root, id, "capture.md"),
    `---\ntitle: "lnkd.in"\ncaptured_at: "2026-09-22T01:21:07.867Z"\nurl: ${JSON.stringify(url)}\n---\n`,
  );
  return { root, id };
}

test("selects bounded platform acquisition instead of hand-written scraping", () => {
  assert.deepEqual(enrichmentPlan("https://lnkd.in/p/example"), {
    endpoint: "treg.linkedin.post.detail",
    args: ["--method", "POST", "--data", JSON.stringify({ url: "https://lnkd.in/p/example" }), "--header", "X-Treg-Route-Max-Cost: 0.005"],
  });
  assert.equal(enrichmentPlan("https://www.tiktok.com/t/example").endpoint, "scrapecreators.tiktok.video.detail");
  assert.equal(enrichmentPlan("https://x.com/example/status/1").endpoint, "scrapecreators.x.v1-twitter-tweet");
  assert.equal(enrichmentPlan("https://example.com/article").endpoint, "exa.web.contents.get");
});

test("writes one source-derived enrichment sidecar and preserves the raw capture", async () => {
  const { root, id } = await fixture("https://lnkd.in/p/example");
  const calls = [];
  const runTreg = async (endpoint, args) => {
    calls.push({ endpoint, args });
    return {
      output: {
        post: { id: "post-1" },
        title: "Employers are building care infrastructure",
        text: "A coalition of employers will test a caregiver support model in three regions.",
        likes: 42,
        comments: 7,
      },
      _treg: { served_by: "tikhub.x.linkedin-web-v2-get-post-detail" },
    };
  };

  try {
    const receipt = await enrichCapture({
      captureDir: root,
      id,
      runTreg,
      now: () => new Date("2026-09-22T12:00:00Z"),
    });

    assert.deepEqual(receipt, {
      status: "enriched",
      extractor: "tikhub.x.linkedin-web-v2-get-post-detail",
      path: `${id}/enriched.md`,
    });
    assert.equal(calls.length, 1);
    const enriched = await readFile(path.join(root, id, "enriched.md"), "utf8");
    assert.match(enriched, /title: "Employers are building care infrastructure"/);
    assert.match(enriched, /description: "A coalition of employers will test a caregiver support model in three regions\."/);
    assert.match(enriched, /engagement: "42 likes · 7 comments"/);
    assert.match(enriched, /extractor: "tikhub\.x\.linkedin-web-v2-get-post-detail"/);
    assert.match(enriched, /A coalition of employers will test a caregiver support model/);
    assert.doesNotMatch(await readFile(path.join(root, id, "capture.md"), "utf8"), /Employers are building/);

    const duplicate = await enrichCapture({ captureDir: root, id, runTreg });
    assert.equal(duplicate.status, "available");
    assert.equal(calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails without writing a misleading empty enrichment", async () => {
  const { root, id } = await fixture("https://lnkd.in/p/missing");
  try {
    await assert.rejects(
      enrichCapture({ captureDir: root, id, runTreg: async () => ({ output: { post: null } }) }),
      /No public source context was returned/,
    );
    await assert.rejects(readFile(path.join(root, id, "enriched.md"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
