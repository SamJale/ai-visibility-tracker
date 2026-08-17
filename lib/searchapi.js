// Thin client for the SearchApi.io answer engines.
// One function: run a query against one engine, return the normalized answer.
import { ENGINE_LABEL } from "./engines.js";

const BASE = "https://www.searchapi.io/api/v1/search";

// Pull the answer text out of a SearchApi response. All AI engines expose
// `markdown`; some also expose `text_blocks[].answer`. We prefer markdown and
// fall back to stitching the text blocks together.
function extractText(json) {
  if (typeof json.markdown === "string" && json.markdown.trim()) return json.markdown;
  const blocks = Array.isArray(json.text_blocks) ? json.text_blocks : [];
  const parts = [];
  const walk = (b) => {
    if (!b || typeof b !== "object") return;
    if (typeof b.answer === "string") parts.push(b.answer);
    if (typeof b.text === "string") parts.push(b.text);
    if (Array.isArray(b.list)) b.list.forEach(walk);
    if (Array.isArray(b.items)) b.items.forEach(walk);
  };
  blocks.forEach(walk);
  return parts.join("\n");
}

// Normalize the cited sources. Every engine returns `reference_links` with a
// `.link` (full url) and usually a `.source` (bare domain).
function extractReferences(json) {
  const refs = Array.isArray(json.reference_links) ? json.reference_links : [];
  return refs
    .map((r) => ({ link: r.link || "", source: r.source || "" }))
    .filter((r) => r.link || r.source);
}

// Query a single engine. Returns { engine, text, references } or throws.
export async function queryEngine(engine, query, apiKey, { timeoutMs = 60000 } = {}) {
  const url = new URL(BASE);
  url.searchParams.set("engine", engine);
  url.searchParams.set("q", query);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error || body?.message || `HTTP ${res.status}`;
      throw new Error(`${ENGINE_LABEL[engine] || engine}: ${msg}`);
    }
    return {
      engine,
      text: extractText(body),
      references: extractReferences(body),
      raw: body, // full SearchApi response, kept so the UI can link to it
    };
  } finally {
    clearTimeout(timer);
  }
}
