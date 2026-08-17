// The persistent brand log ("registry"). This is what lets a brand stay on a
// leaderboard even after it stops showing: once we've seen a brand for a term,
// it lives in the registry forever until a human removes it.
//
// Discovery is deterministic: after each run we look at every source the engines
// CITED and register its domain as a brand (if new and not denylisted). Citations
// are the reliable, machine-readable signal that a real brand showed up. Brands
// that are only ever named in prose (never cited) can be added by hand; and once a
// brand is in the registry for ANY term, it is matched by name across ALL terms.
import { registrableDomain, domainToName, refDomain } from "./scoring.js";

export function normalizeBrand(b) {
  const domain = registrableDomain(b.domain || "");
  const name = (b.name || domainToName(domain) || "").trim();
  const aliases = uniq([name, ...(b.aliases || [])].map((s) => (s || "").trim()).filter(Boolean));
  return { name, domain, aliases, isOurBrand: !!b.isOurBrand };
}

function uniq(arr) {
  return [...new Set(arr)];
}

// The brand set used to SCORE a given term: our brand + every brand ever logged
// (across all terms, so cross-term prose mentions are caught), de-duplicated by
// registrable domain, with denylisted domains removed (our brand is never removed).
export function brandsForTerm(registry, term, ourBrand, isDenied = () => false) {
  const byDomain = new Map();
  const add = (b) => {
    const nb = normalizeBrand(b);
    if (!nb.name) return;
    if (!nb.isOurBrand && nb.domain && isDenied(nb.domain)) return;
    const key = nb.domain || nb.name.toLowerCase();
    if (byDomain.has(key)) {
      const ex = byDomain.get(key);
      ex.aliases = uniq([...ex.aliases, ...nb.aliases]);
      ex.isOurBrand = ex.isOurBrand || nb.isOurBrand;
    } else {
      byDomain.set(key, nb);
    }
  };
  if (ourBrand) add({ ...ourBrand, isOurBrand: true });
  for (const t of Object.keys(registry)) (registry[t] || []).forEach(add);
  return [...byDomain.values()];
}

// After a run, fold newly-cited domains into the registry for that term.
// Denylisted domains are never logged. Returns the (possibly grown) list.
export function discoverFromAnswers(registry, term, answers, ourBrand, isDenied = () => false) {
  const existing = registry[term] ? [...registry[term]] : [];
  const known = new Set(existing.map((b) => registrableDomain(b.domain)));
  if (ourBrand) known.add(registrableDomain(ourBrand.domain));

  for (const a of answers) {
    for (const ref of a.references || []) {
      const dom = refDomain(ref);
      if (!dom || known.has(dom) || isDenied(dom)) continue;
      known.add(dom);
      existing.push(normalizeBrand({ domain: dom, name: domainToName(dom) }));
    }
  }
  registry[term] = existing;
  return existing;
}
