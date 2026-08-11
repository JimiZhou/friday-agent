import assert from "node:assert/strict";
import test from "node:test";

import { FixedWebSearch, parseDuckDuckGoHtml } from "../apps/fridayd/dist/web-search.js";

const html = `
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpi%23old">Pi &amp; Friday</a>
  <a class="result__snippet">Latest <b>Pi</b> release notes.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="http://insecure.example/path">Insecure</a>
  <div class="result__snippet">Must be rejected.</div>
</div>`;

test("fixed web search uses one HTTPS origin without credentials and labels parsed results untrusted", async () => {
  const calls = [];
  const search = new FixedWebSearch(async (url, init) => {
    calls.push({ url: url.toString(), init });
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  });
  const result = await search.search("  Pi   agent latest  ");
  assert.equal(calls.length, 1);
  const endpoint = new URL(calls[0].url);
  assert.equal(endpoint.origin, "https://html.duckduckgo.com");
  assert.equal(endpoint.pathname, "/html/");
  assert.equal(endpoint.searchParams.get("q"), "Pi agent latest");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(Object.hasOwn(calls[0].init.headers, "authorization"), false);
  assert.equal(Object.hasOwn(calls[0].init.headers, "cookie"), false);
  assert.equal(result.trust, "untrusted");
  assert.deepEqual(result.results, [{ title: "Pi & Friday", url: "https://example.com/pi", snippet: "Latest Pi release notes." }]);
});

test("web search parser rejects insecure links and bounds provider responses", async () => {
  assert.equal(parseDuckDuckGoHtml(html).length, 1);
  assert.throws(() => parseDuckDuckGoHtml("x".repeat(512 * 1024 + 1)), /invalid/);
  const oversized = new FixedWebSearch(async () => new Response("small", {
    status: 200,
    headers: { "content-type": "text/html", "content-length": String(512 * 1024 + 1) },
  }));
  await assert.rejects(() => oversized.search("pi"), /too large/);
  await assert.rejects(() => oversized.search(""), /INVALID_QUERY/);
});
