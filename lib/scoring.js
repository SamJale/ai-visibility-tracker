// Deterministic detection + scoring. No LLM judges anywhere in this file.
//
// A brand is MENTIONED in an answer when one of its names/aliases appears in the
// answer text on a word boundary (after citation link URLs are stripped, so a
// domain sitting inside a citation url is never mistaken for a prose mention).
//
// A brand is CITED in an answer when one of the sources the engine links resolves
// to the brand's own registrable domain.
//
// AI Visibility Score (0-100):
//   score = 100 * (0.70*mention_rate + 0.15*citation_rate + 0.15*position_factor)
// where the three components are measured across the set of engine answers for a
// single search term (one answer per engine).

import { ENGINE_IDS } from "./engines.js";

const WEIGHTS = { mention: 0.7, citation: 0.15, position: 0.15 };

// ---- domain handling -------------------------------------------------------

// A tiny set of common multi-part public suffixes so "shop.example.co.uk" and
// "example.co.uk" both reduce to "example.co.uk". Not exhaustive, but covers the
// cases that actually show up in citations.
const MULTI_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "co.in", "com.au",
  "com.br", "co.nz", "co.za", "com.mx", "co.kr", "com.tr",
]);

export function registrableDomain(input) {
  if (!input) return "";
  let host = String(input).trim().toLowerCase();
  // strip protocol + path if a full url was passed
  host = host.replace(/^[a-z]+:\/\//, "").split("/")[0].split("?")[0].split("#")[0];
  host = host.replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

// Turn a domain into a human-ish brand name guess: "serpapi.com" -> "Serpapi".
export function domainToName(domain) {
  const reg = registrableDomain(domain);
  const core = reg.split(".")[0] || reg;
  return core
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ---- text handling ---------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Remove citation link URLs before scanning for prose mentions. We keep the
// visible anchor text of a markdown link (that IS the engine naming the brand),
// but drop the url, bare urls, and bracketed numeric reference markers so raw
// domain strings can never count as a text mention.
export function stripCitations(text) {
  return String(text || "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [anchor](url) -> anchor
    .replace(/https?:\/\/\S+/gi, " ") // bare urls
    .replace(/\b[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?\b/gi, " ") // bare domains
    .replace(/\[\d+\]/g, " ") // [1] style refs
    .replace(/[（(]\s*\d+\s*[)）]/g, " "); // (1) style refs
}

// First character index at which the brand is named, or -1. Matches any alias on
// a word boundary, case-insensitive.
export function firstMentionIndex(brand, cleanText) {
  let best = -1;
  for (const alias of brand.aliases || [brand.name]) {
    if (!alias) continue;
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escapeRegExp(alias)})(?![\\p{L}\\p{N}])`, "iu");
    const m = re.exec(cleanText);
    if (m) {
      const idx = m.index + m[0].indexOf(m[1]);
      if (best === -1 || idx < best) best = idx;
    }
  }
  return best;
}

// Canonical domain of a cited source. Prefer the real link URL over the `source`
// display label so "SerpApi" (a label) and "serpapi.com" (the link) don't diverge.
export function refDomain(ref) {
  const fromLink = registrableDomain(ref.link || "");
  if (fromLink && fromLink.includes(".")) return fromLink;
  const fromSource = registrableDomain(ref.source || "");
  if (fromSource && fromSource.includes(".")) return fromSource;
  return "";
}

export function isCited(brand, references) {
  const target = registrableDomain(brand.domain);
  if (!target) return false;
  return references.some((r) => refDomain(r) === target);
}

// ---- per-answer analysis ---------------------------------------------------

// Everything here is keyed by the brand's registrable DOMAIN, never its display
// name — otherwise two different companies that share a name (e.g. serpapi.com and
// serpapi.cc, both auto-named "Serpapi") would overwrite each other's cells and
// share a score.
//
// `collisions` maps a shared lower-cased name to { domains:Set, primaryDomain } so
// a bare text mention of that name (which is genuinely ambiguous — the prose just
// says "SerpApi") is credited to exactly ONE brand: the one whose domain is cited
// in that same answer, or else the primary (most-cited overall) for that name.
export function analyzeAnswer(answer, brands, collisions = new Map()) {
  const clean = stripCitations(answer.text);
  const raw = brands.map((b) => ({
    dom: registrableDomain(b.domain),
    name: (b.name || "").trim().toLowerCase(),
    idx: firstMentionIndex(b, clean),
    cited: isCited(b, answer.references || []),
  }));
  const citedDomains = new Set(raw.filter((r) => r.cited).map((r) => r.dom));

  // decide who owns each (possibly ambiguous) mention
  const mentioned = new Map(); // domain -> bool
  for (const r of raw) {
    if (r.idx === -1) { mentioned.set(r.dom, false); continue; }
    const col = collisions.get(r.name);
    if (!col) { mentioned.set(r.dom, true); continue; } // unique name — unambiguous
    const citedInGroup = [...col.domains].filter((d) => citedDomains.has(d));
    const owner = citedInGroup.length === 1 ? citedInGroup[0] : col.primaryDomain;
    mentioned.set(r.dom, r.dom === owner);
  }

  // rank owned mentions by first appearance
  const order = raw
    .filter((r) => mentioned.get(r.dom))
    .sort((a, b) => a.idx - b.idx);
  const position = {};
  order.forEach((r, i) => { position[r.dom] = i + 1; });

  const byDomain = {};
  for (const r of raw) {
    byDomain[r.dom] = {
      mentioned: !!mentioned.get(r.dom),
      cited: r.cited,
      position: position[r.dom] || null,
    };
  }
  return { engine: answer.engine, byDomain };
}

// Prefer more common TLDs when breaking ties for the "primary" brand of a name.
function tldRank(domain) {
  const tld = domain.split(".").slice(1).join(".");
  const order = { com: 0, io: 1, co: 2, ai: 3, net: 4, org: 5, dev: 6, app: 7 };
  return tld in order ? order[tld] : 9;
}

// Find brands that share a display name but sit on different domains, and choose a
// primary for each collision: our own brand first, then the most-cited across the
// run (the real company gets linked more), then a common-TLD / alphabetical tiebreak.
function buildCollisions(answers, brands) {
  const groups = new Map(); // nameKey -> [{dom, isOur, brand}]
  for (const b of brands) {
    const key = (b.name || "").trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ dom: registrableDomain(b.domain), isOur: !!b.isOurBrand, brand: b });
  }
  const collisions = new Map();
  for (const [key, arr] of groups) {
    if (arr.length < 2) continue;
    const cite = new Map();
    for (const x of arr) {
      let c = 0;
      for (const a of answers) if (isCited(x.brand, a.references || [])) c++;
      cite.set(x.dom, c);
    }
    const primary = [...arr].sort(
      (x, y) =>
        Number(y.isOur) - Number(x.isOur) ||
        (cite.get(y.dom) || 0) - (cite.get(x.dom) || 0) ||
        tldRank(x.dom) - tldRank(y.dom) ||
        x.dom.localeCompare(y.dom)
    )[0];
    collisions.set(key, { domains: new Set(arr.map((x) => x.dom)), primaryDomain: primary.dom });
  }
  return collisions;
}

// ---- leaderboard for one search term ---------------------------------------

// answers: [{engine, sample, text, references}] — MANY per engine when sampling.
// brands:  [{name, domain, aliases}]     brands to SCORE against — includes our
//          brand plus the global brand log, so a competitor discovered on another
//          term is still detected here if it's named in prose.
// prevLeaderboard: array from the previous run (for movement), or null.
// keepDomains: Set of registrable domains that belong to THIS term's own log and
//          should stay on the board even at 0/0. Brands outside it that never show
//          for this term (0 mentions, 0 citations, not our brand) are dropped, so
//          the board stays about this term instead of listing every brand ever seen.
//
// Sampling model: each engine is queried N times to average out the randomness of
// AI answers. We aggregate WITHIN each engine first (rate = share of that engine's
// samples), then average ACROSS the engines that answered. So an engine that named
// a brand in 2 of 3 samples contributes 0.67, and every engine carries equal weight
// regardless of how many samples it returned.
export function buildLeaderboard(answers, brands, prevLeaderboard, keepDomains = null) {
  // Detect same-name / different-domain collisions and pick a "primary" brand for
  // each shared name, so an ambiguous bare mention isn't credited to all of them.
  const collisions = buildCollisions(answers, brands);
  const analyses = answers.map((a) => analyzeAnswer(a, brands, collisions));

  // group the per-sample analyses by engine
  const byEngine = new Map();
  for (const an of analyses) {
    if (!byEngine.has(an.engine)) byEngine.set(an.engine, []);
    byEngine.get(an.engine).push(an);
  }
  const engineIds = [...byEngine.keys()];
  const E = engineIds.length || 1;

  // total mention instances across every sample, for share of voice
  let totalMentions = 0;
  for (const an of analyses)
    for (const dom in an.byDomain) if (an.byDomain[dom].mentioned) totalMentions++;

  const rows = brands.map((brand) => {
    const brandDom = registrableDomain(brand.domain);
    let sumMentionRate = 0;
    let sumCiteRate = 0;
    const posFactors = []; // one per engine that mentions the brand
    let enginesNamed = 0; // engines (0..5) that named the brand at least once
    let enginesCited = 0; // engines (0..5) that cited at least once
    let mentionInstances = 0; // across all samples, for SOV + tie-break
    const engines = {};

    for (const engineId of engineIds) {
      const samples = byEngine.get(engineId);
      const S = samples.length || 1;
      let m = 0;
      let c = 0;
      const invs = [];
      for (const an of samples) {
        const cell = an.byDomain[brandDom] || { mentioned: false, cited: false, position: null };
        if (cell.mentioned) {
          m++;
          mentionInstances++;
          if (cell.position) invs.push(1 / cell.position);
        }
        if (cell.cited) c++;
      }
      const engineMentionRate = m / S;
      const engineCiteRate = c / S;
      const enginePosFactor = invs.length ? invs.reduce((a, b) => a + b, 0) / invs.length : 0;
      sumMentionRate += engineMentionRate;
      sumCiteRate += engineCiteRate;
      if (m > 0) {
        enginesNamed++;
        posFactors.push(enginePosFactor);
      }
      if (c > 0) enginesCited++;

      engines[engineId] = {
        mentioned: m > 0,
        cited: c > 0,
        mentionRate: round(engineMentionRate * 100, 0), // % of this engine's samples
        citeRate: round(engineCiteRate * 100, 0),
        samples: S,
      };
    }

    const mention_rate = sumMentionRate / E;
    const citation_rate = sumCiteRate / E;
    const position_factor = posFactors.length
      ? posFactors.reduce((a, b) => a + b, 0) / posFactors.length
      : 0;
    const score =
      100 *
      (WEIGHTS.mention * mention_rate +
        WEIGHTS.citation * citation_rate +
        WEIGHTS.position * position_factor);
    const sov = totalMentions ? mentionInstances / totalMentions : 0;

    return {
      name: brand.name,
      domain: brand.domain,
      isOurBrand: !!brand.isOurBrand,
      score: round(score, 1),
      sov: round(sov * 100, 1), // percentage
      mentions: mentionInstances,
      enginesNamed, // engines (of those answered) that named it
      citations: enginesCited, // engines (of those answered) that cited it
      mention_rate: round(mention_rate * 100, 1),
      citation_rate: round(citation_rate * 100, 1),
      position_factor: round(position_factor, 3),
      engines,
    };
  });

  // drop cross-term brands that never showed here (kept only for detection)
  const visible = keepDomains
    ? rows.filter(
        (r) =>
          r.isOurBrand ||
          r.mentions > 0 ||
          r.citations > 0 ||
          keepDomains.has(registrableDomain(r.domain))
      )
    : rows;

  // rank: highest score first; stable tie-break by mentions then name
  visible.sort(
    (a, b) => b.score - a.score || b.mentions - a.mentions || a.name.localeCompare(b.name)
  );

  const prevPos = {};
  if (prevLeaderboard) prevLeaderboard.forEach((r) => (prevPos[r.name] = r.position));

  visible.forEach((r, i) => {
    r.position = i + 1;
    if (!(r.name in prevPos)) r.movement = null; // new to the board
    else r.movement = prevPos[r.name] - r.position; // + = climbed
  });

  return visible;
}

function round(n, dp) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

export { ENGINE_IDS };
