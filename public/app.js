// Main dashboard: setup panel + run + term cards.
const $ = (s) => document.querySelector(s);
let terms = [];

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isErr) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3200);
}

function movementEl(m) {
  if (m === null || m === undefined) return `<span class="mv new">NEW</span>`;
  if (m > 0) return `<span class="mv up">▲ ${m}</span>`;
  if (m < 0) return `<span class="mv down">▼ ${Math.abs(m)}</span>`;
  return `<span class="mv flat">—</span>`;
}

function renderTerms() {
  const list = $("#termsList");
  list.innerHTML = terms.length
    ? ""
    : `<span class="dim" style="font-size:13px;">No terms yet.</span>`;
  terms.forEach((t, i) => {
    const tag = document.createElement("span");
    tag.className = "term-tag";
    tag.innerHTML = `<span></span><button title="remove">×</button>`;
    tag.firstChild.textContent = t;
    tag.querySelector("button").onclick = () => {
      terms.splice(i, 1);
      renderTerms();
    };
    list.appendChild(tag);
  });
  updateCost();
}

function addTerm() {
  const input = $("#termInput");
  const v = input.value.trim();
  if (v && !terms.includes(v)) terms.push(v);
  input.value = "";
  renderTerms();
  input.focus();
}

function samplesVal() {
  return Number($("#samples").value) || 3;
}
function updateCost() {
  const s = samplesVal();
  const calls = terms.length * 5 * s;
  $("#costNote").textContent = `${terms.length} term(s) × 5 engines × ${s} sample(s) = ${calls} SearchApi request(s) per scan.`;
}

async function saveSetup() {
  const brand = { name: $("#brandName").value.trim(), domain: $("#brandDomain").value.trim() };
  if (!brand.name || !brand.domain) return toast("Add your brand name and domain first.", true);
  await api("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand, terms, samples: samplesVal() }),
  });
  toast("Setup saved.");
  return true;
}

async function runScan() {
  if (!(await saveSetup())) return;
  if (!terms.length) return toast("Add at least one search term.", true);
  const btn = $("#runBtn");
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Scanning ${terms.length} term(s) × 5 engines × ${samplesVal()}…`;
  try {
    await api("/api/run", { method: "POST" });
    toast("Scan complete.");
    await loadOverview();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function card(c) {
  const href = `/term.html?term=${encodeURIComponent(c.term)}`;
  if (!c.hasData) {
    return `<a class="card" href="${href}">
      <div class="term">${esc(c.term)}</div>
      <div class="dim" style="font-size:13px;">No data yet — run a scan.</div>
    </a>`;
  }
  const top = c.top ? `<span class="who">${esc(c.top.name)}</span> <span class="pill">${c.top.score}</span>` : "—";
  const our = c.our
    ? `<div class="ours-line">
         <div><span class="ours-badge">${esc(c.our.name)}</span>
              <div class="dim" style="font-size:12px;">score ${c.our.score}</div></div>
         <div style="text-align:right;">
           <div class="pos-big">#${c.our.position}<small> / ${c.brandCount}</small></div>
           <div>${movementEl(c.our.movement)}</div>
         </div>
       </div>`
    : "";
  return `<a class="card" href="${href}">
    <div class="term">${esc(c.term)}</div>
    <div class="leaderline"><span>Current #1</span><span>${top}</span></div>
    <div class="leaderline"><span>Engines answered</span><span>${c.answeredEngines}/5</span></div>
    ${our}
  </a>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function loadOverview() {
  const o = await api("/api/overview");
  const avg =
    o.smoothWindow > 1 ? ` · scores averaged over the last ${o.smoothWindow} scans` : "";
  $("#lastRun").textContent = o.lastRun
    ? `Last scan ${new Date(o.lastRun).toLocaleString()} · ${o.runCount} run(s) logged${avg}`
    : "No scans yet.";
  const cards = $("#cards");
  cards.innerHTML = o.cards.length
    ? o.cards.map(card).join("")
    : `<div class="empty">Add a brand and some search terms above, then run your first scan.</div>`;
}

// ---- settings modal --------------------------------------------------------
async function loadKeyStatus() {
  const s = await api("/api/settings");
  const el = $("#keyStatus");
  if (s.source === "saved") {
    el.innerHTML = `✓ Using the key saved here (…${s.last4}).`;
  } else if (s.source === "env") {
    el.innerHTML = `Using <code>SEARCHAPI_API_KEY</code> from the environment (…${s.last4}). Enter a key above to override it.`;
  } else {
    el.textContent = "No key set yet — paste one above and save.";
  }
  // the in-app key can always be managed; clearing falls back to the env var
  $("#clearKey").textContent = s.envAvailable && s.source === "saved" ? "Use env key" : "Clear";
  return s;
}

function openSettings() {
  $("#settingsModal").hidden = false;
  $("#apiKeyInput").value = "";
  loadKeyStatus().catch((e) => toast(e.message, true));
}
function closeSettings() { $("#settingsModal").hidden = true; }

async function saveKey() {
  const apiKeyVal = $("#apiKeyInput").value.trim();
  if (!apiKeyVal) return toast("Paste a key first.", true);
  await api("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: apiKeyVal }),
  });
  $("#apiKeyInput").value = "";
  toast("Key saved.");
  await loadKeyStatus();
  await refreshApiKeyNote();
}
async function clearKey() {
  await api("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "" }),
  });
  toast("Key cleared.");
  await loadKeyStatus();
  await refreshApiKeyNote();
}
async function testKey() {
  const btn = $("#testKey");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Testing…";
  try {
    await api("/api/settings/test", { method: "POST" });
    toast("Key works ✓");
  } catch (e) {
    toast("Key test failed: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}
async function refreshApiKeyNote() {
  const cfg = await api("/api/config");
  $("#setupNote").textContent = cfg.hasApiKey ? "" : "⚠ No SearchApi key — add one in Settings before scanning.";
}

async function init() {
  $("#openSettings").onclick = openSettings;
  $("#closeSettings").onclick = closeSettings;
  $("#settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") closeSettings();
  });
  $("#saveKey").onclick = saveKey;
  $("#clearKey").onclick = clearKey;
  $("#testKey").onclick = testKey;
  $("#revealKey").onclick = () => {
    const i = $("#apiKeyInput");
    i.type = i.type === "password" ? "text" : "password";
  };

  const cfg = await api("/api/config");
  $("#engineStrip").innerHTML = (cfg.engines || [])
    .map((e) => `<span class="chip">${esc(e.label)}</span>`)
    .join("");
  if (cfg.brand) {
    $("#brandName").value = cfg.brand.name || "";
    $("#brandDomain").value = cfg.brand.domain || "";
  }
  terms = cfg.terms || [];
  if (cfg.samples) $("#samples").value = String(cfg.samples);
  renderTerms();
  $("#setupNote").textContent = cfg.hasApiKey ? "" : "⚠ No SearchApi key — add one in Settings before scanning.";

  $("#samples").onchange = updateCost;
  $("#addTermBtn").onclick = addTerm;
  $("#termInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addTerm(); }
  });
  $("#saveBtn").onclick = () => saveSetup();
  $("#runBtn").onclick = runScan;

  await loadOverview();
}

init().catch((e) => toast(e.message, true));
