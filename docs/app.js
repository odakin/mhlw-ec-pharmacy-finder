// Emergency Contraception Pharmacy Finder (Japan) - simple client-side search
// Data source: MHLW list. See README for details.

let DATA = [];
let CLINICS = [];
let CLINICS_LOADED = false;
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

async function loadClinics() {
  if (CLINICS_LOADED) return;
  try {
    const resp = await fetch("clinics.json");
    const json = await resp.json();
    const recs = [];
    for (const r of json.data || []) {
      const rr = { ...r };
      for (const k of ["pref","muni","name","addr","tel","url","hours","obgyn","stock","postal"]) {
        if (k in rr) rr[k] = cleanValue(rr[k]);
      }
      // Only include clinics with 常時在庫あり (stock starts with "有" or "あり")
      const st = (rr.stock || "").toString();
      if (!st.startsWith("有") && st !== "あり") continue;
      rr._isClinic = true;
      rr._blob = buildSearchBlob(rr);
      recs.push(rr);
    }
    CLINICS = recs;
    CLINICS_LOADED = true;
    // Compute distances if user pos is known
    if (USER_POS) {
      for (const r of CLINICS) {
        const geo = GEO_CACHE[r.id];
        if (geo && geo.lat && geo.lng) {
          r._dist = haversine(USER_POS.lat, USER_POS.lng, geo.lat, geo.lng);
        }
      }
    }
  } catch (e) {
    console.error("Failed to load clinics:", e);
  }
}

function escapeHtml(s) {
  return (s || "").toString()
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

// ── Japanese national holiday computation ──
// Based on 国民の祝日に関する法律. Valid ~1980-2099.

function getJapaneseHolidays(year) {
  // Returns Set of "YYYY-MM-DD" strings for the given year
  const holidays = [];
  const d = (m, day) => `${year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const nthMon = (month, n) => {
    // nth Monday of month
    const first = new Date(year, month - 1, 1).getDay(); // 0=Sun
    const firstMon = first <= 1 ? 2 - first : 9 - first;
    return firstMon + (n - 1) * 7;
  };

  // Fixed-date holidays
  holidays.push(d(1, 1));   // 元日
  holidays.push(d(2, 11));  // 建国記念の日
  holidays.push(d(2, 23));  // 天皇誕生日 (2020-)
  holidays.push(d(4, 29));  // 昭和の日
  holidays.push(d(5, 3));   // 憲法記念日
  holidays.push(d(5, 4));   // みどりの日
  holidays.push(d(5, 5));   // こどもの日
  holidays.push(d(8, 11));  // 山の日
  holidays.push(d(11, 3));  // 文化の日
  holidays.push(d(11, 23)); // 勤労感謝の日

  // Happy Monday holidays
  holidays.push(d(1, nthMon(1, 2)));   // 成人の日 (2nd Mon Jan)
  holidays.push(d(7, nthMon(7, 3)));   // 海の日 (3rd Mon Jul)
  holidays.push(d(9, nthMon(9, 3)));   // 敬老の日 (3rd Mon Sep)
  holidays.push(d(10, nthMon(10, 2))); // スポーツの日 (2nd Mon Oct)

  // Equinox holidays (astronomical formula, valid ~1980-2099)
  const vernalDay = Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  holidays.push(d(3, vernalDay)); // 春分の日
  const autumnalDay = Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  holidays.push(d(9, autumnalDay)); // 秋分の日

  // Helper: format Date to "YYYY-MM-DD" using local time (avoids toISOString UTC shift)
  const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;

  // 振替休日 (substitute holidays): if a holiday falls on Sunday, next Monday is a holiday
  const baseSet = new Set(holidays);
  const substitutes = [];
  for (const h of holidays) {
    const dt = new Date(h + "T00:00:00");
    if (dt.getDay() === 0) { // Sunday
      // Find next non-holiday weekday
      let sub = new Date(dt);
      do { sub.setDate(sub.getDate() + 1); }
      while (baseSet.has(fmt(sub)) || substitutes.includes(fmt(sub)));
      substitutes.push(fmt(sub));
    }
  }
  substitutes.forEach(s => baseSet.add(s));

  // 国民の休日: a day sandwiched between two holidays (mainly Sep)
  const sorted = [...baseSet].sort();
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = new Date(sorted[i] + "T00:00:00");
    const b = new Date(sorted[i + 1] + "T00:00:00");
    const diff = (b - a) / 86400000;
    if (diff === 2) {
      const mid = new Date(a);
      mid.setDate(mid.getDate() + 1);
      if (mid.getDay() !== 0) baseSet.add(fmt(mid)); // Not Sunday (would be 振替休日 instead)
    }
  }

  return baseSet;
}

// Cache per year
const _holidayCache = {};
function isJapaneseHoliday(date) {
  // date: Date object (JST)
  const y = date.getFullYear();
  if (!_holidayCache[y]) _holidayCache[y] = getJapaneseHolidays(y);
  const key = `${y}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return _holidayCache[y].has(key);
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
    .replace(/[・･•]/g, "・")
    .replace(/．/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  // Normalize ~ to - in time ranges (9:00~18:00 -> 9:00-18:00)
  s = s.replace(/(\d{1,2}:\d{2})~(\d{1,2}:\d{2})/g, "$1-$2");
  // Normalize ~ to - in day ranges (月~金 -> 月-金)
  s = s.replace(/([月火水木金土日祝])~([月火水木金土日祝])/g, "$1-$2");
  // Strip 曜日 suffix (月曜日 -> 月, but 金曜日曜 -> 金日 not 金曜)
  s = s.replace(/([月火水木金土日])曜(?:日(?!曜))?/g, "$1");
  // After 曜日 strip, insert ・ when range end abuts a bare day (月-金日 -> 月-金・日)
  s = s.replace(/([月火水木金土日])([-~])([月火水木金土日])([月火水木金土日])/g, "$1$2$3・$4");
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
  // Normalize / as segment separator (月-金:9:00-18:00/土:9:00-13:00)
  s = s.replace(/(\d{1,2}:\d{2})\/([月火水木金土日祝])/g, "$1,$2");
  // Normalize / between day spec and time (月-金/8:30-18:00 -> 月-金:8:30-18:00)
  s = s.replace(/([月火水木金土日祝])\/(\d{1,2}:\d{2})/g, "$1:$2");
  // Normalize 時 notation (9時-18時 -> 9:00-18:00)
  s = s.replace(/(\d{1,2})時(\d{2})分?/g, "$1:$2");
  s = s.replace(/(\d{1,2})時/g, "$1:00");
  // Normalize CJK compatibility chars (⽉→月, ⼟→土, etc)
  s = s.replace(/⽉/g, "月").replace(/⽕/g, "火").replace(/⽔/g, "水")
    .replace(/⽊/g, "木").replace(/⾦/g, "金").replace(/⼟/g, "土").replace(/⽇/g, "日");
  // Re-run normalizations after 時 conversion (金9時→金9:00 needs colon; 9:00~18:00 needs ~→-)
  s = s.replace(/(\d{1,2}:\d{2})~(\d{1,2}:\d{2})/g, "$1-$2");
  s = s.replace(/([月火水木金土日祝])\s+(\d{1,2}:\d{2})/g, "$1:$2");
  s = s.replace(/([月火水木金土日祝])(\d{1,2}:\d{2})/g, "$1:$2");
  // Normalize . and ． between day chars to ・ (月.火.金 -> 月・火・金)
  s = s.replace(/([月火水木金土日祝])[.．]([月火水木金土日祝])/g, "$1・$2");
  // Repeat for chains (月.火.水.木 needs multiple passes)
  s = s.replace(/([月火水木金土日祝])[.．]([月火水木金土日祝])/g, "$1・$2");
  // Normalize () / （） around time ranges to :
  s = s.replace(/([月火水木金土日祝])[（(]\s*(\d{1,2}:\d{2})/g, "$1:$2");
  s = s.replace(/(\d{1,2}:\d{2})\s*[）)]/g, "$1");
  // Normalize お休み -> 休み (must run BEFORE 休み strip patterns)
  s = s.replace(/お休み/g, "休み");
  // Strip trailing 休み/定休/休 suffixes (日・祝休み, 日祝休み, 土日祝:休み, etc.)
  s = s.replace(/[,、]\s*[月火水木金土日祝・,]+\s*[:]\s*休み?$/g, "");
  s = s.replace(/[月火水木金土日祝・,]+\s*[:]\s*休み?$/g, "");
  s = s.replace(/[月火水木金土日祝・,]+休み$/g, "");
  s = s.replace(/定休[日:].*$/g, "");
  // Strip "休:祝" / "休:日祝" type suffixes
  s = s.replace(/[,]\s*休\s*[:]\s*[月火水木金土日祝・,]+$/g, "");
  // Strip trailing 365日 suffix
  s = s.replace(/365日/g, "");
  // Strip trailing day-only text like "日" at end (月-金:...土:...日 = 日曜休み)
  // Only if the last segment is a bare day char with no time
  s = s.replace(/([,\s])([月火水木金土日祝・,]+)\s*$/g, (m, sep, days) => {
    // Keep if it looks like a day spec that should have time
    if (/[:]\s*\d/.test(days)) return m;
    // If it's "日" or "日祝" etc at the end with no time, it means closed -> strip
    if (/^[月火水木金土日祝・,]+$/.test(days)) return "";
    return m;
  });
  // Strip segments ending with empty value like "水,日,祝は" "水日祝:"
  s = s.replace(/[,]\s*[月火水木金土日祝・,]+\s*[はで:]\s*$/g, "");
  // Reversed order: "9:00-20:00毎日" -> "毎日:9:00-20:00"
  s = s.replace(/^(\d{1,2}:\d{2}-\d{1,2}:\d{2})\s*(毎日|月-日)$/, "$2:$1");
  // Normalize ; to : as separator (月-金;9:00-17:00 -> 月-金:9:00-17:00)
  s = s.replace(/([月火水木金土日祝])[;；]/g, "$1:");
  // Normalize ｡ to , (segment separator)
  s = s.replace(/｡/g, ",");
  // "祝を除く" / "祝除く" — keep marker for holidayClosed detection, then strip
  // (Detection happens in parseHours before this text is consumed)
  s = s.replace(/祝を?除く/g, "");
  // Normalize 漢数字 in ordinal day specs (第一土 -> 第1土, 第二 -> 第2, etc.)
  // Also handle comma-preceded: ,四日 -> ,4日
  s = s.replace(/([第・,])([一二三四五])/g, (_, p, k) => p + ("一二三四五".indexOf(k) + 1));
  // Normalize ordinal separators: 第1,3,5 / 第1.3.5 / 第1,第3,第5 -> 第1・3・5
  // Must run BEFORE comma-based segment splitting
  s = s.replace(/第\d+(?:[,.]\s*第?\d+)+/g, (m) => "第" + m.replace(/[,.]\s*第?/g, "・").replace(/^第/, ""));
  // Normalize ordinal-related markers for segment-level handling in parseHours
  s = s.replace(/※/g, ",");
  // Strip inline parenthesized ordinal overrides: (第2,4木:9:00-19:30) or (第2,4木曜:9:00-19:30)
  s = s.replace(/[(（]第[^)）]*\d{1,2}:\d{2}[^)）]*[)）]/g, "");
  s = s.trim();
  // Normalize "から" to "-" in day ranges (月から金 -> 月-金)
  s = s.replace(/([月火水木金土日])から([月火水木金土日])/g, "$1-$2");
  // Normalize "は" between day spec and time (月は9:00 -> 月:9:00)
  s = s.replace(/([月火水木金土日祝])は(\d{1,2}:\d{2})/g, "$1:$2");
  // Fix . used as segment separator (月-金:8:30-18:30.土:8:30-16:30)
  s = s.replace(/(\d{1,2}:\d{2})[.．]([月火水木金土日祝毎])/g, "$1,$2");
  // Fix . used as : in time (18.30 -> 18:30)
  s = s.replace(/(\d{1,2})\.(\d{2})(?=\s*[-~]|\s*$)/g, "$1:$2");
  s = s.replace(/(?<=[-~]\s*)(\d{1,2})\.(\d{2})/g, "$1:$2");
  // Fix double colon (水::9:00 -> 水:9:00)
  s = s.replace(/::/g, ":");
  // Normalize "から" in time ranges (9:00から18:00 -> 9:00-18:00)
  s = s.replace(/(\d{1,2}:\d{2})から(\d{1,2}:\d{2})/g, "$1-$2");
  // Normalize ・ between time ranges to space (9:00-13:00・14:00-18:00 -> 9:00-13:00 14:00-18:00)
  s = s.replace(/(\d{1,2}:\d{2})・(\d{1,2}:\d{2})/g, "$1 $2");
  // Normalize "が" between day spec and time (水が8:00 -> 水:8:00)
  s = s.replace(/([月火水木金土日祝])が(\d{1,2}:\d{2})/g, "$1:$2");
  // Normalize ） as separator (月火木）9:15 -> 月火木:9:15)
  s = s.replace(/([月火水木金土日祝])[）)]\s*(\d{1,2}:\d{2})/g, "$1:$2");
  // Normalize ［］ and 【】 brackets (［月］-> 月:, 【月】-> 月:)
  s = s.replace(/[［\[【]\s*([月火水木金土日祝・,\-~]+)\s*[］\]】]\s*(\d{1,2}:\d{2})/g, "$1:$2");
  // Normalize (月火金) type brackets - before time or before colon
  s = s.replace(/[（(]\s*([月火水木金土日祝・,\-~]+)\s*[）)]\s*[:]\s*/g, "$1:");
  s = s.replace(/[（(]\s*([月火水木金土日祝・,\-~]+)\s*[）)]\s*(\d{1,2}:\d{2})/g, "$1:$2");
  // Normalize hour without minutes (9-18:00 -> 9:00-18:00)
  // Match digit(s) before "-" only if not part of an existing HH:MM (not preceded by "digit:")
  s = s.replace(/(?<!\d:\d)(?<!\d:)(\d{1,2})-(\d{1,2}:\d{2})/g, (m, h, end) => {
    if (parseInt(h) <= 24) return h + ":00-" + end;
    return m;
  });
  // Space-separated day chars (月 水 木 金:8:00 -> 月・水・木・金:8:00)
  s = s.replace(/([月火水木金土日])\s+([月火水木金土日])(?=[\s:・]|$)/g, "$1・$2");
  s = s.replace(/([月火水木金土日])\s+([月火水木金土日])(?=[\s:・]|$)/g, "$1・$2");
  s = s.replace(/([月火水木金土日])\s+([月火水木金土日])(?=[\s:・]|$)/g, "$1・$2");
  // Fix 3-4 digit time without colon (1800 -> 18:00, 900 -> 9:00) in time-range context
  s = s.replace(/(\d{1,2}:\d{2})-(\d{3,4})(?!\d)/g, (_, a, b) => {
    const padded = b.padStart(4, "0");
    return `${a}-${padded.slice(0, 2)}:${padded.slice(2)}`;
  });
  s = s.replace(/(?<!\d)(\d{3,4})-(\d{1,2}:\d{2})/g, (_, a, b) => {
    const padded = a.padStart(4, "0");
    return `${padded.slice(0, 2)}:${padded.slice(2)}-${b}`;
  });
  // Both sides without colon: 900-1800 (after day:)
  s = s.replace(/(?<=[:])(\d{3,4})-(\d{3,4})(?!\d)/g, (_, a, b) => {
    const pa = a.padStart(4, "0");
    const pb = b.padStart(4, "0");
    return `${pa.slice(0, 2)}:${pa.slice(2)}-${pb.slice(0, 2)}:${pb.slice(2)}`;
  });
  // Final pass: catch day+time patterns created by earlier normalizations (e.g., after 曜日 strip)
  s = s.replace(/(\d{1,2}:\d{2})~(\d{1,2}:\d{2})/g, "$1-$2");
  s = s.replace(/([月火水木金土日祝])\s+(\d{1,2}:\d{2})/g, "$1:$2");
  s = s.replace(/([月火水木金土日祝])(\d{1,2}:\d{2})/g, "$1:$2");
  // Strip trailing closed-day text missed by earlier passes
  s = s.replace(/[,]\s*[月火水木金土日祝・,]+\s*[はで:]\s*$/g, "");
  return s;
}

function expandDayRange(startDay, endDay) {
  const s = DAY_MAP[startDay];
  const e = DAY_MAP[endDay];
  if (s == null || e == null || s < 0 || e < 0) return null;
  // Same start/end means all 7 days (月-月) or single day handled elsewhere
  if (s === e) return [s];
  const days = [];
  let i = s;
  do {
    days.push(i);
    i = (i + 1) % 7;
  } while (i !== (e + 1) % 7 && days.length <= 7);
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
  // Also accept ~ as separator (in case normalization missed a tilde variant)
  const m = tr.match(/^(\d{1,2}:\d{2})\s*[-~]\s*(\d{1,2}:\d{2})$/);
  if (!m) return null;
  // Validate: hours 0-29 (Japan late-night convention: 25:00=1AM), minutes 0-59
  const [oh, om] = m[1].split(":").map(Number);
  const [ch, cm] = m[2].split(":").map(Number);
  if (oh > 29 || om > 59 || ch > 29 || cm > 59) return null;
  return { open: m[1], close: m[2] };
}

function splitHoursSegments(text) {
  // Smart split: commas can separate day-groups OR time ranges within a day-group,
  // OR be part of a day list like "月-水,金".
  // Strategy: first split at day boundaries (after time), then handle commas within each piece.

  // Step 1: Split at day boundaries after time (handles no-comma and space-separated)
  // "月-金:9:00-18:00 土:9:00-13:00" or "月-金:9:00-18:00土:9:00-13:00"
  let pieces = text.split(/(?<=\d:\d{2})\s*(?=[月火水木金土日祝毎第])/);
  pieces = pieces.map((s) => s.trim()).filter(Boolean);

  // If first-pass split found multiple pieces, apply comma-based splitting to each
  // (a piece may still contain "月-金:9:00-18:00,土:9:00-13:00")
  const toSplit = pieces.length > 1 ? pieces : [text];
  const allSegments = [];
  for (const piece of toSplit) {
    const raw = piece.split(",").map((s) => s.trim()).filter(Boolean);
    if (raw.length <= 1) { allSegments.push(piece); continue; }

    // Merge logic: a comma-separated part that starts with a day char and contains ":"
    // is a new day-group. A part that starts with a time is an additional time range.
    // A part that is ONLY day chars (like "金" in "月-水,金:9:00-18:00") should merge
    // with the NEXT part as a day spec prefix.
    const merged = [];
    let dayPrefix = "";
    for (let i = 0; i < raw.length; i++) {
      const part = raw[i];
      const hasDayAndTime = /^[月火水木金土日祝毎第].*:.*\d{1,2}:\d{2}/.test(part);
      const isDayOnly = /^[月火水木金土日祝第\d\-~・]+$/.test(part);
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
    allSegments.push(...merged);
  }
  return allSegments;
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
  // Returns: { schedule: [{days: [0-6], open, close}, ...], holidaySchedule: [{open, close}], holidayClosed: bool } or null
  if (!raw) return null;

  // Detect holidayClosed from raw text BEFORE normalization strips it
  const rawNorm = (raw || "").toString()
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[・･•]/g, "・").replace(/[;；]/g, ";")
    .replace(/祝祭日/g, "祝").replace(/祝日/g, "祝");
  const holidayClosed = /祝[・:：は;]?\s*(休|閉局|定休|休業|休日|終日閉局)/.test(rawNorm)
    || /[月火水木金土日][・,]?祝[・:：は;]?\s*(休|閉局|定休|休業|休日|終日閉局)/.test(rawNorm)
    || /休[業日]?\s*[：:;]?\s*[月火水木金土日曜・,\s]*祝/.test(rawNorm)
    || /定休[日]?\s*[：:;\s]*[月火水木金土日・,\s]*祝/.test(rawNorm)
    || /祝を?除く/.test(rawNorm)
    || /[（(]祝[・年末年始]*除く[）)]/.test(rawNorm);

  const text = normalizeHoursText(raw);
  if (!text) return null;

  const schedule = [];
  const holidaySchedule = [];

  // Handle day-less patterns: "9:00-20:00" or "9:00-13:00 14:00-18:00" or "9:00-13:00,14:00-18:00"
  const allDayMatch = text.match(/^(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})([\s,]+\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})*$/);
  if (allDayMatch) {
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    const ranges = text.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    const sched = [];
    for (const r of ranges) {
      const m = r.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (m) sched.push({ days: allDays, open: m[1], close: m[2] });
    }
    if (sched.length) return { schedule: sched, holidaySchedule: [], holidayClosed };
  }

  // Handle "毎日:9:00-20:00" pattern
  const everyDayMatch = text.match(/^毎日\s*:?\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (everyDayMatch) {
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    return { schedule: [{ days: allDays, open: everyDayMatch[1], close: everyDayMatch[2] }], holidaySchedule: [], holidayClosed };
  }

  const segments = splitHoursSegments(text);

  for (let seg of segments) {
    // Handle (第N) qualifiers on day specs
    // "水・土(第1・3・4):9:00-13:00" -> strip the qualified day, keep others: "水:9:00-13:00"
    // "土(第1-3):8:30-18:00" -> single day with ordinal, skip entire segment
    // Skip ordinal+closed segments (第3土休み, etc.)
    if (/^第[\d・]+[月火水木金土日].*(休み?|閉局|定休)/.test(seg)) continue;
    // Skip orphaned ordinal markers (第3, 第1・3) left after normalization stripped 休み
    if (/^第[\d・]+$/.test(seg)) continue;

    if (/[(（]第/.test(seg)) {
      // Remove "day(第...)" portions: 土(第1-3) -> empty, 水・土(第1・3・4) -> 水
      seg = seg.replace(/[月火水木金土日]\s*[(（]第[^)）]*[)）]/g, "");
      seg = seg.replace(/^[・,\s]+/, "").replace(/[・,\s]+$/, "");
      seg = seg.replace(/[・,]+[・,]/g, "・"); // clean double separators
      if (!seg || !/[月火水木金土日]/.test(seg)) continue; // nothing left -> skip
      // After stripping ordinal qualifiers, insert : if day char directly precedes time
      seg = seg.replace(/([月火水木金土日])(\d{1,2}:\d{2})/g, "$1:$2");
    }

    // Skip closed-day segments without colon (日祝 休み, 日祝休業, etc.)
    if (/^[月火水木金土日祝・,\s]+(休み?|閉局|定休|休業)\s*$/.test(seg)) continue;

    // Pattern: daySpec:timeRange(s)
    const m = seg.match(/^([月火水木金土日祝毎第\d][月火水木金土日祝毎第\d\-~・,]*)\s*[:]\s*(.+)$/);
    if (!m) return null; // can't parse -> give up on entire string

    let daySpec = m[1];
    const timePart = m[2].trim();

    // Skip segments indicating closed days (休み, 閉局, 休, empty)
    if (/^(休み?|閉局|定休)\s*$/.test(timePart) || !timePart) continue;

    // Handle ordinal in daySpec: strip 第N portions, keep regular days
    // "第1.3.5土" -> pure ordinal, skip entirely
    // "月・火・木・金・第1.3.5土" -> strip ordinal, keep "月・火・木・金"
    if (/第\d/.test(daySpec)) {
      // Remove ordinal portions: 第 followed by digits/separators until a day char (inclusive)
      daySpec = daySpec.replace(/第[\d・,.第\-\s]+[月火水木金土日]/g, "");
      // Clean up separators
      daySpec = daySpec.replace(/^[・,\s]+/, "").replace(/[・,\s]+$/, "");
      if (!daySpec) continue; // pure ordinal segment -> skip
    }

    // "毎日" -> all days
    const days = (daySpec === "毎日" || daySpec === "毎")
      ? [0, 1, 2, 3, 4, 5, 6]
      : parseDaySpecExtended(daySpec);

    // Check if this daySpec includes 祝
    const hasHoliday = /祝/.test(daySpec);

    if (!days || !days.length) {
      // Holiday-only segments (祝:...) -> capture into holidaySchedule
      if (hasHoliday) {
        const timeRanges = timePart.split(/\s+/).map((t) => t.trim()).filter(Boolean);
        for (const tr of timeRanges) {
          const range = parseTimeRange(tr);
          if (range) holidaySchedule.push({ open: range.open, close: range.close });
        }
        continue;
      }
      return null;
    }

    // Time part may have multiple ranges: "9:00-12:00 14:00-18:00"
    const timeRanges = timePart.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    for (const tr of timeRanges) {
      const range = parseTimeRange(tr);
      if (!range) {
        // Skip unparseable time ranges in otherwise valid segments (graceful)
        continue;
      }
      schedule.push({ days, open: range.open, close: range.close });
      // If daySpec includes 祝 (e.g. 日祝, 土日祝), also capture as holiday hours
      if (hasHoliday) {
        holidaySchedule.push({ open: range.open, close: range.close });
      }
    }
  }

  return schedule.length ? { schedule, holidaySchedule, holidayClosed } : null;
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Compute JST time context once per render cycle (avoids expensive toLocaleString per card)
function getJstContext() {
  const now = new Date();
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const todayDow = jst.getDay();
  const nowMin = jst.getHours() * 60 + jst.getMinutes();
  const isHoliday = isJapaneseHoliday(jst);
  const yesterday = new Date(jst);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIsHoliday = isJapaneseHoliday(yesterday);
  return { todayDow, nowMin, isHoliday, yesterdayIsHoliday };
}

function getHoursInfo(raw, ctx) {
  // Returns { todayRanges, isOpen, parsed, allDays, todayDow, isHoliday, holidaySchedule, holidayClosed }
  // ctx: optional pre-computed JST context from getJstContext()
  const parsed = parseHours(raw);
  if (!parsed) return { parsed: false };

  if (!ctx) ctx = getJstContext();
  const { todayDow, nowMin, isHoliday, yesterdayIsHoliday } = ctx;

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

  // Holiday schedule (sorted)
  const holidayRanges = (parsed.holidaySchedule || []).slice()
    .sort((a, b) => timeToMinutes(a.open) - timeToMinutes(b.open));
  const holidayClosed = parsed.holidayClosed || false;

  // Determine today's effective ranges
  let todayRanges;
  let todayUsingHoliday = false; // true if holiday override is active
  if (isHoliday) {
    if (holidayClosed) {
      todayRanges = [];
      todayUsingHoliday = true;
    } else if (holidayRanges.length) {
      todayRanges = holidayRanges;
      todayUsingHoliday = true;
    } else {
      // No holiday info -> fall back to regular weekday schedule
      todayRanges = allDays[todayDow] || [];
    }
  } else {
    todayRanges = allDays[todayDow] || [];
  }

  // Also check yesterday's late-night ranges (close > 24:00 means past midnight)
  const yesterdayDow = (todayDow + 6) % 7;
  let yesterdayRanges = allDays[yesterdayDow] || [];
  // If yesterday was a holiday, use holiday ranges instead
  if (yesterdayIsHoliday) {
    if (holidayClosed) {
      yesterdayRanges = [];
    } else if (holidayRanges.length) {
      yesterdayRanges = holidayRanges;
    }
  }

  let isOpen = false;
  // Check today's ranges
  for (const r of todayRanges) {
    if (nowMin >= timeToMinutes(r.open) && nowMin < timeToMinutes(r.close)) {
      isOpen = true;
      break;
    }
  }
  // Check yesterday's late-night ranges (close > 24:00 spills into today)
  if (!isOpen) {
    for (const r of yesterdayRanges) {
      const closeMin = timeToMinutes(r.close);
      if (closeMin > 1440) { // > 24:00
        // nowMin is in today; yesterday's range spills over by (closeMin - 1440) minutes
        if (nowMin < closeMin - 1440) {
          isOpen = true;
          break;
        }
      }
    }
  }

  return {
    parsed: true, todayRanges, isOpen, allDays, todayDow,
    isHoliday, todayUsingHoliday, holidayRanges, holidayClosed
  };
}

function renderHoursHtml(raw, info) {
  if (!info) info = getHoursInfo(raw);
  if (!info.parsed) {
    // Fallback: show raw data
    return raw ? `<div class="detail"><span class="k">開局等時間</span> ${escapeHtml(raw)}</div>` : "";
  }

  const { todayRanges, isOpen, allDays, todayDow, isHoliday, todayUsingHoliday, holidayRanges, holidayClosed } = info;
  const todayName = DAY_NAMES[todayDow];
  const holidayLabel = isHoliday ? "（祝日）" : "";

  // Today's highlight
  let todayHtml = "";
  if (todayRanges.length) {
    const badgeText = isOpen
      ? (todayUsingHoliday ? "営業中（祝日時間）" : "営業中")
      : "営業時間外";
    const badge = isOpen
      ? `<span class="badge open">${badgeText}</span>`
      : `<span class="badge closed">${badgeText}</span>`;
    const times = todayRanges.map((r) => `${r.open}-${r.close}`).join(", ");
    todayHtml = `<div class="hours-today">${badge} <strong>${todayName}曜${holidayLabel}</strong> ${times}</div>`;
  } else {
    const closedText = todayUsingHoliday ? "本日休み（祝日）" : "本日休み";
    todayHtml = `<div class="hours-today"><span class="badge closed">${closedText}</span></div>`;
  }

  // Full schedule (collapsible) — Monday-first order
  const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // 月火水木金土日
  let schedHtml = `<details class="hours-full"><summary class="small">全営業時間</summary><div class="hours-grid">`;
  for (const d of dayOrder) {
    const name = DAY_NAMES[d];
    const ranges = allDays[d];
    const cls = (d === todayDow && !todayUsingHoliday) ? ' class="today"' : "";
    if (ranges.length) {
      const times = ranges.map((r) => `${r.open}-${r.close}`).join(", ");
      schedHtml += `<div${cls}><span class="day">${name}</span> ${times}</div>`;
    } else {
      schedHtml += `<div${cls}><span class="day">${name}</span> <span class="rest">休み</span></div>`;
    }
  }
  // Holiday row (only if pharmacy has holiday-specific data)
  if (holidayRanges.length || holidayClosed) {
    const holCls = todayUsingHoliday ? ' class="today holiday-row"' : ' class="holiday-row"';
    if (holidayClosed) {
      schedHtml += `<div${holCls}><span class="day">祝</span> <span class="rest">休み</span></div>`;
    } else {
      const times = holidayRanges.map((r) => `${r.open}-${r.close}`).join(", ");
      schedHtml += `<div${holCls}><span class="day">祝</span> ${times}</div>`;
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
  // Also compute for clinics (if loaded)
  for (const r of CLINICS) {
    const geo = GEO_CACHE[r.id];
    if (geo && geo.lat && geo.lng) {
      r._dist = haversine(USER_POS.lat, USER_POS.lng, geo.lat, geo.lng);
    } else {
      r._dist = null;
    }
  }
}

function confirmAndRequestLocation() {
  const btn = el("btnNearby");
  if (!navigator.geolocation) {
    btn.textContent = "位置情報非対応";
    btn.disabled = true;
    return;
  }

  // If already acquired, toggle sort
  if (USER_POS) {
    SORT_BY_DIST = !SORT_BY_DIST;
    btn.classList.toggle("active", SORT_BY_DIST);
    btn.textContent = SORT_BY_DIST ? "📍 近い順 ✓" : "📍 近い順";
    doSearch(true);
    return;
  }

  // Show inline privacy panel on first click
  const existing = document.getElementById("nearbyPanel");
  if (existing) { existing.remove(); return; } // toggle off if already open

  const panel = document.createElement("div");
  panel.id = "nearbyPanel";
  panel.className = "nearby-panel";
  panel.innerHTML =
    '<p class="nearby-panel-text">' +
      '現在地から近い薬局を探すために、ブラウザの位置情報機能を使用します。' +
    '</p>' +
    '<ul class="nearby-panel-list">' +
      '<li>位置情報はお使いの<strong>ブラウザ内だけ</strong>で使います</li>' +
      '<li>記録や外部への送信は<strong>一切しません</strong></li>' +
    '</ul>' +
    '<p class="nearby-panel-text">この後、ブラウザから位置情報の許可を求められます。</p>' +
    '<div class="nearby-panel-actions">' +
      '<button type="button" id="nearbyConfirm">位置情報を使って近い順に並べる</button>' +
      '<button type="button" id="nearbyCancel" class="ghost">やめる</button>' +
    '</div>';

  // Insert panel after the results toolbar
  btn.closest(".results-actions").after(panel);
  panel.scrollIntoView({ behavior: "smooth", block: "center" });

  document.getElementById("nearbyCancel").addEventListener("click", () => panel.remove());
  document.getElementById("nearbyConfirm").addEventListener("click", () => {
    panel.remove();
    btn.textContent = "取得中…";
    btn.disabled = true;
    requestGeolocation(btn);
  });
}

function requestGeolocation(btn) {
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
    const resp = await fetch("geocode_cache.json");
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

    const markerOpts = {};
    if (r._isClinic) {
      if (!updateMap._redIcon) {
        const base = L.Icon.Default.imagePath;
        updateMap._redIcon = L.icon({
          iconUrl: base + 'marker-icon.png',
          iconRetinaUrl: base + 'marker-icon-2x.png',
          shadowUrl: base + 'marker-shadow.png',
          iconSize: [25, 41],
          iconAnchor: [12, 41],
          shadowSize: [41, 41],
          popupAnchor: [1, -34],
          className: 'marker-clinic',
        });
      }
      markerOpts.icon = updateMap._redIcon;
    }
    const marker = L.marker([geo.lat, geo.lng], markerOpts).bindPopup(popup);
    MAP_MARKERS.addLayer(marker);
    bounds.push([geo.lat, geo.lng]);
  }

  if (USER_POS) bounds.push([USER_POS.lat, USER_POS.lng]);

  if (bounds.length) {
    // When sorting by distance, zoom to nearby area instead of all results
    if (SORT_BY_DIST && USER_POS && bounds.length > 5) {
      // Use user position + nearest ~5 results for a useful zoom level
      const nearBounds = bounds
        .map(b => ({ b, d: haversine(USER_POS.lat, USER_POS.lng, b[0], b[1]) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 5)
        .map(x => x.b);
      MAP.fitBounds(nearBounds, { padding: [30, 30], maxZoom: 15 });
    } else {
      MAP.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    }
  }

  // Guide for large results (only when no prefecture is selected and not in nearby mode)
  const guide = el("mapGuide");
  if (guide) {
    const prefSelected = el("prefSelect") && el("prefSelect").value;
    const showTip = rows.length > 200 && !SORT_BY_DIST && !prefSelected;
    guide.textContent = showTip
      ? `${rows.length.toLocaleString()} 件表示中。都道府県を選ぶと地図が見やすくなります。`
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

function renderResults(rows, limit = RESULTS_STEP, updateStatus = true, pharmacyCount = 0, clinicCount = 0) {
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
    if (clinicCount > 0) {
      el("status").textContent = `${rows.length.toLocaleString()} 件ヒット（薬局 ${pharmacyCount.toLocaleString()} + 医療機関 ${clinicCount.toLocaleString()}、${show.length.toLocaleString()} 件表示）`;
    } else {
      el("status").textContent = `${rows.length.toLocaleString()} 件ヒット（${show.length.toLocaleString()} 件表示）`;
    }
  }

  // Compute JST context once for the entire render batch
  const jstCtx = getJstContext();

  for (const r of show) {
    const li = document.createElement("li");
    const isClinic = r._isClinic;
    const title = escapeHtml(r.name || "(名称不明)");
    const place = escapeHtml([r.pref, r.muni].filter(Boolean).join(" "));
    const addr = escapeHtml(r.addr || "");

    const tel = (r.tel || "").toString();
    const telLink = tel ? `<a href="tel:${escapeHtml(tel)}">${escapeHtml(tel)}</a>` : "";
    const url = (r.url || "").toString().trim();
    const urlLink = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">公式ページ</a>` : "";
    const gmapQuery = encodeURIComponent((r.name || "") + " " + (r.addr || ""));
    const gmapLink = `<a href="https://www.google.com/maps/search/?api=1&query=${gmapQuery}" target="_blank" rel="noopener">Google Mapで見る</a>`;

    // Distance display
    const distHtml = (r._dist != null)
      ? `<span class="dist">約 ${r._dist < 1 ? (r._dist * 1000).toFixed(0) + "m" : r._dist.toFixed(1) + "km"}</span>`
      : "";

    if (isClinic) {
      // Clinic card
      li.innerHTML = `
        <div class="card clinic-card">
          <div class="cardHead">
            <div class="name">${title} ${distHtml}</div>
            <div class="badges">
              <span class="clinic-label">医療機関</span>
              <span class="badge">常時在庫あり</span>
            </div>
          </div>
          <div class="place">${place}</div>
          <div class="addr">${addr}</div>
          <div class="links">
            ${telLink ? `<span>📞 ${telLink}</span>` : ``}
            ${urlLink ? `<span>🔗 ${urlLink}</span>` : ``}
            <span>📍 ${gmapLink}</span>
          </div>
          ${r.hours ? `<div class="detail"><span class="k">対応可能時間帯</span> ${escapeHtml(r.hours)}</div>` : ``}
          <div class="clinic-rx-note">※医師の対面診察・処方箋が必要です</div>
        </div>
      `;
    } else {
      // Pharmacy card (existing)
      const privacy = escapeHtml(r.privacy || "");
      const notes = escapeHtml(r.notes || "");
      const callAhead = (r.callAhead || "") === "要";
      const afterHoursFlag = (r.afterHours || "") === "有";
      const afterTel = (r.afterHoursTel || "").toString();
      const showAfterTel = afterTel && afterTel !== tel;
      const afterTelLink = showAfterTel ? `<a href="tel:${escapeHtml(afterTel)}">${escapeHtml(afterTel)}</a>` : "";

      const pf = toInt(r.pharmacistsFemale);
      const pm = toInt(r.pharmacistsMale);
      const pn = toInt(r.pharmacistsNoAnswer);
      const hasPharmacists = (pf + pm + pn) > 0;

      // Hours (Feature 3)
      const hoursInfo = getHoursInfo(r.hours, jstCtx);
      const hoursHtml = renderHoursHtml(r.hours, hoursInfo);
      const isClosed = hoursInfo.parsed && !hoursInfo.isOpen;
      const afterHoursNote = (isClosed && afterHoursFlag)
        ? `<div class="after-hours-note">🌙 時間外対応あり${showAfterTel ? ` — 📞 ${afterTelLink}` : (tel ? ` — 📞 ${telLink}` : ``)}</div>`
        : "";

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
          ${afterHoursNote}
          ${hasPharmacists ? `<div class="detail"><span class="k">販売可能薬剤師（性別・人数）</span> 女性${pf} / 男性${pm} / 答えたくない${pn}</div>` : ``}
          ${privacy ? `<div class="detail"><span class="k">プライバシー</span> ${privacy}</div>` : ``}
          ${notes ? `<div class="detail"><span class="k">備考</span> ${notes}</div>` : ``}
        </div>
      `;
    }
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

const BASE_TITLE = "緊急避妊薬 販売可能な薬局検索";

function syncUrlFromState() {
  const params = new URLSearchParams();
  const pref = el("prefSelect").value;
  const q = el("q").value.trim();
  if (pref) params.set("pref", pref);
  if (q) params.set("q", q);
  if (el("hasFemale").checked) params.set("female", "1");
  if (el("onlyNotCallAhead").checked) params.set("nocall", "1");
  if (el("onlyAfterHours").checked) params.set("after", "1");
  if (el("showClinics").checked) params.set("clinic", "1");
  const qs = params.toString();
  const url = qs ? "?" + qs : location.pathname;
  if (location.search !== (qs ? "?" + qs : "")) {
    history.pushState(null, "", url);
  }
  // Update page title for SEO & browser tab
  document.title = pref ? `${pref}の緊急避妊薬 薬局一覧 — ${BASE_TITLE}` : BASE_TITLE;
}

function restoreStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const pref = params.get("pref") || "";
  const q = params.get("q") || "";
  el("prefSelect").value = pref;
  el("q").value = q;
  el("hasFemale").checked = params.get("female") === "1";
  el("onlyNotCallAhead").checked = params.get("nocall") === "1";
  el("onlyAfterHours").checked = params.get("after") === "1";
  el("showClinics").checked = params.get("clinic") === "1";
}

function showClinicBanner(pharmacyCount, clinicsAlreadyShown) {
  // Remove existing banner
  const old = document.querySelector(".clinic-banner");
  if (old) old.remove();
  // Show suggestion when few pharmacy results and clinics not toggled
  if (pharmacyCount <= 5 && !clinicsAlreadyShown && CLINICS_LOADED) {
    const banner = document.createElement("div");
    banner.className = "clinic-banner";
    banner.innerHTML = `薬局が見つかりにくい場合、常時在庫ありの医療機関（対面診療）も検索できます。<button type="button" id="btnShowClinics">🏥 医療機関も表示</button>`;
    const toolbar = document.querySelector(".results-toolbar");
    if (toolbar) toolbar.after(banner);
    banner.querySelector("#btnShowClinics").addEventListener("click", () => {
      el("showClinics").checked = true;
      doSearch(true);
    });
  }
}

function doSearch(resetLimit = true) {
  const pref = cleanValue(el("prefSelect").value);
  const q = normalizeText(el("q").value);
  const onlyNotCallAhead = el("onlyNotCallAhead").checked;
  const onlyAfterHours = el("onlyAfterHours").checked;
  const hasFemale = el("hasFemale").checked;
  const showClinics = el("showClinics").checked;
  const terms = q ? q.split(" ").filter(Boolean) : [];
  syncUrlFromState();

  // Filter pharmacies
  const pharmacyRows = DATA.filter((r) => {
    if (pref && r.pref !== pref) return false;
    if (onlyNotCallAhead && (r.callAhead || "") === "要") return false;
    if (onlyAfterHours && (r.afterHours || "") !== "有") return false;
    if (hasFemale && !(toInt(r.pharmacistsFemale) > 0)) return false;
    if (!terms.length) return true;
    return terms.every((t) => r._blob.includes(t));
  });

  // Filter clinics (if toggled on)
  let clinicRows = [];
  if (showClinics && CLINICS_LOADED) {
    clinicRows = CLINICS.filter((r) => {
      if (pref && r.pref !== pref) return false;
      // Pharmacy-specific filters don't apply to clinics
      if (!terms.length) return true;
      return terms.every((t) => r._blob.includes(t));
    });
  }

  // Merge results
  let rows;
  if (SORT_BY_DIST && USER_POS) {
    rows = [...pharmacyRows, ...clinicRows];
    rows.sort((a, b) => {
      const da = a._dist != null ? a._dist : Infinity;
      const db = b._dist != null ? b._dist : Infinity;
      return da - db;
    });
  } else if (clinicRows.length > 0) {
    // Interleave: distribute clinics proportionally among pharmacies
    rows = [];
    const P = pharmacyRows.length, C = clinicRows.length;
    let pi = 0, ci = 0;
    // Ratio of pharmacies per clinic (at least 1)
    const ratio = P > 0 ? Math.max(1, Math.floor(P / C)) : 0;
    while (pi < P || ci < C) {
      // Insert `ratio` pharmacies, then 1 clinic
      for (let k = 0; k < ratio && pi < P; k++) rows.push(pharmacyRows[pi++]);
      if (ci < C) rows.push(clinicRows[ci++]);
    }
    // Append any remaining pharmacies
    while (pi < P) rows.push(pharmacyRows[pi++]);
  } else {
    rows = pharmacyRows;
  }

  if (!rows.length) {
    renderResults([], RESULTS_STEP, false);
    CURRENT_ROWS = [];
    if (pref && PENDING_PREFS.has(pref)) {
      el("status").textContent = `${pref} は現在調整中のため、公式リストに個別の薬局が掲載されていません。`;
    } else {
      el("status").textContent = "該当なし。条件を変えてみてください。";
    }
    if (VIEW_MODE === "map") updateMap([]);
    return;
  }

  CURRENT_ROWS = rows;
  if (resetLimit) CURRENT_LIMIT = RESULTS_STEP;
  renderResults(CURRENT_ROWS, CURRENT_LIMIT, true, pharmacyRows.length, clinicRows.length);

  // Show clinic suggestion banner when few pharmacy results and clinics not yet shown
  showClinicBanner(pharmacyRows.length, showClinics);

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
      fetch("data.json"),
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
    const hiCount = el("hiCount");
    if (hiCount) hiCount.textContent = DATA.length.toLocaleString() + " 件";
    const a = el("sourceLink");
    a.href = META.sourcePage || "#";
    a.textContent = "厚生労働省（公式）";

    fillPrefOptions();
    restoreStateFromUrl();

    // Load clinics if URL has clinic=1, otherwise preload in background
    if (el("showClinics").checked) {
      await loadClinics();
    } else {
      loadClinics(); // fire-and-forget preload
    }

    doSearch(true);
    if (!el("prefSelect").value && !el("q").value && !el("showClinics").checked) {
      el("status").textContent = `${DATA.length.toLocaleString()} 件の薬局データを読み込みました。条件を入れて検索できます。`;
    }
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
    el("showClinics").checked = false;
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
  el("showClinics").addEventListener("change", async () => {
    if (el("showClinics").checked && !CLINICS_LOADED) {
      await loadClinics();
      if (!CLINICS_LOADED) {
        // Load failed — uncheck and notify
        el("showClinics").checked = false;
        el("status").textContent = "医療機関データの読み込みに失敗しました。しばらくしてからお試しください。";
        return;
      }
    }
    doSearch(true);
  });

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
      confirmAndRequestLocation();
    }
  });

  // View toggle
  el("btnViewList").addEventListener("click", () => switchView("list"));
  el("btnViewMap").addEventListener("click", async () => {
    await loadMapLibs();
    switchView("map");
  });

  // Highlight cards as shortcuts
  const hiAll = el("hiAll");
  if (hiAll) hiAll.addEventListener("click", () => {
    el("btnClear").click();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  const hiMap = el("hiMap");
  if (hiMap) hiMap.addEventListener("click", async () => {
    await loadMapLibs();
    switchView("map");
    if (!USER_POS) confirmAndRequestLocation();
  });
  const hiFemale = el("hiFemale");
  if (hiFemale) hiFemale.addEventListener("click", () => {
    const cb = el("hasFemale");
    cb.checked = !cb.checked;
    doSearch(true);
    cb.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // URL back/forward navigation
  window.addEventListener("popstate", () => {
    restoreStateFromUrl();
    doSearch(true);
  });
});
