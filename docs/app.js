// Emergency Contraception Pharmacy Finder (Japan) - simple client-side search
// Data source: MHLW list. See README for details.

let DATA = [];
let META = {};

// Some prefectures are listed only as "現在調整中" in the official sheet.
// Treat those rows as "no individual stores listed yet" rather than a real store record.
const PENDING_PREFS = new Set();

const el = (id) => document.getElementById(id);

// UI rendering limit (keeps the DOM light). Users can "show more" if needed.
const RESULTS_STEP = 50;
let CURRENT_ROWS = [];
let CURRENT_LIMIT = RESULTS_STEP;

// Standard prefecture order (north -> south)
const PREF_ORDER = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
];

const PREF_RANK = new Map(PREF_ORDER.map((p, i) => [p, i]));

function cleanValue(v) {
  if (v == null) return "";
  const s = v.toString().replace(/\u3000/g, " ").trim(); // include full-width space
  if (s.toLowerCase() === "nan") return "";
  return s;
}

function normalizeText(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    // full-width digits -> ascii
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    // normalize common hyphens
    .replace(/[－ー―−‐ｰ–—]/g, "-")
    // full-width spaces -> normal spaces
    .replace(/\u3000/g, " ")
    // collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchBlob(r) {
  // Create a blob for quick matching
  const parts = [r.pref, r.muni, r.name, r.addr, r.tel, r.url].map(cleanValue).filter(Boolean);
  return normalizeText(parts.join(" "));
}

function escapeHtml(s) {
  return (s || "")
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getPager() {
  let pager = el("pager");
  if (!pager) {
    pager = document.createElement("div");
    pager.id = "pager";
    pager.className = "small";
    el("list").parentElement.appendChild(pager);
  }
  return pager;
}

function renderResults(rows, limit = RESULTS_STEP, updateStatus = true) {
  const list = el("list");
  const pager = getPager();

  // Clear previous results + notes (prevents message stacking)
  list.innerHTML = "";
  pager.innerHTML = "";

  if (!rows.length) {
    if (updateStatus) el("status").textContent = "該当なし。条件を変えてみてください。";
    return;
  }

  const show = rows.slice(0, limit);
  if (updateStatus) {
    el("status").textContent = `${rows.length.toLocaleString()} 件ヒット（${show.length.toLocaleString()} 件表示）`;
  }

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

  if (show.length < rows.length) {
    const p = document.createElement("p");
    p.className = "small";
    p.textContent = `結果が多いため、まず ${show.length.toLocaleString()} 件まで表示しています（全 ${rows.length.toLocaleString()} 件）。`;
    pager.appendChild(p);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost";
    const moreN = Math.min(RESULTS_STEP, rows.length - show.length);
    btn.textContent = `さらに ${moreN.toLocaleString()} 件表示`;
    btn.addEventListener("click", () => {
      CURRENT_LIMIT = Math.min(CURRENT_LIMIT + RESULTS_STEP, rows.length);
      renderResults(rows, CURRENT_LIMIT, true);
    });
    pager.appendChild(btn);
  }
}

function doSearch(resetLimit = true) {
  const pref = cleanValue(el("prefSelect").value);
  const q = normalizeText(el("q").value);
  const onlyNotCallAhead = el("onlyNotCallAhead").checked;
  const onlyAfterHours = el("onlyAfterHours").checked;

  const terms = q ? q.split(" ").filter(Boolean) : [];

  const rows = DATA.filter((r) => {
    if (pref && r.pref !== pref) return false;

    // 「事前電話連絡：要」"ではない"ものだけ（＝ 要 の行を除外）
    if (onlyNotCallAhead && (r.callAhead || "") === "要") return false;

    if (onlyAfterHours && (r.afterHours || "") !== "有") return false;

    if (!terms.length) return true;
    return terms.every((t) => r._blob.includes(t));
  });

  // 0件表示のときは「調整中」メッセージを優先して出す
  if (!rows.length) {
    renderResults([], RESULTS_STEP, false);
    if (pref && PENDING_PREFS.has(pref)) {
      el("status").textContent = `${pref} は現在調整中のため、公式リストに個別の薬局等が掲載されていません。`;
    } else {
      el("status").textContent = "該当なし。条件を変えてみてください。";
    }
    CURRENT_ROWS = [];
    return;
  }

  CURRENT_ROWS = rows;
  if (resetLimit) CURRENT_LIMIT = RESULTS_STEP;

  renderResults(CURRENT_ROWS, CURRENT_LIMIT, true);
}

function fillPrefOptions() {
  const sel = el("prefSelect");
  // Remove existing options except the first "(指定なし)"
  while (sel.options.length > 1) sel.remove(1);

  const prefs = Array.from(
    new Set([...DATA.map((r) => r.pref).filter(Boolean), ...Array.from(PENDING_PREFS)])
  );
  prefs.sort((a, b) => {
    const ra = PREF_RANK.has(a) ? PREF_RANK.get(a) : 999;
    const rb = PREF_RANK.has(b) ? PREF_RANK.get(b) : 999;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b, "ja");
  });

  for (const p of prefs) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    sel.appendChild(opt);
  }
}

async function init() {
  try {
    // Avoid stale CDN/browser cache after data updates on GitHub Pages.
    const resp = await fetch("data.json", { cache: "no-cache" });
    const json = await resp.json();
    META = json.meta || {};

    // Load + sanitize + detect "現在調整中"
    PENDING_PREFS.clear();
    const real = [];
    for (const r of json.data || []) {
      const rr = { ...r };

      // Defensive trimming: prevents bugs like " 東京都" being treated as a different prefecture
      for (const k of [
        "pref",
        "muni",
        "name",
        "addr",
        "tel",
        "url",
        "hours",
        "privacy",
        "callAhead",
        "afterHours",
        "afterHoursTel",
        "notes",
      ]) {
        if (k in rr) rr[k] = cleanValue(rr[k]);
      }

      const isPending = rr.name === "現在調整中" && !rr.muni && !rr.addr && !rr.tel && !rr.url;
      if (isPending) {
        if (rr.pref) PENDING_PREFS.add(rr.pref);
        continue;
      }

      rr._blob = buildSearchBlob(rr);
      real.push(rr);
    }

    DATA = real;

    el("asOf").textContent = META.asOf || "-";
    const src = META.sourcePage || "#";
    const a = el("sourceLink");
    a.href = src;
    a.textContent = "厚生労働省（公式）";

    fillPrefOptions();

    // Show a small sample list on load, but keep the "loaded" message.
    renderResults(DATA.slice(0, RESULTS_STEP), RESULTS_STEP, false);
    el("status").textContent = `${DATA.length.toLocaleString()} 件の薬局等データを読み込みました。条件を入れて検索できます。`;
  } catch (e) {
    console.error(e);
    el("status").textContent = "データの読み込みに失敗しました。";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init();
  el("btnSearch").addEventListener("click", () => doSearch(true));
  el("btnClear").addEventListener("click", () => {
    el("q").value = "";
    el("prefSelect").value = "";
    el("onlyNotCallAhead").checked = false;
    el("onlyAfterHours").checked = false;
    doSearch(true);
  });
  el("q").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") doSearch(true);
  });
  el("prefSelect").addEventListener("change", () => doSearch(true));
  el("onlyNotCallAhead").addEventListener("change", () => doSearch(true));
  el("onlyAfterHours").addEventListener("change", () => doSearch(true));
});
