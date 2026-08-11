const SEARCH_ENDPOINT = new URL("https://html.duckduckgo.com/html/");
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESULTS = 6;

export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebSearchResult {
  readonly trust: "untrusted";
  readonly source: "duckduckgo-html";
  readonly query: string;
  readonly results: readonly WebSearchHit[];
}

/**
 * A deliberately small search tool: one fixed HTTPS origin, no redirects,
 * cookies, secrets, arbitrary URL fetch, or model-controlled headers.
 */
export class FixedWebSearch {
  readonly #fetch: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.#fetch = fetchImpl;
  }

  async search(query: string): Promise<WebSearchResult> {
    const normalized = requireQuery(query);
    const endpoint = new URL(SEARCH_ENDPOINT);
    endpoint.searchParams.set("q", normalized);
    const response = await this.#fetch(endpoint, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      headers: {
        accept: "text/html",
        "user-agent": "Friday-Agent/0.1 (+private-owner-search)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("WEB_SEARCH_FAILED: provider returned " + response.status);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^text\/html(?:;|$)/i.test(contentType)) throw new Error("WEB_SEARCH_FAILED: provider returned non-HTML content");
    const html = await boundedText(response, MAX_RESPONSE_BYTES);
    return { trust: "untrusted", source: "duckduckgo-html", query: normalized, results: parseDuckDuckGoHtml(html) };
  }
}

export function parseDuckDuckGoHtml(html: string): readonly WebSearchHit[] {
  if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Web search response is invalid");
  const hits: WebSearchHit[] = [];
  const resultPattern = /<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>|<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>)([\s\S]*?)<\/(?:a|div)>/gi;
  for (const match of html.matchAll(resultPattern)) {
    const rawUrl = decodeEntities(match[1] ?? "");
    const url = normalizeResultUrl(rawUrl);
    const title = cleanText(match[2] ?? "");
    const snippet = cleanText(match[3] ?? "");
    if (url === undefined || title === "") continue;
    hits.push({ title: truncate(title, 240), url, snippet: truncate(snippet, 600) });
    if (hits.length >= MAX_RESULTS) break;
  }
  return hits;
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("WEB_SEARCH_FAILED: provider response is too large");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("WEB_SEARCH_FAILED: provider response is too large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function requireQuery(value: string): string {
  if (typeof value !== "string") throw new Error("WEB_SEARCH_INVALID_QUERY");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized === "" || Buffer.byteLength(normalized, "utf8") > 512 || normalized.includes("\0")) {
    throw new Error("WEB_SEARCH_INVALID_QUERY");
  }
  return normalized;
}

function normalizeResultUrl(value: string): string | undefined {
  let candidate = value;
  try {
    const wrapped = new URL(value, "https://duckduckgo.com");
    if (wrapped.hostname === "duckduckgo.com" && wrapped.pathname === "/l/") {
      candidate = wrapped.searchParams.get("uddg") ?? "";
    } else {
      candidate = wrapped.toString();
    }
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function cleanText(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexadecimal: string) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)));
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum - 1) + "…";
}
