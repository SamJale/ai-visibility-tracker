// The five AI answer engines we track, as exposed by SearchApi.io.
// Every one of these engines returns the same shape we care about:
//   - `markdown`         : the full answer text
//   - `reference_links[]`: cited sources, each with `.link` (url) and `.source` (domain)
// which is what makes deterministic mention/citation detection uniform across all of them.
export const ENGINES = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "perplexity", label: "Perplexity" },
  { id: "gemini", label: "Gemini" },
  { id: "bing_copilot", label: "Copilot" },
  { id: "google_ai_mode", label: "Google AI Mode" },
];

export const ENGINE_IDS = ENGINES.map((e) => e.id);
export const ENGINE_LABEL = Object.fromEntries(ENGINES.map((e) => [e.id, e.label]));
