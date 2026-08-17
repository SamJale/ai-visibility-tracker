// Derives a term's leaderboard from a run's RAW answers at read time. Because we
// re-derive from raw text on every read, changes to the brand log, the denylist,
// or manual exclusions apply retroactively — no re-scan needed.
import { buildLeaderboard, registrableDomain } from "./scoring.js";
import { brandsForTerm } from "./brands.js";
import { effectiveDenylist } from "./denylist.js";

// How many runs the headline score averages over.
//
// Why this exists: an engine's answer is nondeterministic, so a brand's mention
// rate is a proportion estimated from (engines x samples) Bernoulli draws. At the
// default 5 samples that's 25 draws, and the sampling error on a mid-range brand
// swamps any real movement — measured on live runs, a brand sitting near a 18%
// mention rate had a run-to-run SD of 6.8 score points with NO underlying change
// (two runs a minute apart scored 4.9 and 24.8). Averaging the trailing runs cuts
// that: SD 6.8 -> 2.4 at a window of 3, for free, off runs already on disk.
// Matching it by brute force would need roughly 24x the samples per scan.
export const SMOOTH_WINDOW = 3;

// Build one term's board for `run`, using `prevRun` only to compute movement.
export function deriveBoard(run, prevRun, term, registry, ourBrand) {
  const tr = run?.terms?.[term];
  if (!tr || !Array.isArray(tr.answers)) return null;

  const denylist = effectiveDenylist();
  const isDenied = (d) => denylist.has(registrableDomain(d));

  const brands = brandsForTerm(registry, term, ourBrand, isDenied);
  // brands from THIS term's own log that survive the denylist — kept on the board
  // even at 0/0 so a brand that stops showing still holds its place.
  const keepDomains = new Set(
    (registry[term] || [])
      .map((b) => registrableDomain(b.domain))
      .filter((d) => d && !isDenied(d))
  );

  // previous board (no movement needed on it) for this run's movement column
  const prevBoard = prevRun
    ? deriveBoard(prevRun, null, term, registry, ourBrand)
    : null;

  return buildLeaderboard(tr.answers, brands, prevBoard, keepDomains);
}

// The averaged fields. Everything else on a row (per-engine cells, mentions, sov)
// stays as the latest run measured it — those describe THIS run, not a trend.
const SMOOTHED = ["score", "mention_rate", "citation_rate", "position_factor"];

// Build one term's board with the headline metrics averaged over the trailing
// `window` runs. `runs` is chronological (latest last) and may include runs that
// never covered this term — those are skipped, so the window is always the last
// `window` runs that actually have data here.
//
// A brand is averaged only over the runs it appears on. Brands in the term's log
// sit on the board at 0 once discovered, so this only affects the runs BEFORE a
// brand was first seen: a newly-discovered brand starts unsmoothed and settles as
// the window fills, rather than being dragged toward 0 by runs that predate it.
export function deriveSmoothedBoard(
  runs,
  term,
  registry,
  ourBrand,
  window = SMOOTH_WINDOW
) {
  const withData = (runs || []).filter((r) => Array.isArray(r?.terms?.[term]?.answers));
  if (!withData.length) return null;

  // this run's window, and the one ending a run earlier — for movement
  const boardsFor = (list) =>
    list.map((r) => deriveBoard(r, null, term, registry, ourBrand)).filter(Boolean);
  const curr = boardsFor(withData.slice(-window));
  if (!curr.length) return null;

  const blend = (boards) => {
    const latest = boards[boards.length - 1];
    const sums = new Map(); // domain -> { n, score, mention_rate, ... }
    for (const board of boards) {
      for (const row of board) {
        const key = registrableDomain(row.domain) || row.name;
        if (!sums.has(key)) sums.set(key, { n: 0 });
        const acc = sums.get(key);
        acc.n++;
        for (const f of SMOOTHED) acc[f] = (acc[f] || 0) + (row[f] || 0);
      }
    }
    // Start from the latest board so per-engine detail and row identity are this
    // run's, then overwrite the headline metrics with the trailing average.
    const rows = latest.map((row) => {
      const key = registrableDomain(row.domain) || row.name;
      const acc = sums.get(key) || { n: 1 };
      const out = { ...row, scoreRaw: row.score, runsAveraged: acc.n };
      for (const f of SMOOTHED) {
        out[f] = round(acc[f] / acc.n, f === "position_factor" ? 3 : 1);
      }
      return out;
    });
    // same ordering rule as buildLeaderboard, now over the smoothed score
    rows.sort(
      (a, b) => b.score - a.score || b.mentions - a.mentions || a.name.localeCompare(b.name)
    );
    rows.forEach((r, i) => (r.position = i + 1));
    return rows;
  };

  const rows = blend(curr);

  // movement compares this smoothed board against the previous one, so a position
  // change reflects the averaged trend rather than a single run's noise.
  const prevWindow = withData.slice(0, -1).slice(-window);
  const prevRows = prevWindow.length ? blend(boardsFor(prevWindow)) : null;
  const prevPos = {};
  if (prevRows) prevRows.forEach((r) => (prevPos[r.name] = r.position));
  rows.forEach((r) => {
    r.movement = prevRows && r.name in prevPos ? prevPos[r.name] - r.position : null;
  });

  return rows;
}

function round(n, dp) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
