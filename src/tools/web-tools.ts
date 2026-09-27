/**
 * Web tools: WebFetch (readable-text extraction, zero-dep) and WebSearch
 * (DuckDuckGo HTML endpoint by default; Brave/Tavily when an API key exists).
 */
import type { ToolDef, ToolResult } from "./types.js";
import { str, num } from "./types.js";
import { scrubSecrets } from "../safety/safety.js";
import { truncate } from "../util.js";

const UA = "Mozilla/5.0 (compatible; ZCodeUltra/1.0; +https://github.com/zai-org/ZCode-Ultra)";

/** Crude but effective HTML -> text extraction (no external deps). */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|p|div|h[1-6]|li|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const WebFetchTool: ToolDef = {
  name: "WebFetch",
  description:
    "Fetch a URL and return its main textual content (HTML converted to text). " +
    "Use for documentation pages, articles, raw files (raw.githubusercontent.com) and APIs returning JSON.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch (http/https)" },
      max_chars: { type: "number", description: "Max characters to return (default 20000)" },
    },
    required: ["url"],
  },
  async execute(input): Promise<ToolResult> {
    const url = str(input, "url");
    const maxChars = num(input, "max_chars", 20_000);
    if (!/^https?:\/\//i.test(url)) return { output: "Error: only http/https URLs are supported", isError: true };
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,application/json,text/plain,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      const ctype = res.headers.get("content-type") ?? "";
      const body = await res.text();
      if (!res.ok) return { output: `Error: HTTP ${res.status} for ${url}\n${truncate(body, 500)}`, isError: true };
      const text = ctype.includes("html") ? htmlToText(body) : body;
      return { output: scrubSecrets(`URL: ${url}\nContent-Type: ${ctype}\n\n${truncate(text, maxChars, "\n… (truncated)")}`) };
    } catch (e) {
      return { output: `Error fetching ${url}: ${(e as Error).message}`, isError: true };
    }
  },
};

export const WebSearchTool: ToolDef = {
  name: "WebSearch",
  description:
    "Search the web. Uses Brave Search if BRAVE_API_KEY is set, Tavily if TAVILY_API_KEY is set, " +
    "otherwise the DuckDuckGo HTML endpoint (no key required). Returns titles, URLs and snippets.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      max_results: { type: "number", description: "Max results (default 8)" },
    },
    required: ["query"],
  },
  async execute(input): Promise<ToolResult> {
    const query = str(input, "query");
    const max = num(input, "max_results", 8);

    const brave = process.env.BRAVE_API_KEY;
    if (brave) {
      try {
        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`, {
          headers: { "X-Subscription-Token": brave, Accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
        const json: any = await res.json();
        const items = (json.web?.results ?? []).slice(0, max).map((r: any) => `${r.title}\n  ${r.url}\n  ${r.description ?? ""}`);
        return { output: items.join("\n\n") || "No results." };
      } catch (e) {
        return { output: `Error (brave): ${(e as Error).message}`, isError: true };
      }
    }

    const tavily = process.env.TAVILY_API_KEY;
    if (tavily) {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${tavily}` },
          body: JSON.stringify({ query, max_results: max }),
          signal: AbortSignal.timeout(20_000),
        });
        const json: any = await res.json();
        const items = (json.results ?? []).map((r: any) => `${r.title}\n  ${r.url}\n  ${r.content ?? ""}`);
        return { output: items.join("\n\n") || "No results." };
      } catch (e) {
        return { output: `Error (tavily): ${(e as Error).message}`, isError: true };
      }
    }

    // DuckDuckGo HTML fallback (keyless)
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(20_000),
      });
      const html = await res.text();
      const results: string[] = [];
      const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(html)) && results.length < max) {
        let href = m[1];
        const uddg = /uddg=([^&]+)/.exec(href);
        if (uddg) href = decodeURIComponent(uddg[1]);
        const title = m[2].replace(/<[^>]+>/g, "").trim();
        const snippet = (m[3] ?? "").replace(/<[^>]+>/g, "").trim();
        results.push(`${title}\n  ${href}\n  ${truncate(snippet, 200)}`);
      }
      if (results.length === 0) return { output: "No results (DuckDuckGo may be rate-limiting; set BRAVE_API_KEY or TAVILY_API_KEY for reliability)." };
      return { output: results.join("\n\n") };
    } catch (e) {
      return { output: `Error (duckduckgo): ${(e as Error).message}`, isError: true };
    }
  },
};
