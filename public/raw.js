// Raw data inspector for one search term.
const term = new URLSearchParams(location.search).get("term") || "";
const $ = (s) => document.querySelector(s);

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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

// very small markdown-ish renderer for readability (bold + line breaks); the
// underlying scorer works on the raw text, this is just for human reading.
function renderText(md) {
  return esc(md)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

function statusTag(status) {
  const label = {
    "your-brand": "you",
    brand: "brand",
    filtered: "filtered",
    "label-only": "no link",
  }[status] || status;
  return `<span class="stag ${status}">${label}</span>`;
}

function refsTable(refs) {
  if (!refs.length) return `<div class="dim" style="font-size:12.5px; padding:4px 0;">No sources cited.</div>`;
  return `<table class="refs"><tbody>${refs
    .map(
      (r) => `<tr>
        <td>${statusTag(r.status)}</td>
        <td class="rdom">${esc(r.domain || r.source || "—")}</td>
        <td class="rlink">${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(shorten(r.link))}</a>` : `<span class="dim">${esc(r.source)}</span>`}</td>
      </tr>`
    )
    .join("")}</tbody></table>`;
}

function engineCard(pe) {
  const jsonHref = `/api/term/${encodeURIComponent(term)}/json?engine=${encodeURIComponent(pe.engine)}`;
  if (!pe.answered) {
    const why = pe.errors?.length ? " — " + esc(pe.errors[0].error) : "";
    return `<div class="panel enginecard">
      <div class="ehead"><span class="chip">${esc(pe.label)}</span> <span class="dim" style="font-size:12.5px;">didn't answer${why}</span></div>
    </div>`;
  }
  const totalCites = pe.samples.reduce((n, s) => n + s.references.length, 0);
  const samples = pe.samples
    .map((s, i) => {
      const open = i === 0 ? " open" : "";
      const wc = (s.text || "").split(/\s+/).filter(Boolean).length;
      return `<details class="answerbox sample"${open}>
        <summary>Sample ${s.sample + 1} · ${wc} words · ${s.references.length} source(s)</summary>
        <div class="answer">${renderText(s.text) || '<span class="dim">Empty answer.</span>'}</div>
        <div class="reflabel">Cited sources</div>
        ${refsTable(s.references)}
      </details>`;
    })
    .join("");
  return `<div class="panel enginecard">
    <div class="ehead">
      <span class="chip">${esc(pe.label)}</span>
      <span class="dim" style="font-size:12.5px;">${pe.samples.length} sample(s) · ${totalCites} citation(s)</span>
      <a class="jsonlink" href="${jsonHref}" target="_blank" rel="noopener">View JSON →</a>
    </div>
    ${samples}
  </div>`;
}

function shorten(url) {
  return url.replace(/^https?:\/\//, "").slice(0, 60);
}

function prefill(name, domain) {
  $("#bName").value = name || "";
  $("#bDomain").value = domain || "";
  $("#bName").scrollIntoView({ behavior: "smooth", block: "center" });
  $("#bDomain").focus();
}
window._prefill = prefill;

function renderCandidates(cands) {
  const box = $("#candidates");
  if (!cands.length) {
    box.innerHTML = `<div class="dim" style="font-size:13px;">None — every cited source resolved to a domain.</div>`;
    return;
  }
  box.innerHTML =
    `<div class="cand-list">` +
    cands
      .map(
        (c) =>
          `<span class="term-tag">${esc(c.label)} <span class="dim" style="font-size:11px;">(${c.engines.length})</span>
             <button title="add this brand" onclick="_prefill('${esc(c.label)}','')">+ add</button></span>`
      )
      .join(" ") +
    `</div>`;
}

async function addBrand() {
  const name = $("#bName").value.trim();
  const domain = $("#bDomain").value.trim();
  if (!name || !domain) return toast("Enter a name and a domain.", true);
  try {
    await api(`/api/term/${encodeURIComponent(term)}/brand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, domain }),
    });
    toast(`Added ${name}. It's now scored across your history.`);
    $("#bName").value = "";
    $("#bDomain").value = "";
  } catch (e) {
    toast(e.message, true);
  }
}

async function init() {
  $("#termTitle").textContent = term;
  $("#backLink").href = `/term.html?term=${encodeURIComponent(term)}`;
  $("#addBtn").onclick = addBrand;
  try {
    const d = await api(`/api/term/${encodeURIComponent(term)}/raw`);
    const answered = d.perEngine.filter((p) => p.answered).length;
    const totalCites = d.perEngine.reduce((n, p) => n + p.samples.reduce((m, s) => m + s.references.length, 0), 0);
    $("#subline").innerHTML =
      `${answered}/${d.engines.length} engines answered · ${d.samples} sample(s) each · ${totalCites} citations · ${d.citedDomains.length} unique domains · scanned ${new Date(d.timestamp).toLocaleString()} · <a href="/api/term/${encodeURIComponent(term)}/json" target="_blank" rel="noopener">full JSON</a>`;
    $("#engines").innerHTML = d.perEngine.map(engineCard).join("");
    renderCandidates(d.labelCandidates);
  } catch (e) {
    $("#engines").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
init();
