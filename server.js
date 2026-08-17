// AI Visibility Tracker — local server.
// Serves the dashboard and exposes a small JSON API over the run engine.
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import * as store from "./lib/store.js";
import { runAll } from "./lib/runner.js";
import { queryEngine } from "./lib/searchapi.js";
import { ENGINES, ENGINE_LABEL } from "./lib/engines.js";
import { normalizeBrand } from "./lib/brands.js";
import { deriveSmoothedBoard, SMOOTH_WINDOW } from "./lib/board.js";
import { addDenied, removeDenied, userDenied, effectiveDenylist } from "./lib/denylist.js";
import { domainToName, registrableDomain, refDomain } from "./lib/scoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env (simple parser, no dependency) if present.
(function loadEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Key resolution: a key entered in the app wins (explicit user choice); an env
// var, if present, is a fallback default. Either way the app can always manage it.
const apiKey = () => store.getSettings().searchApiKey || process.env.SEARCHAPI_API_KEY || "";
const envKey = () => process.env.SEARCHAPI_API_KEY || "";

// ---- config ----------------------------------------------------------------
app.get("/api/config", (req, res) => {
  res.json({ ...store.getConfig(), hasApiKey: !!apiKey(), engines: ENGINES });
});

app.post("/api/config", (req, res) => {
  const { brand, terms, samples } = req.body || {};
  if (!brand || !brand.name || !brand.domain)
    return res.status(400).json({ error: "Brand needs a name and a domain." });
  const cleanTerms = [...new Set((terms || []).map((t) => String(t).trim()).filter(Boolean))];
  const s = Math.max(1, Math.min(5, Number(samples) || 3));
  const cfg = { brand: normalizeBrand({ ...brand, isOurBrand: true }), terms: cleanTerms, samples: s };
  store.setConfig(cfg);
  res.json(cfg);
});

// ---- settings (API key) ----------------------------------------------------
app.get("/api/settings", (req, res) => {
  const saved = store.getSettings().searchApiKey || "";
  const env = envKey();
  const active = saved || env;
  res.json({
    hasApiKey: !!active,
    last4: active ? active.slice(-4) : null,
    source: saved ? "saved" : env ? "env" : "none",
    envAvailable: !!env, // an env var exists as a fallback if the in-app key is cleared
  });
});

app.post("/api/settings", (req, res) => {
  const key = (req.body?.apiKey || "").trim();
  const s = store.getSettings();
  if (key) s.searchApiKey = key;
  else delete s.searchApiKey; // empty string clears the in-app key (falls back to env)
  store.setSettings(s);
  res.json({ ok: true, hasApiKey: !!apiKey() });
});

// Optional: verify the key with a single real request (costs 1 SearchApi credit).
app.post("/api/settings/test", async (req, res) => {
  if (!apiKey()) return res.status(400).json({ error: "No key set yet." });
  try {
    await queryEngine("chatgpt", "ping", apiKey(), { timeoutMs: 30000 });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- run -------------------------------------------------------------------
let running = false;
app.post("/api/run", async (req, res) => {
  if (!apiKey())
    return res.status(400).json({ error: "SEARCHAPI_API_KEY is not set. Add it to .env." });
  if (running) return res.status(409).json({ error: "A run is already in progress." });
  running = true;
  try {
    const run = await runAll({ apiKey: apiKey(), nowISO: new Date().toISOString() });
    res.json({ ok: true, runId: run.id, timestamp: run.timestamp });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    running = false;
  }
});

// ---- overview (main page) --------------------------------------------------
app.get("/api/overview", (req, res) => {
  const cfg = store.getConfig();
  const latest = store.latestRun();
  const registry = store.getRegistry();
  const runsMeta = store.listRuns();
  const runs = runsMeta.map((m) => store.getRun(m.id)).filter(Boolean);
  const ourBrand = cfg.brand ? normalizeBrand({ ...cfg.brand, isOurBrand: true }) : null;

  const cards = (cfg.terms || []).map((term) => {
    const t = latest?.terms?.[term];
    if (!t) return { term, hasData: false };
    const board = deriveSmoothedBoard(runs, term, registry, ourBrand) || [];
    const top = board[0] || null;
    const ours = board.find((r) => r.isOurBrand) || null;
    return {
      term,
      hasData: true,
      top: top ? { name: top.name, score: top.score } : null,
      our: ours
        ? { name: ours.name, position: ours.position, score: ours.score, movement: ours.movement }
        : null,
      brandCount: board.length,
      answeredEngines: t.answeredEngines?.length || 0,
      runsAveraged: board[0]?.runsAveraged || 0,
    };
  });
  res.json({
    brand: cfg.brand,
    engines: ENGINES,
    lastRun: latest?.timestamp || null,
    runCount: runs.length,
    smoothWindow: SMOOTH_WINDOW,
    cards,
  });
});

// ---- single term -----------------------------------------------------------
app.get("/api/term/:term", (req, res) => {
  const term = req.params.term;
  const cfg = store.getConfig();
  const registry = store.getRegistry();
  const ourBrand = cfg.brand ? normalizeBrand({ ...cfg.brand, isOurBrand: true }) : null;
  const runsMeta = store.listRuns();
  const runs = runsMeta.map((m) => store.getRun(m.id)).filter(Boolean);
  const latest = runs[runs.length - 1] || null;
  if (!latest?.terms?.[term]) return res.status(404).json({ error: "No data for this term yet." });

  const leaderboard = deriveSmoothedBoard(runs, term, registry, ourBrand) || [];

  // history: our position + score each run (derived, no movement needed)
  // Each point is the trailing-window average as of that run, so the trend line
  // matches the headline score instead of showing the raw per-run jitter.
  const history = runs
    .map((run, i) => {
      const board = deriveSmoothedBoard(runs.slice(0, i + 1), term, registry, ourBrand);
      if (!board) return null;
      const ours = board.find((r) => r.isOurBrand);
      return {
        timestamp: run.timestamp,
        ourPosition: ours?.position ?? null,
        ourScore: ours?.score ?? null,
        ourScoreRaw: ours?.scoreRaw ?? null,
        leader: board[0]?.name ?? null,
      };
    })
    .filter(Boolean);

  // brands the user has manually excluded (restorable)
  const excluded = [...userDenied()].map((d) => ({ domain: d, name: domainToName(d) }));

  res.json({
    term,
    engines: ENGINES,
    timestamp: latest.timestamp,
    smoothWindow: SMOOTH_WINDOW,
    runsAveraged: leaderboard[0]?.runsAveraged || 0,
    leaderboard,
    errors: latest.terms[term].errors || [],
    history,
    excluded,
  });
});

// ---- exclude / restore a brand (denylist) ----------------------------------
app.post("/api/exclude", (req, res) => {
  const domain = (req.body?.domain || "").trim();
  if (!domain) return res.status(400).json({ error: "domain required" });
  const our = store.getConfig().brand?.domain;
  if (our && normalizeBrand({ name: "x", domain }).domain === normalizeBrand({ name: "x", domain: our }).domain)
    return res.status(400).json({ error: "You can't exclude your own brand." });
  addDenied(domain);
  res.json({ ok: true, domain });
});

app.post("/api/include", (req, res) => {
  const domain = (req.body?.domain || "").trim();
  if (!domain) return res.status(400).json({ error: "domain required" });
  removeDenied(domain);
  res.json({ ok: true, domain });
});

// ---- manually add a brand the auto-discovery missed ------------------------
app.post("/api/term/:term/brand", (req, res) => {
  const term = req.params.term;
  const { name, domain } = req.body || {};
  if (!name || !domain) return res.status(400).json({ error: "name and domain required" });
  const nb = normalizeBrand({ name, domain });
  if (!nb.domain) return res.status(400).json({ error: "domain doesn't look valid" });
  const registry = store.getRegistry();
  const list = registry[term] ? [...registry[term]] : [];
  if (!list.some((b) => registrableDomain(b.domain) === nb.domain)) list.push(nb);
  registry[term] = list;
  store.setRegistry(registry);
  removeDenied(nb.domain); // in case it was previously excluded
  res.json({ ok: true, brand: nb });
});

// ---- raw data inspector ----------------------------------------------------
// Everything the board is derived from, and how every cited source was handled,
// so you can verify exactly what should (and shouldn't) be on the leaderboard.
app.get("/api/term/:term/raw", (req, res) => {
  const term = req.params.term;
  const cfg = store.getConfig();
  const latest = store.latestRun();
  const tr = latest?.terms?.[term];
  if (!tr) return res.status(404).json({ error: "No data for this term yet." });

  const ourDom = cfg.brand ? registrableDomain(cfg.brand.domain) : "";
  const deny = effectiveDenylist();
  const registry = store.getRegistry();
  const known = new Set();
  for (const t of Object.keys(registry))
    (registry[t] || []).forEach((b) => known.add(registrableDomain(b.domain)));

  // classify a cited reference by how the scorer treats it
  const classify = (ref) => {
    const dom = refDomain(ref);
    if (!dom) return { domain: "", status: "label-only" }; // cited by name, no usable URL
    if (dom === ourDom) return { domain: dom, status: "your-brand" };
    if (deny.has(dom)) return { domain: dom, status: "filtered" };
    if (known.has(dom)) return { domain: dom, status: "brand" };
    return { domain: dom, status: "brand" }; // valid, non-denied cite => tracked
  };

  const mapRefs = (refs) =>
    (refs || []).map((r) => ({ source: r.source || "", link: r.link || "", ...classify(r) }));

  // one entry per engine, each holding every sample's answer text + sources
  const perEngine = ENGINES.map((e) => {
    const samples = tr.answers
      .filter((a) => a.engine === e.id)
      .sort((a, b) => (a.sample || 0) - (b.sample || 0))
      .map((a) => ({ sample: a.sample || 0, text: a.text || "", references: mapRefs(a.references) }));
    const errs = (tr.errors || []).filter((x) => x.engine === e.id);
    return { engine: e.id, label: e.label, answered: samples.length > 0, errors: errs, samples };
  });

  // aggregate cited domains + surface label-only candidates (brands cited by name
  // but with no resolvable link — the ones most likely missing from the board)
  const domainMap = new Map();
  const labelCandidates = new Map();
  for (const pe of perEngine) {
    for (const s of pe.samples) {
      for (const r of s.references) {
        if (r.status === "label-only") {
          const key = (r.source || "").toLowerCase();
          if (!key) continue;
          if (!labelCandidates.has(key)) labelCandidates.set(key, { label: r.source, engines: new Set() });
          labelCandidates.get(key).engines.add(pe.engine);
        } else if (r.domain) {
          if (!domainMap.has(r.domain))
            domainMap.set(r.domain, { domain: r.domain, status: r.status, engines: new Set() });
          domainMap.get(r.domain).engines.add(pe.engine);
        }
      }
    }
  }

  res.json({
    term,
    timestamp: latest.timestamp,
    samples: tr.samples || latest.samples || 1,
    engines: ENGINES,
    perEngine,
    citedDomains: [...domainMap.values()]
      .map((d) => ({ ...d, engines: [...d.engines] }))
      .sort((a, b) => b.engines.length - a.engines.length),
    labelCandidates: [...labelCandidates.values()].map((c) => ({ label: c.label, engines: [...c.engines] })),
    ourDomain: ourDom,
  });
});

// ---- full raw SearchApi JSON for a term (optionally one engine) -------------
app.get("/api/term/:term/json", (req, res) => {
  const term = req.params.term;
  const latest = store.latestRun();
  if (!latest?.terms?.[term]) return res.status(404).json({ error: "No data for this term yet." });
  const raw = store.getRawResponses(latest.id);
  let answers = raw?.terms?.[term]?.answers || [];
  const engine = req.query.engine;
  if (engine) answers = answers.filter((a) => a.engine === engine);
  res.json({
    term,
    runId: latest.id,
    timestamp: latest.timestamp,
    note: "Exact SearchApi responses this run was built from. Request sent only { engine, q: <search term> }.",
    responses: answers,
  });
});

const PORT = process.env.PORT || 4173;
app.listen(PORT, () => {
  console.log(`\n  AI Visibility Tracker → http://localhost:${PORT}\n`);
  if (!apiKey()) console.log("  ⚠ SEARCHAPI_API_KEY not set — set it in .env before running a scan.\n");
});
