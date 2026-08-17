// Flat-file JSON persistence. Everything lives under ./data.
//   data/config.json      -> { brand, terms }
//   data/registry.json    -> { "<term>": [ {name, domain, aliases, isOurBrand} ] }
//   data/runs/<id>.json    -> a full computed run
//   data/runs/index.json   -> [ {id, timestamp, termCount} ] newest last
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data");
const RUNS = path.join(DATA, "runs");

function ensure() {
  fs.mkdirSync(RUNS, { recursive: true });
}
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  ensure();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const CONFIG = path.join(DATA, "config.json");
const REGISTRY = path.join(DATA, "registry.json");
const DENYLIST = path.join(DATA, "denylist.json");
const SETTINGS = path.join(DATA, "settings.json");
const INDEX = path.join(RUNS, "index.json");

export function getConfig() {
  return readJSON(CONFIG, { brand: null, terms: [] });
}
export function setConfig(cfg) {
  writeJSON(CONFIG, cfg);
  return cfg;
}

export function getRegistry() {
  return readJSON(REGISTRY, {});
}
export function setRegistry(reg) {
  writeJSON(REGISTRY, reg);
  return reg;
}

export function getDenylist() {
  return readJSON(DENYLIST, { domains: [] });
}
export function setDenylist(dl) {
  writeJSON(DENYLIST, dl);
  return dl;
}

// Local settings (incl. the SearchApi key) — data/ is gitignored so this stays
// on your machine. An env var, if set, always takes precedence over this.
export function getSettings() {
  return readJSON(SETTINGS, {});
}
export function setSettings(s) {
  writeJSON(SETTINGS, s);
  return s;
}

export function listRuns() {
  return readJSON(INDEX, []);
}
export function getRun(id) {
  return readJSON(path.join(RUNS, `${id}.json`), null);
}
export function latestRun() {
  const idx = listRuns();
  if (!idx.length) return null;
  return getRun(idx[idx.length - 1].id);
}
export function previousRun() {
  const idx = listRuns();
  if (idx.length < 2) return null;
  return getRun(idx[idx.length - 2].id);
}
export function saveRun(run) {
  writeJSON(path.join(RUNS, `${run.id}.json`), run);
  const idx = listRuns();
  idx.push({ id: run.id, timestamp: run.timestamp, termCount: Object.keys(run.terms).length });
  writeJSON(INDEX, idx);
  return run;
}

// Full raw SearchApi responses are stored in a sibling file so they don't bloat
// the lean run file that board derivation reads on every request.
export function saveRawResponses(id, data) {
  writeJSON(path.join(RUNS, `${id}.raw.json`), data);
}
export function getRawResponses(id) {
  return readJSON(path.join(RUNS, `${id}.raw.json`), null);
}
