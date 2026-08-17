// Single-term page: leaderboard + "Do the engines agree?" matrix + brand curation.
const term = new URLSearchParams(location.search).get("term") || "";

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function movementEl(m) {
  if (m === null || m === undefined) return `<span class="mv new">NEW</span>`;
  if (m > 0) return `<span class="mv up">▲ ${m}</span>`;
  if (m < 0) return `<span class="mv down">▼ ${Math.abs(m)}</span>`;
  return `<span class="mv flat">—</span>`;
}
function heat(v) {
  const t = Math.max(0, Math.min(1, v / 100));
  const bg = t === 0 ? "var(--accent-soft)" : `rgba(79,70,229,${(0.12 + 0.88 * t).toFixed(2)})`;
  const fg = t > 0.55 ? "#fff" : "var(--accent)";
  return `background:${bg}; color:${fg};`;
}

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
  setTimeout(() => t.remove(), isErr ? 5000 : 2600);
}

async function exclude(domain) {
  try {
    await api("/api/exclude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    toast(`Excluded ${domain}`);
    init();
  } catch (e) { toast(e.message, true); }
}
async function restore(domain) {
  try {
    await api("/api/include", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    toast(`Restored ${domain}`);
    init();
  } catch (e) { toast(e.message, true); }
}
window._exclude = exclude;
window._restore = restore;

function renderLeaderboard(board, smoothWindow) {
  const avgNote = smoothWindow > 1 ? ` — averaged over the last ${smoothWindow} scans to cut run-to-run sampling noise` : "";
  const head = `<thead><tr>
    <th class="num">#</th><th>Brand</th>
    <th class="num" title="Blended score: 70% mention rate + 15% citation rate + 15% position${avgNote}">AI Visibility</th>
    <th class="num" title="Share of engine answers that named the brand in the text (70% of the score)">Mention rate</th>
    <th class="num" title="Share of engine answers that linked the brand's own domain (15% of the score)">Citation rate</th>
    <th class="num" title="How many of the 5 engines named this brand at least once">Named by</th>
    <th class="num" title="Brand's share of all brand mentions for this term">Share of voice</th>
    <th class="ctr">Movement</th>
    <th class="ctr"></th>
  </tr></thead>`;
  const rows = board
    .map((r) => {
      const tag = r.isOurBrand ? `<span class="tag">YOU</span>` : "";
      const action = r.isOurBrand
        ? ""
        : `<button class="xbtn" title="Not a brand? Exclude it" onclick="_exclude('${esc(r.domain)}')">exclude</button>`;
      const citeTitle = `cited by ${r.citations} of 5 engines`;
      return `<tr class="${r.isOurBrand ? "ours" : ""}">
        <td class="num rank">${r.position}</td>
        <td><div class="brandcell">
          <span class="bname">${esc(r.name)}${tag}</span>
          <span class="bdom">${esc(r.domain || "")}</span>
        </div></td>
        <td class="num"><span class="pill">${r.score.toFixed(1)}</span>${
          r.scoreRaw != null && r.runsAveraged > 1
            ? `<div class="dim" style="font-size:11px;margin-top:2px;" title="This scan alone, before averaging">this scan ${r.scoreRaw.toFixed(1)}</div>`
            : ""
        }</td>
        <td class="num">${Math.round(r.mention_rate)}%</td>
        <td class="num" title="${citeTitle}">${Math.round(r.citation_rate)}%</td>
        <td class="num" title="named by ${r.enginesNamed} of 5 engines">${r.enginesNamed}/5</td>
        <td class="num">${r.sov.toFixed(1)}%</td>
        <td class="ctr">${movementEl(r.movement)}</td>
        <td class="ctr">${action}</td>
      </tr>`;
    })
    .join("");
  document.getElementById("leaderTable").innerHTML = head + `<tbody>${rows}</tbody>`;
}

function renderAgree(board, engines) {
  const head = `<thead><tr>
    <th>Brand</th>
    ${engines.map((e) => `<th class="ctr">${esc(e.label)}</th>`).join("")}
    <th class="ctr sumcol" title="How many of the ${engines.length} engines named this brand at least once">Named by</th>
  </tr></thead>`;
  const rows = board
    .map((r) => {
      let namedBy = 0;
      const cells = engines
        .map((e) => {
          const cell = r.engines?.[e.id] || {};
          const v = cell.mentionRate ?? 0;
          if (v > 0) namedBy++;
          const label = v > 0 ? `${v}%` : "·";
          const title = `${esc(e.label)}: named in ${v}% of samples${cell.cited ? ", cited as a source" : ""}`;
          const dot = `<span class="cite-dot ${cell.cited ? "on" : ""}" title="cited as a source">◆</span>`;
          return `<td class="cell-agree" title="${title}">
            <span class="agree-cell"><span class="heat" style="${heat(v)}">${label}</span>${dot}</span>
          </td>`;
        })
        .join("");
      return `<tr class="${r.isOurBrand ? "ours" : ""}">
        <td><span class="bname">${esc(r.name)}${r.isOurBrand ? ' <span class="tag">YOU</span>' : ""}</span></td>
        ${cells}
        <td class="ctr namedby">${namedBy}/${engines.length}</td>
      </tr>`;
    })
    .join("");
  document.getElementById("agreeTable").innerHTML = head + `<tbody>${rows}</tbody>`;
}

function renderExcluded(excluded) {
  const box = document.getElementById("excluded");
  if (!excluded || !excluded.length) { box.innerHTML = ""; return; }
  box.innerHTML =
    `<div class="excluded-wrap"><span class="dim" style="font-size:12.5px;">Excluded by you:</span> ` +
    excluded
      .map(
        (e) =>
          `<span class="term-tag" title="${esc(e.domain)}">${esc(e.name)} <button onclick="_restore('${esc(e.domain)}')" title="restore">↺</button></span>`
      )
      .join(" ") +
    `</div>`;
}

async function init() {
  document.getElementById("termTitle").textContent = term;
  document.getElementById("rawLink").href = `/raw.html?term=${encodeURIComponent(term)}`;
  try {
    const d = await api(`/api/term/${encodeURIComponent(term)}`);
    const avg =
      d.smoothWindow > 1 && d.runsAveraged > 1
        ? ` · scores averaged over the last ${d.runsAveraged} scan(s)`
        : "";
    document.getElementById("subline").textContent =
      `${d.leaderboard.length} brands tracked · scanned ${new Date(d.timestamp).toLocaleString()}${avg}`;
    renderLeaderboard(d.leaderboard, d.smoothWindow);
    renderAgree(d.leaderboard, d.engines);
    renderExcluded(d.excluded);
    document.getElementById("errors").innerHTML = d.errors?.length
      ? `<p class="dim" style="font-size:12.5px;">Engines that didn't answer this run: ` +
        d.errors.map((e) => `${esc(e.engine)} (${esc(e.error)})`).join(", ") + `</p>`
      : "";
  } catch (e) {
    document.getElementById("subline").innerHTML =
      `<span style="color:var(--down)">${esc(e.message)}</span> · <a href="/">back to dashboard</a>`;
  }
}
init();
