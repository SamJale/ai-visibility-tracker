// Domains that are never brands for a leaderboard: search engines, social
// networks, forums, video, encyclopedias, code hosts, app stores, and — the
// important one for this use case — review/comparison/aggregator sites and
// general media/blogs (e.g. AI Multiple, G2, TechRadar). We only want companies
// that actually sell the product or service, not the sites that write about them.
//
// This is a curated list, not an LLM judgment, so detection stays deterministic.
// Users grow it from the UI (the "exclude" button) or by editing data/denylist.json.
import { registrableDomain } from "./scoring.js";
import * as store from "./store.js";

export const DEFAULT_DENYLIST = new Set([
  // search engines & big-tech portals
  "google.com", "bing.com", "yahoo.com", "duckduckgo.com", "baidu.com",
  "microsoft.com", "apple.com", "amazon.com", "aws.amazon.com", "cloud.google.com",
  // social & forums
  "reddit.com", "quora.com", "x.com", "twitter.com", "facebook.com", "linkedin.com",
  "instagram.com", "tiktok.com", "threads.net", "pinterest.com", "ycombinator.com",
  "discord.com", "slack.com", "telegram.org", "t.me",
  // video & media platforms
  "youtube.com", "vimeo.com", "twitch.tv",
  // reference / wikis
  "wikipedia.org", "wikimedia.org", "fandom.com", "britannica.com",
  // dev & package platforms
  "github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com", "stackexchange.com",
  "dev.to", "npmjs.com", "pypi.org", "sourceforge.net", "readthedocs.io",
  "huggingface.co", "kaggle.com", "replit.com", "codepen.io", "medium.com",
  "substack.com", "wordpress.com", "blogspot.com",
  // review / comparison / aggregator sites
  "aimultiple.com", "g2.com", "capterra.com", "getapp.com", "softwareadvice.com",
  "trustradius.com", "trustpilot.com", "gartner.com", "producthunt.com", "saashub.com",
  "slant.co", "alternativeto.net", "crozdesk.com", "financesonline.com", "goodfirms.co",
  "clutch.co", "sitejabber.com",
  // general tech media & blogs
  "forbes.com", "techcrunch.com", "businessinsider.com", "cnbc.com", "nytimes.com",
  "bbc.com", "bbc.co.uk", "theguardian.com", "wired.com", "theverge.com", "techradar.com",
  "pcmag.com", "zdnet.com", "cnet.com", "engadget.com", "mashable.com", "venturebeat.com",
  "makeuseof.com", "geekflare.com", "hackernoon.com", "freecodecamp.org",
  "analyticsvidhya.com", "kdnuggets.com", "towardsdatascience.com", "geeksforgeeks.org",
  "w3schools.com", "tutorialspoint.com", "javatpoint.com",
]);

// user-added exclusions live in data/denylist.json: { domains: [...] }
export function userDenied() {
  return new Set((store.getDenylist().domains || []).map((d) => registrableDomain(d)));
}

// The full effective denylist (defaults + user), as a Set of registrable domains.
export function effectiveDenylist() {
  return new Set([...DEFAULT_DENYLIST, ...userDenied()]);
}

export function isDenied(domain, denylist = effectiveDenylist()) {
  return denylist.has(registrableDomain(domain));
}

export function addDenied(domain) {
  const d = registrableDomain(domain);
  const dl = store.getDenylist();
  const set = new Set(dl.domains || []);
  set.add(d);
  store.setDenylist({ domains: [...set] });
  return d;
}

export function removeDenied(domain) {
  const d = registrableDomain(domain);
  const dl = store.getDenylist();
  // can only remove user-added entries; defaults are permanent
  store.setDenylist({ domains: (dl.domains || []).filter((x) => registrableDomain(x) !== d) });
  return d;
}
