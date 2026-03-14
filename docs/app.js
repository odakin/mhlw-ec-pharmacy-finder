// Emergency Contraception Pharmacy Finder (Japan) - simple client-side search
// Data source: MHLW list. See README for details.

let DATA = [];
let META = {};
let GEO_CACHE = {}; // id -> {lat, lng, lvl}
let USER_POS = null; // {lat, lng} or null
let SORT_BY_DIST = false;

// Some prefectures are listed only as "現在調整中" in the official sheet.
const PENDING_PREFS = new Set();

const el = (id) => document.getElementById(id);

// UI rendering limit (keeps the DOM light).
const RESULTS_STEP = 50;
let CURRENT_ROWS = [];
let CURRENT_LIMIT = RESULTS_STEP;

// Map state
let MAP = null;
let MAP_MARKERS = null;
let MAP_USER_MARKER = null;
let MAP_LOADED = false;
let VIEW_MODE = "list"; // "list" or "map"

// Standard prefecture order (north -> south)
const PREF_ORDER = [
  "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県",
  "茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県",
  "新潟県","富山県","石川県","福井県","山梨県","長野県",
  "岐阜県","静岡県","愛知県","三重県",
  "滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
  "鳥取県","島根県","岡山県","広島県","山口県",
  "徳島県","香川県","愛媛県","高知県",
  "福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県",
];
const PREF_RANK = new Map(PREF_ORDER.map((p, i) => [p, i]));

// ── Utility ──

function cleanValue(v) {
  if (v == null) return "";
  const s = v.toString().replace(/\u3000/g, " ").trim();
  if (s.toLowerCase() === "nan") return "";
  return s;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function normalizeText(s) {
  return (s || "").toString().toLowerCase()
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[－ー―−‐ｰ–—]/g, "-")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchBlob(r) {
  const parts = [r.pref, r.muni, r.name, r.addr, r.tel, r.url].map(cleanValue).filter(Boolean);
  return normalizeText(parts.join(" "));
}

function escapeHtml(s) {
  return (s || "").toString()
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

// ── Feature 3: Hours parsing ──

const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_MAP = { "日": 0, "月": 1, "火": 2, "水": 3, "木": 4, "金": 5, "土": 6, "祝": -1 };

function normalizeHoursText(raw) {
  let s = (raw || "").toString()
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[：∶︓︰ː]/g, ":")
    .replace(/[～〜~∼]/g, "~")
    .replace(/[－‐−⁻₋–—ー―ｰ]/g, "-")
    .replace(/[､、，]/g, ",")
    .replace(/[・･]/g, "・")
    .replace(/\s+/g, " ")
    .trim();
  // Normalize ~ to - in time ranges (9:00~18:00 -> 9:00-18:00)
  s = s.replace(/(\d{1,2}:\d{2})~(\d{1,2}:\d{2})/g, "$1-$2");
  // Normalize ~ to - in day ranges (月~金 -> 月-金)
  s = s.replace(/([月火水木金土日祝])~([月火水木金土日祝])/g, "$1-$2");
  // Strip 曜日 suffix (月曜日 -> 月)
  s = s.replace(/([月火水木金土日])曜日?/g, "$1");
  // 年中無休 / 全日 -> all days marker
  s = s.replace(/年中無休/g, "毎日");
  s = s.replace(/全日/g, "毎日");
  s = s.replace(/平日/g, "月-金");
  // 祝日 -> 祝
  s = s.replace(/祝日/g, "祝");
  // 24時間 -> all day marker
  s = s.replace(/24時間/g, "毎日:0:00-24:00");
  // Insert : between day spec and time when missing (月-土9:00 -> 月-土:9:00)
  // Also handle space separator: "月-金 9:00" -> "月-金:9:00"
  s = s.replace(/([月火水木金土日祝])\s+(\d{1,2}:\d{2})/g, "$1:$2");
  s = s.replace(/([月火水木金土日祝])(\d{1,2}:\d{2})/g, "$1:$2");
  // Insert space between consecutive time ranges (14:0015:00 -> 14:00 15:00)
  s = s.replace(/(\d{1,2}:\d{2})(\d{1,2}:\d{2})/g, "$1 $2");
  // Normalize / between time ranges to space (9:00-14:00/15:00-19:00)
  s = s.replace(/(\d{1,2}:\d{2})\/(\d{1,2}:\d{2})/g, "$1 $2");
  // Normalize 時 notation (9時-18時 -> 9:00-18:00)
  s = s.replace(/(\d{1,2})時(\d{2})分?/g, "$1:$2");
  s = s.replace(/(\d{1,2})時/g, "$1:00");
  // Normalize CJK compatibility chars (⽉→月, ⼟→土, etc)
  s = s.replace(/⽉/g, "月").replace(/⽕/g, "火").replace(/⽔/g, "水")
    .replace(/⽊/g, "木").replace(/⾦/g, "金").replace(/⼟/g, "土").replace(/⽇/g, "日");
  return s;
}

function expandDayRange(startDay, endDay) {
  const s = DAY_MAP[startDay];
  const e = DAY_MAP[endDay];
  if (s == null || e == null || s < 0 || e < 0) return null;
  const days = [];
  for (let i = s; i !== ((e + 1) % 7); i = (i + 1) % 7) {
    days.push(i);
    if (days.length > 7) break;
  }
  return days;
}

function parseDaySpec(spec) {
  // "月-金" or "月~金" -> [1,2,3,4,5]
  // "月・火・木・金" -> [1,2,4,5]
  // "月" -> [1]
  const rangeMatch = spec.match(/^([月火水木金土日祝])[-~]([月火水木金土日祝])$/);
  if (rangeMatch) return expandDayRange(rangeMatch[1], rangeMatch[2]);

  const singles = spec.split("・").map((d) => d.trim()).filter(Boolean);
  if (singles.length && singles.every((d) => DAY_MAP[d] != null)) {
    return singles.map((d) => DAY_MAP[d]).filter((d) => d >= 0);
  }
  return null;
}

function parseTimeRange(tr) {
  // "9:00-18:00" -> {open: "9:00", close: "18:00"}
  const m = tr.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!m) return null;
  return { open: m[1], close: m[2] };
}

function splitHoursSegments(text) {
  // Smart split: commas can separate day-groups OR time ranges within a day-group,
  // OR be part of a day list like "月-水,金".
  // Strategy: first split at day boundaries (after time), then handle commas within each piece.

  // Step 1: Split at day boundaries after time (handles no-comma and space-separated)
  // "月-金:9:00-18:00 土:9:00-13:00" or "月-金:9:00-18:00土:9:00-13:00"
  let pieces = text.split(/(?<=\d:\d{2})\s*(?=[月火水木金土日祝毎])/);
  pieces = pieces.map((s) => s.trim()).filter(Boolean);
  if (pieces.length > 1) {
    // Each piece may still have internal commas for time ranges
    // "月-金:9:00-14:00,15:00-19:00" -> keep together
    return pieces.map((p) => {
      // Replace commas between time ranges (not before day chars) with spaces
      return p.replace(/,(\d{1,2}:\d{2})/g, " $1");
    });
  }

  // Step 2: Comma-based split with smart merging
  const raw = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.length <= 1) return raw;

  // Merge logic: a comma-separated part that starts with a day char and contains ":"
  // is a new day-group. A part that starts with a time is an additional time range.
  // A part that is ONLY day chars (like "金" in "月-水,金:9:00-18:00") should merge
  // with the NEXT part as a day spec prefix.
  const merged = [];
  let dayPrefix = "";
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i];
    const hasDayAndTime = /^[月火水木金土日祝毎].*:.*\d{1,2}:\d{2}/.test(part);
    const isDayOnly = /^[月火水木金土日祝\-~・]+$/.test(part);
    const isTimeOnly = /^\d{1,2}:\d{2}/.test(part);

    if (dayPrefix) {
      // Prepend accumulated day prefix
      if (hasDayAndTime || isDayOnly) {
        // "月-水" + ",金:" -> merge into day spec "月-水・金:..."
        const combined = dayPrefix + "・" + part;
        if (/\d{1,2}:\d{2}/.test(combined)) {
          merged.push(combined.replace(/,(\d{1,2}:\d{2})/g, " $1"));
          dayPrefix = "";
        } else {
          dayPrefix = dayPrefix + "・" + part;
        }
      } else if (isTimeOnly) {
        // Day prefix followed by time? "月-水,金" then "9:00-18:00" - shouldn't happen
        merged.push(dayPrefix + ":" + part);
        dayPrefix = "";
      } else {
        merged.push(dayPrefix);
        dayPrefix = "";
        merged.push(part);
      }
    } else if (isDayOnly) {
      dayPrefix = part;
    } else if (hasDayAndTime) {
      merged.push(part.replace(/,(\d{1,2}:\d{2})/g, " $1"));
    } else if (isTimeOnly && merged.length) {
      merged[merged.length - 1] += " " + part;
    } else {
      merged.push(part);
    }
  }
  if (dayPrefix) merged.push(dayPrefix);
  return merged;
}

function parseDaySpecExtended(spec) {
  // Handle complex patterns: "月-水・金" "月-水,金" "月火水金" "土日祝" "月,火,水,金"
  const simple = parseDaySpec(spec);
  if (simple) return simple;

  // Split by ・ or , and process each part (may be range or single chars)
  const chars = spec.replace(/[・,]/g, "");
  if (/^[月火水木金土日祝\-~]+$/.test(chars)) {
    const rangeParts = spec.split(/[・,]/).filter(Boolean);
    const allDays = [];
    for (const rp of rangeParts) {
      const rMatch = rp.match(/^([月火水木金土日祝])[-~]([月火水木金土日祝])$/);
      if (rMatch) {
        const expanded = expandDayRange(rMatch[1], rMatch[2]);
        if (expanded) allDays.push(...expanded);
        else return null;
      } else {
        // Single or consecutive chars: "金" or "土日祝" or "月火水金"
        for (const ch of rp) {
          if (ch === "-" || ch === "~") continue;
          if (DAY_MAP[ch] == null) return null;
          // Skip 祝 (holiday, not a weekday) but don't fail
          if (DAY_MAP[ch] >= 0) allDays.push(DAY_MAP[ch]);
        }
      }
    }
    return allDays.length ? allDays : null;
  }
  return null;
}

function parseHours(raw) {
  // Returns: { schedule: [{days: [0-6], open: "9:00", close: "18:00"}, ...] } or null
  const text = normalizeHoursText(raw);
  if (!text) return null;

  const schedule = [];

  // Handle day-less patterns: "9:00-20:00" (same hours every day)
  const allDayMatch = text.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (allDayMatch) {
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    return { schedule: [{ days: allDays, open: allDayMatch[1], close: allDayMatch[2] }] };
  }

  // Handle "毎日:9:00-20:00" pattern
  const everyDayMatch = text.match(/^毎日\s*:?\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (everyDayMatch) {
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    return { schedule: [{ days: allDays, open: everyDayMatch[1], close: everyDayMatch[2] }] };
  }

  const segments = splitHoursSegments(text);

  for (const seg of segments) {
    // Pattern: daySpec:timeRange(s)
    const m = seg.match(/^([月火水木金土日祝毎][月火水木金土日祝毎\-~・,]*)\s*[:]\s*(.+)$/);
    if (!m) return null; // can't parse -> give up on entire string

    const daySpec = m[1];
    const timePart = m[2].trim();

    // "毎日" -> all days
    const days = (daySpec === "毎日" || daySpec === "毎")
      ? [0, 1, 2, 3, 4, 5, 6]
      : parseDaySpecExtended(daySpec);
    if (!days || !days.length) {
      // Skip holiday-only segments (祝:...) gracefully
      if (/^祝/.test(daySpec)) continue;
      return null;
    }

    // Time part may have multiple ranges: "9:00-12:00 14:00-18:00"
    const timeRanges = timePart.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    for (const tr of timeRanges) {
      const range = parseTimeRange(tr);
      if (!range) return null;
      schedule.push({ days, open: range.open, close: range.close });
    }
  }

  return schedule.length ? { schedule } : null;
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function getHoursInfo(raw) {
  // Returns { todayRanges: [{open, close}], isOpen, parsed: true/false, allDays: {0: [...], ...} }
  const parsed = parseHours(raw);
  if (!parsed) return { parsed: false };

  const now = new Date();
  // Force JST
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const todayDow = jst.getDay(); // 0=Sun
  const nowMin = jst.getHours() * 60 + jst.getMinutes();

  // Build per-day schedule
  const allDays = {};
  for (let d = 0; d < 7; d++) allDays[d] = [];
  for (const entry of parsed.schedule) {
    for (const d of entry.days) {
      if (d >= 0 && d < 7) {
        allDays[d].push({ open: entry.open, close: entry.close });
      }
    }
  }
  // Sort each day's ranges
  for (const d of Object.keys(allDays)) {
    allDays[d].sort((a, b) => timeToMinutes(a.open) - timeToMinutes(b.open));
  }

  const todayRanges = allDays[todayDow] || [];
  let isOpen = false;
  for (const r of todayRanges) {
    if (nowMin >= timeToMinutes(r.open) && nowMin < timeToMinutes(r.close)) {
      isOpen = true;
      break;
    }
  }

  return { parsed: true, todayRanges, isOpen, allDays, todayDow: todayDow };
}

function renderHoursHtml(raw) {
  const info = getHoursInfo(raw);
  if (!info.parsed) {
    // Fallback: show raw data
    return raw ? `<div class="detail"><span class="k">開局等時間</span> ${escapeHtml(raw)}</div>` : "";
  }

  const { todayRanges, isOpen, allDays, todayDow } = info;
  const todayName = DAY_NAMES[todayDow];

  // Today's highlight
  let todayHtml = "";
  if (todayRanges.length) {
    const badge = isOpen
      ? `<span class="badge open">営業中</span>`
      : `<span class="badge closed">営業時間外</span>`;
    const times = todayRanges.map((r) => `${r.open}-${r.close}`).join(", ");
    todayHtml = `<div class="hours-today">${badge} <strong>${todayName}曜</strong> ${times}</div>`;
  } else {
    todayHtml = `<div class="hours-today"><span class="badge closed">本日休み</span></div>`;
  }

  // Full schedule (collapsible)
  let schedHtml = `<details class="hours-full"><summary class="small">全営業時間</summary><div class="hours-grid">`;
  for (let d = 0; d < 7; d++) {
    const name = DAY_NAMES[d];
    const ranges = allDays[d];
    const cls = d === todayDow ? ' class="today"' : "";
    if (ranges.length) {
      const times = ranges.map((r) => `${r.open}-${r.close}`).join(", ");
      schedHtml += `<div${cls}><span class="day">${name}</span> ${times}</div>`;
    } else {
      schedHtml += `<div${cls}><span class="day">${name}</span> <span class="rest">休み</span></div>`;
    }
  }
  schedHtml += `</div><div class="hours-note">※営業状況は店舗にご確認ください</div></details>`;

  return todayHtml + schedHtml;
}

// ── Feature 2: Distance calculation (Haversine) ──

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeDistances() {
  if (!USER_POS) return;
  for (const r of DATA) {
    const geo = GEO_CACHE[r.id];
    if (geo && geo.lat && geo.lng) {
      r._dist = haversine(USER_POS.lat, USER_POS.lng, geo.lat, geo.lng);
    } else {
      r._dist = null;
    }
  }
}

function requestLocation() {
  const btn = el("btnNearby");
  if (!navigator.geolocation) {
    btn.textContent = "位置情報非対応";
    btn.disabled = true;
    return;
  }
  btn.textContent = "取得中…";
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      USER_POS = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      computeDistances();
      SORT_BY_DIST = true;
      btn.textContent = "📍 近い順 ✓";
      btn.disabled = false;
      btn.classList.add("active");
      doSearch(true);
      if (MAP && MAP_USER_MARKER) {
        MAP_USER_MARKER.setLatLng([USER_POS.lat, USER_POS.lng]).addTo(MAP);
      }
    },
    (err) => {
      btn.textContent = "📍 近い順";
      btn.disabled = false;
      const msgs = {
        1: "位置情報の許可が必要です。ブラウザの設定をご確認ください。",
        2: "位置情報を取得できませんでした。",
        3: "位置情報の取得がタイムアウトしました。",
      };
      alert(msgs[err.code] || "位置情報を取得できませんでした。");
    },
    { enableHighAccuracy: false, timeout: 10000 }
  );
}

// ── Feature 1: Map ──

async function loadMapLibs() {
  if (MAP_LOADED) return;
  // Leaflet CSS
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
  document.head.appendChild(css);
  // Leaflet JS
  await loadScript("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js");
  // MarkerCluster CSS
  const mcCss = document.createElement("link");
  mcCss.rel = "stylesheet";
  mcCss.href = "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css";
  document.head.appendChild(mcCss);
  const mcCss2 = document.createElement("link");
  mcCss2.rel = "stylesheet";
  mcCss2.href = "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css";
  document.head.appendChild(mcCss2);
  // MarkerCluster JS
  await loadScript("https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js");
  MAP_LOADED = true;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function loadGeoCache() {
  try {
    const resp = await fetch("geocode_cache.json", { cache: "no-cache" });
    GEO_CACHE = await resp.json();
  } catch (e) {
    console.warn("geocode_cache.json not available:", e);
    GEO_CACHE = {};
  }
}

function initMap() {
  if (MAP) return;
  const container = el("mapContainer");
  // Ensure container has height (fallback if CSS not yet loaded)
  if (!container.offsetHeight) container.style.height = "500px";
  MAP = L.map(container).setView([36.5, 137.5], 5); // Japan center
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(MAP);
  MAP_MARKERS = L.markerClusterGroup();
  MAP.addLayer(MAP_MARKERS);

  // User location marker (blue)
  const blueIcon = L.divIcon({ className: "user-marker", html: "📍", iconSize: [24, 24], iconAnchor: [12, 12] });
  MAP_USER_MARKER = L.marker([0, 0], { icon: blueIcon });
  if (USER_POS) MAP_USER_MARKER.setLatLng([USER_POS.lat, USER_POS.lng]).addTo(MAP);
}

function updateMap(rows) {
  if (!MAP || !MAP_MARKERS) return;
  MAP_MARKERS.clearLayers();

  const bounds = [];
  for (const r of rows) {
    const geo = GEO_CACHE[r.id];
    if (!geo || !geo.lat || !geo.lng) continue;

    const gmapQ = encodeURIComponent((r.name || "") + " " + (r.addr || ""));
    const gmapUrl = `https://www.google.com/maps/search/?api=1&query=${gmapQ}`;
    const popup = `<strong>${escapeHtml(r.name)}</strong><br>
      ${escapeHtml(r.addr)}<br>
      ${r.tel ? `📞 <a href="tel:${escapeHtml(r.tel)}">${escapeHtml(r.tel)}</a><br>` : ""}
      ${r.hours ? `🕐 ${escapeHtml(r.hours)}<br>` : ""}
      <a href="${gmapUrl}" target="_blank" rel="noopener">📍 Google Mapで見る</a>`;

    const marker = L.marker([geo.lat, geo.lng]).bindPopup(popup);
    MAP_MARKERS.addLayer(marker);
    bounds.push([geo.lat, geo.lng]);
  }

  if (USER_POS) bounds.push([USER_POS.lat, USER_POS.lng]);

  if (bounds.length) {
    MAP.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  }

  // Guide for large results
  const guide = el("mapGuide");
  if (guide) {
    guide.textContent = rows.length > 200
      ? `${rows.length.toLocaleString()} 件表示中。検索条件を絞ると地図が見やすくなります。`
      : "";
  }
}

function switchView(mode) {
  VIEW_MODE = mode;
  const listSection = el("listSection");
  const mapSection = el("mapSection");
  const btnList = el("btnViewList");
  const btnMap = el("btnViewMap");

  if (mode === "map") {
    listSection.style.display = "none";
    mapSection.style.display = "block";
    btnList.classList.remove("active");
    btnMap.classList.add("active");
    if (!MAP) initMap();
    setTimeout(() => MAP.invalidateSize(), 100);
    updateMap(CURRENT_ROWS);
  } else {
    listSection.style.display = "block";
    mapSection.style.display = "none";
    btnList.classList.add("active");
    btnMap.classList.remove("active");
  }
}

// ── Rendering ──

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
    const privacy = escapeHtml(r.privacy || "");
    const notes = escapeHtml(r.notes || "");
    const callAhead = (r.callAhead || "") === "要";
    const afterHoursFlag = (r.afterHours || "") === "有";

    const tel = (r.tel || "").toString();
    const telLink = tel ? `<a href="tel:${escapeHtml(tel)}">${escapeHtml(tel)}</a>` : "";
    const afterTel = (r.afterHoursTel || "").toString();
    const showAfterTel = afterTel && afterTel !== tel;
    const afterTelLink = showAfterTel ? `<a href="tel:${escapeHtml(afterTel)}">${escapeHtml(afterTel)}</a>` : "";

    const pf = toInt(r.pharmacistsFemale);
    const pm = toInt(r.pharmacistsMale);
    const pn = toInt(r.pharmacistsNoAnswer);
    const hasPharmacists = (pf + pm + pn) > 0;
    const url = (r.url || "").toString().trim();
    const urlLink = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">公式/店舗ページ</a>` : "";
    const gmapQuery = encodeURIComponent((r.name || "") + " " + (r.addr || ""));
    const gmapLink = `<a href="https://www.google.com/maps/search/?api=1&query=${gmapQuery}" target="_blank" rel="noopener">Google Mapで見る</a>`;

    // Distance display
    const distHtml = (r._dist != null)
      ? `<span class="dist">約 ${r._dist < 1 ? (r._dist * 1000).toFixed(0) + "m" : r._dist.toFixed(1) + "km"}</span>`
      : "";

    // Hours (Feature 3)
    const hoursHtml = renderHoursHtml(r.hours);

    li.innerHTML = `
      <div class="card">
        <div class="cardHead">
          <div class="name">${title} ${distHtml}</div>
          <div class="badges">
            ${callAhead ? `<span class="badge warn">事前電話：要</span>` : ``}
            ${afterHoursFlag ? `<span class="badge">時間外：有</span>` : ``}
          </div>
        </div>
        <div class="place">${place}</div>
        <div class="addr">${addr}</div>
        <div class="links">
          ${telLink ? `<span>📞 ${telLink}</span>` : ``}
          ${afterTelLink ? `<span>🌙 時間外 ${afterTelLink}</span>` : ``}
          ${urlLink ? `<span>🔗 ${urlLink}</span>` : ``}
          <span>📍 ${gmapLink}</span>
        </div>
        ${hoursHtml}
        ${hasPharmacists ? `<div class="detail"><span class="k">販売可能薬剤師（性別・人数）</span> 女性${pf} / 男性${pm} / 答えたくない${pn}</div>` : ``}
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

// ── Search ──

function doSearch(resetLimit = true) {
  const pref = cleanValue(el("prefSelect").value);
  const q = normalizeText(el("q").value);
  const onlyNotCallAhead = el("onlyNotCallAhead").checked;
  const onlyAfterHours = el("onlyAfterHours").checked;
  const hasFemale = el("hasFemale").checked;
  const terms = q ? q.split(" ").filter(Boolean) : [];

  const rows = DATA.filter((r) => {
    if (pref && r.pref !== pref) return false;
    if (onlyNotCallAhead && (r.callAhead || "") === "要") return false;
    if (onlyAfterHours && (r.afterHours || "") !== "有") return false;
    if (hasFemale && !(toInt(r.pharmacistsFemale) > 0)) return false;
    if (!terms.length) return true;
    return terms.every((t) => r._blob.includes(t));
  });

  if (!rows.length) {
    renderResults([], RESULTS_STEP, false);
    CURRENT_ROWS = [];
    if (pref && PENDING_PREFS.has(pref)) {
      el("status").textContent = `${pref} は現在調整中のため、公式リストに個別の薬局等が掲載されていません。`;
    } else {
      el("status").textContent = "該当なし。条件を変えてみてください。";
    }
    if (VIEW_MODE === "map") updateMap([]);
    return;
  }

  // Sort by distance if enabled
  if (SORT_BY_DIST && USER_POS) {
    rows.sort((a, b) => {
      const da = a._dist != null ? a._dist : Infinity;
      const db = b._dist != null ? b._dist : Infinity;
      return da - db;
    });
  }

  CURRENT_ROWS = rows;
  if (resetLimit) CURRENT_LIMIT = RESULTS_STEP;
  renderResults(CURRENT_ROWS, CURRENT_LIMIT, true);

  if (VIEW_MODE === "map") updateMap(CURRENT_ROWS);
}

function fillPrefOptions() {
  const sel = el("prefSelect");
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

// ── Init ──

async function init() {
  try {
    const [dataResp] = await Promise.all([
      fetch("data.json", { cache: "no-cache" }),
      loadGeoCache(),
    ]);
    const json = await dataResp.json();
    META = json.meta || {};

    PENDING_PREFS.clear();
    const real = [];
    for (const r of json.data || []) {
      const rr = { ...r };
      for (const k of ["pref","muni","name","addr","tel","url","hours","privacy","callAhead","afterHours","afterHoursTel","notes"]) {
        if (k in rr) rr[k] = cleanValue(rr[k]);
      }
      rr.pharmacistsFemale = toInt(rr.pharmacistsFemale);
      rr.pharmacistsMale = toInt(rr.pharmacistsMale);
      rr.pharmacistsNoAnswer = toInt(rr.pharmacistsNoAnswer);

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
    const a = el("sourceLink");
    a.href = META.sourcePage || "#";
    a.textContent = "厚生労働省（公式）";

    fillPrefOptions();
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
    el("hasFemale").checked = false;
    SORT_BY_DIST = false;
    USER_POS = null;
    const nb = el("btnNearby");
    if (nb) { nb.textContent = "📍 近い順"; nb.classList.remove("active"); }
    doSearch(true);
  });
  el("q").addEventListener("keydown", (ev) => { if (ev.key === "Enter") doSearch(true); });
  el("prefSelect").addEventListener("change", () => doSearch(true));
  el("onlyNotCallAhead").addEventListener("change", () => doSearch(true));
  el("onlyAfterHours").addEventListener("change", () => doSearch(true));
  el("hasFemale").addEventListener("change", () => doSearch(true));

  // Nearby sort button
  el("btnNearby").addEventListener("click", () => {
    if (SORT_BY_DIST) {
      SORT_BY_DIST = false;
      el("btnNearby").textContent = "📍 近い順";
      el("btnNearby").classList.remove("active");
      doSearch(true);
    } else if (USER_POS) {
      SORT_BY_DIST = true;
      el("btnNearby").classList.add("active");
      el("btnNearby").textContent = "📍 近い順 ✓";
      doSearch(true);
    } else {
      requestLocation();
    }
  });

  // View toggle
  el("btnViewList").addEventListener("click", () => switchView("list"));
  el("btnViewMap").addEventListener("click", async () => {
    await loadMapLibs();
    switchView("map");
  });
});
