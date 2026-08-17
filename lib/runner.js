// Orchestrates one full run: for the configured brand + every search term, query
// all five engines N times each (sampling, to average out the non-determinism of
// AI answers) and store the RAW answers. Leaderboards are derived from these at
// read time (see board.js), so curation applies without re-scanning.
import { ENGINE_IDS, ENGINES } from "./engines.js";
import { queryEngine } from "./searchapi.js";
import { registrableDomain } from "./scoring.js";
import { discoverFromAnswers, normalizeBrand } from "./brands.js";
import { effectiveDenylist } from "./denylist.js";
import * as store from "./store.js";

function runId(ts) {
  return "run_" + ts.replace(/[-:.TZ]/g, "").slice(0, 14);
}

// Query all five engines `samples` times for one term. Every (engine, sample) is
// an independent call; individual failures are tolerated and recorded.
async function fetchTerm(term, apiKey, samples) {
  const tasks = [];
  for (const engine of ENGINE_IDS)
    for (let s = 0; s < samples; s++) tasks.push({ engine, sample: s });

  const settled = await Promise.allSettled(tasks.map((t) => queryEngine(t.engine, term, apiKey)));

  const answers = []; // lean: { engine, sample, text, references }
  const raw = []; // heavy: { engine, sample, raw }
  const errors = [];
  settled.forEach((r, i) => {
    const t = tasks[i];
    if (r.status === "fulfilled") {
      answers.push({ engine: t.engine, sample: t.sample, text: r.value.text, references: r.value.references });
      raw.push({ engine: t.engine, sample: t.sample, raw: r.value.raw });
    } else {
      errors.push({ engine: t.engine, sample: t.sample, error: String(r.reason?.message || r.reason) });
    }
  });
  return { answers, raw, errors };
}

export async function runAll({ apiKey, nowISO }) {
  const cfg = store.getConfig();
  if (!cfg.brand || !cfg.brand.name) throw new Error("No brand configured.");
  if (!cfg.terms || !cfg.terms.length) throw new Error("No search terms configured.");

  const ourBrand = normalizeBrand({ ...cfg.brand, isOurBrand: true });
  const samples = Math.max(1, Math.min(5, Number(cfg.samples) || 3));
  const registry = store.getRegistry();
  const denylist = effectiveDenylist();
  const isDenied = (d) => denylist.has(registrableDomain(d));

  const run = { id: runId(nowISO), timestamp: nowISO, brand: ourBrand, engines: ENGINES, samples, terms: {} };
  const rawStore = { id: run.id, timestamp: nowISO, samples, terms: {} };

  for (const term of cfg.terms) {
    const { answers, raw, errors } = await fetchTerm(term, apiKey, samples);
    discoverFromAnswers(registry, term, answers, ourBrand, isDenied);
    run.terms[term] = {
      term,
      answers,
      answeredEngines: [...new Set(answers.map((a) => a.engine))],
      errors,
      samples,
    };
    rawStore.terms[term] = { answers: raw };
  }

  store.setRegistry(registry);
  store.saveRun(run);
  store.saveRawResponses(run.id, rawStore);
  return run;
}
