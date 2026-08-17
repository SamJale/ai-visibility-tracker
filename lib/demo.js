// Seeds two fake runs so you can see the UI without spending API credits.
//   npm run seed:demo
// Fabricates realistic RAW engine answers (multi-paragraph, 3 samples per engine)
// and derives the board from them exactly like a real run. Citations deliberately
// include a bare "SerpApi" label (to prove dedup), noise domains like reddit.com /
// aimultiple.com (to prove the denylist), and ScraperAPI is named in prose but
// never cited (to show why a brand can be missing until you add it).
import { registrableDomain } from "./scoring.js";
import { discoverFromAnswers, normalizeBrand } from "./brands.js";
import { effectiveDenylist } from "./denylist.js";
import { ENGINES } from "./engines.js";
import * as store from "./store.js";

const SAMPLES = 3;
const ourBrand = normalizeBrand({ name: "SearchApi", domain: "searchapi.io", isOurBrand: true });

const CATALOG = {
  "best serp api": [
    { name: "SerpApi", domain: "serpapi.com" },
    { name: "SearchApi", domain: "searchapi.io" },
    { name: "DataForSEO", domain: "dataforseo.com" },
    { name: "Bright Data", domain: "brightdata.com" },
    { name: "Zenserp", domain: "zenserp.com" },
    { name: "ScraperAPI", domain: "scraperapi.com" },
  ],
  "google search api": [
    { name: "SerpApi", domain: "serpapi.com" },
    { name: "SearchApi", domain: "searchapi.io" },
    { name: "DataForSEO", domain: "dataforseo.com" },
    { name: "Oxylabs", domain: "oxylabs.io" },
  ],
};

const NOISE = ["reddit.com", "aimultiple.com", "youtube.com", "g2.com"];

let seed = 42;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function paragraph(named) {
  const intro =
    "When developers compare SERP APIs, a handful of providers come up repeatedly. Here's how they stack up on coverage, reliability, and price.";
  const lines = named.map(
    (b) =>
      `**${b.name}** is frequently recommended for its structured JSON output and broad engine coverage, and teams cite its documentation as a reason it's easy to integrate.`
  );
  const outro =
    "Ultimately the right choice depends on the engines you need, your request volume, and how much you value support and uptime guarantees.";
  return [intro, ...lines, outro].join("\n\n");
}

function makeAnswer(engine, sample, brands, drift) {
  const named = brands.filter((b, i) => rnd() < [0.95, 0.85, 0.7, 0.5, 0.4, 0.3][i] + drift);
  const ordered = named.sort((a, b) => brands.indexOf(a) - brands.indexOf(b) + (rnd() - 0.5));
  const text = paragraph(ordered);

  const reference_links = [];
  ordered.forEach((b, i) => {
    if (b.name === "ScraperAPI") return; // named in prose, never cited
    if (rnd() < 0.4) {
      if (rnd() < 0.3) reference_links.push({ title: b.name, link: "", source: b.name });
      else reference_links.push({ title: `${b.name} docs`, link: `https://${b.domain}/docs`, source: b.domain });
    }
  });
  for (const n of NOISE) if (rnd() < 0.5) reference_links.push({ title: n, link: `https://${n}/thread`, source: n });

  // shape mirrors a real SearchApi response closely enough for the JSON view
  const raw = {
    search_metadata: { engine, status: "Success", q_note: "request was { engine, q }" },
    markdown: text,
    reference_links,
  };
  return {
    lean: { engine, sample, text, references: reference_links.map((r) => ({ link: r.link || "", source: r.source || "" })) },
    raw: { engine, sample, raw },
  };
}

function buildRun(id, ts, registry, drift, isDenied) {
  const run = { id, timestamp: ts, brand: ourBrand, engines: ENGINES, samples: SAMPLES, terms: {} };
  const rawStore = { id, timestamp: ts, samples: SAMPLES, terms: {} };
  for (const term of Object.keys(CATALOG)) {
    const answers = [];
    const raws = [];
    for (const e of ENGINES)
      for (let s = 0; s < SAMPLES; s++) {
        const a = makeAnswer(e.id, s, CATALOG[term], drift);
        answers.push(a.lean);
        raws.push(a.raw);
      }
    discoverFromAnswers(registry, term, answers, ourBrand, isDenied);
    run.terms[term] = {
      term,
      answers,
      answeredEngines: [...new Set(answers.map((a) => a.engine))],
      errors: [],
      samples: SAMPLES,
    };
    rawStore.terms[term] = { answers: raws };
  }
  return { run, rawStore };
}

store.setConfig({ brand: ourBrand, terms: Object.keys(CATALOG), samples: SAMPLES });
store.setDenylist({ domains: [] });
const denylist = effectiveDenylist();
const isDenied = (d) => denylist.has(registrableDomain(d));

const registry = {};
for (const [id, ts, drift] of [
  ["run_demo000001", "2026-08-07T09:00:00.000Z", 0],
  ["run_demo000002", "2026-08-14T09:00:00.000Z", 0.05],
]) {
  const { run, rawStore } = buildRun(id, ts, registry, drift, isDenied);
  store.saveRun(run);
  store.saveRawResponses(id, rawStore);
}
store.setRegistry(registry);

console.log(`Seeded 2 demo runs (${SAMPLES} samples/engine) for:`, Object.keys(CATALOG).join(", "));
console.log("Start the server (npm start) and open http://localhost:4173");
