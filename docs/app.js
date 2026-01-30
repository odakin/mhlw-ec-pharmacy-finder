// Emergency Contraception Pharmacy Finder (Japan) - simple client-side search
// Data source: MHLW list. See README for details.

let DATA = [];
let META = {};

const el = (id) => document.getElementById(id);

function normalizeText(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchBlob(r) {
  // Create a blob for quick matching
  return normalizeText([r.pref, r.muni, r.name, r.addr, r.tel, r.url].filter(Boolean).join(" "));
}

function escapeHtml(s) {
  return (s || "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll("\"","&quot;")
    .replaceAll("'","&#039;");
}

function renderResults(rows) {
  const list = el("list");
  list.innerHTML = "";
  if (!rows.length) {
    el("status").textContent = "該当なし。条件を変えてみてください。";
    return;
  }
  el("status").textContent = `${rows.length.toLocaleString()} 件ヒット（表示は最大 200 件）`;
  const show = rows.slice(0, 200);

  for (const r of show) {
    const li = document.createElement("li");
    const title = escapeHtml(r.name || "(名称不明)");
    const place = escapeHtml([r.pref, r.muni].filter(Boolean).join(" "));
    const addr = escapeHtml(r.addr || "");
    const hours = escapeHtml(r.hours || "");
    const privacy = escapeHtml(r.privacy || "");
    const notes = escapeHtml(r.notes || "");
    const callAhead = (r.callAhead || "") === "要";
    const afterHours = (r.afterHours || "") === "有";

    const tel = (r.tel || "").toString();
    const telLink = tel ? `<a href="tel:${escapeHtml(tel)}">${escapeHtml(tel)}</a>` : "";
    const url = (r.url || "").toString().trim();
    const urlLink = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">公式/店舗ページ</a>` : "";

    li.innerHTML = `
      <div class="card">
        <div class="cardHead">
          <div class="name">${title}</div>
          <div class="badges">
            ${callAhead ? `<span class="badge warn">事前電話：要</span>` : ``}
            ${afterHours ? `<span class="badge">時間外：有</span>` : ``}
          </div>
        </div>
        <div class="place">${place}</div>
        <div class="addr">${addr}</div>
        <div class="links">
          ${telLink ? `<span>📞 ${telLink}</span>` : ``}
          ${urlLink ? `<span>🔗 ${urlLink}</span>` : ``}
        </div>
        ${hours ? `<div class="detail"><span class="k">開局等時間</span> ${hours}</div>` : ``}
        ${privacy ? `<div class="detail"><span class="k">プライバシー</span> ${privacy}</div>` : ``}
        ${notes ? `<div class="detail"><span class="k">備考</span> ${notes}</div>` : ``}
      </div>
    `;
    list.appendChild(li);
  }

  if (rows.length > 200) {
    const more = document.createElement("p");
    more.className = "small";
    more.textContent = `表示は 200 件までです。さらに絞り込んでください（現在 ${rows.length} 件）。`;
    list.parentElement.appendChild(more);
  }
}

function doSearch() {
  const pref = el("prefSelect").value;
  const q = normalizeText(el("q").value);
  const onlyCallAhead = el("onlyCallAhead").checked;
  const onlyAfterHours = el("onlyAfterHours").checked;

  const terms = q ? q.split(" ").filter(Boolean) : [];

  const rows = DATA.filter(r => {
    if (pref && r.pref !== pref) return false;
    if (onlyCallAhead && (r.callAhead || "") !== "要") return false;
    if (onlyAfterHours && (r.afterHours || "") !== "有") return false;

    if (!terms.length) return true;
    const blob = r._blob;
    return terms.every(t => blob.includes(t));
  });

  renderResults(rows);
}

function fillPrefOptions() {
  const prefs = Array.from(new Set(DATA.map(r => r.pref).filter(Boolean))).sort();
  const sel = el("prefSelect");
  for (const p of prefs) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    sel.appendChild(opt);
  }
}

async function init() {
  try {
    const resp = await fetch("data.json");
    const json = await resp.json();
    META = json.meta || {};
    DATA = (json.data || []).map(r => ({...r, _blob: buildSearchBlob(r)}));

    el("asOf").textContent = META.asOf || "-";
    const src = META.sourcePage || "#";
    const a = el("sourceLink");
    a.href = src;
    a.textContent = "厚生労働省（公式）";

    fillPrefOptions();
    el("status").textContent = `${DATA.length.toLocaleString()} 件の薬局等データを読み込みました。条件を入れて検索できます。`;
    renderResults(DATA.slice(0, 50));
  } catch (e) {
    console.error(e);
    el("status").textContent = "データの読み込みに失敗しました。";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init();
  el("btnSearch").addEventListener("click", doSearch);
  el("btnClear").addEventListener("click", () => {
    el("q").value = "";
    el("prefSelect").value = "";
    el("onlyCallAhead").checked = false;
    el("onlyAfterHours").checked = false;
    doSearch();
  });
  el("q").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") doSearch();
  });
  el("prefSelect").addEventListener("change", doSearch);
  el("onlyCallAhead").addEventListener("change", doSearch);
  el("onlyAfterHours").addEventListener("change", doSearch);
});
