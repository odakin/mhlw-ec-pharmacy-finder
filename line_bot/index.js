import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import fs from "fs";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error("Missing env vars: LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET");
  process.exit(1);
}

const app = express();
const client = new Client(config);

// Load data (generated from MHLW list)
const DB = JSON.parse(fs.readFileSync("./data.json", "utf-8"));
const META = DB.meta || {};
const DATA = (DB.data || []).map(r => ({
  ...r,
  _blob: normalizeText([r.pref, r.muni, r.name, r.addr].filter(Boolean).join(" "))
}));

const PREFS = Array.from(new Set(DATA.map(r => r.pref))).filter(Boolean);

function normalizeText(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function detectPref(text) {
  const t = text.replace(/\s+/g, "");
  // allow forms like 東京 / 東京都
  for (const p of PREFS) {
    const short = p.replace(/[都道府県]$/, ""); // 東京都 -> 東京
    if (t.includes(p) || (short && t.includes(short))) return p;
  }
  return "";
}

function search(text) {
  const pref = detectPref(text);
  const terms = normalizeText(text).split(" ").filter(Boolean);

  let rows = DATA;
  if (pref) rows = rows.filter(r => r.pref === pref);

  // remove pref tokens to avoid overly strict matching
  const terms2 = terms.filter(t => !(pref && (t === pref.toLowerCase() || t === pref.replace(/[都道府県]$/, "").toLowerCase())));
  if (terms2.length) {
    rows = rows.filter(r => terms2.every(t => r._blob.includes(t)));
  }
  return rows.slice(0, 5);
}

function formatResult(r) {
  const tel = r.tel ? `📞 ${r.tel}` : "";
  const afterTel = (r.afterHoursTel && r.afterHoursTel !== r.tel) ? `🌙 時間外: ${r.afterHoursTel}` : "";
  const url = r.url ? `🔗 ${r.url}` : "";
  const callAhead = (r.callAhead || "") === "要" ? "（事前電話：要）" : "";

  const pf = toInt(r.pharmacistsFemale);
  const pm = toInt(r.pharmacistsMale);
  const pn = toInt(r.pharmacistsNoAnswer);
  const pharma = (pf + pm + pn) > 0 ? `薬剤師（性別・人数）: 女性${pf} 男性${pm} 答えたくない${pn}` : "";
  return [
    `🏥 ${r.name || ""} ${callAhead}`,
    `${r.pref || ""}${r.muni ? " " + r.muni : ""}`,
    `${r.addr || ""}`,
    [tel, afterTel, url, pharma].filter(Boolean).join("\n")
  ].filter(Boolean).join("\n");
}

function helpMessage() {
  return [
    "緊急避妊薬（要指導医薬品）販売可能な薬局を検索します。",
    "",
    "使い方：",
    "・例：『東京 港区』、『仙台 泉区』、『ツルハ 新潟』",
    "・都道府県名（例：東京/東京都）を入れると絞り込みます。",
    "",
    `データ時点：${META.asOf || "-"}（厚労省リスト）`,
    `${META.sourcePage || ""}`,
    "",
    "注意：来局前に在庫や販売可能な薬剤師の勤務状況を電話で確認することが推奨されています。"
  ].join("\n");
}

app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = (event.message.text || "").trim();
  if (!text) return;

  if (["help", "使い方", "ヘルプ", "？", "?"].includes(text)) {
    return client.replyMessage(event.replyToken, { type: "text", text: helpMessage() });
  }

  const hits = search(text);
  if (!hits.length) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "見つかりませんでした。都道府県名や市区町村名を追加してみてください（例：東京 港区）。\n" + helpMessage()
    });
  }

  const msg = [
    `検索: ${text}`,
    `上位 ${hits.length} 件（来局前に電話確認推奨）`,
    "",
    ...hits.map(formatResult),
    "",
    `出典: ${META.sourcePage || ""}`
  ].join("\n");

  return client.replyMessage(event.replyToken, { type: "text", text: msg });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE bot running on :${port}`);
});
