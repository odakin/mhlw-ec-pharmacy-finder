"""
scripts/update_data.py

Fetch the latest MHLW emergency contraception pharmacy list (XLSX),
normalize it, and regenerate:
- data/mhlw_ec_pharmacies_cleaned_<YYYY-MM-DD>.xlsx
- data/mhlw_ec_pharmacies_cleaned_<YYYY-MM-DD>.csv (UTF-8 BOM)
- data/data_<YYYY-MM-DD>.json
- docs/data.json (copy of latest JSON)
- line_bot/data.json (copy of latest JSON)

Notes:
- This script relies on the HTML structure of the MHLW page to locate the XLSX.
  If the page changes, you may need to update the regex.
- Be kind to the source server; don't run in tight loops.

Source page:
https://www.mhlw.go.jp/stf/kinnkyuuhininnyaku_00005.html
"""

from __future__ import annotations

import datetime
import json
import re
from pathlib import Path
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd

SOURCE_PAGE = "https://www.mhlw.go.jp/stf/kinnkyuuhininnyaku_00005.html"

# Full-width digits to ASCII + normalize hyphens
_digit_map = {ord(fw): ord(hw) for fw, hw in zip("０１２３４５６７８９", "0123456789")}
for h in "－ー―−‐ｰ–—":
    _digit_map[ord(h)] = ord("-")


def fetch_text(url: str) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req) as r:
        return r.read().decode("utf-8", errors="ignore")


def extract_xlsx_url(html: str) -> str:
    # Example:
    # https://www.mhlw.go.jp/content/11120000/001643057.xlsx
    m = re.search(r"https://www\.mhlw\.go\.jp/content/[^\\"\s]+\.xlsx", html)
    if not m:
        raise RuntimeError("XLSX URL not found in HTML.")
    return m.group(0)


def extract_as_of_date(html: str) -> str:
    # e.g. 令和８年１月27日（火）時点
    m = re.search(r"令和\s*([0-9０-９]+)年\s*([0-9０-９]+)月\s*([0-9０-９]+)日", html)
    if not m:
        # fallback: today
        return datetime.date.today().isoformat()
    ry = int(m.group(1).translate(_digit_map))
    mm = int(m.group(2).translate(_digit_map))
    dd = int(m.group(3).translate(_digit_map))
    year = ry + 2018  # Reiwa 1 = 2019
    return f"{year:04d}-{mm:02d}-{dd:02d}"


def clean_text(val) -> str:
    """
    Trim leading/trailing whitespace (including full-width spaces),
    and convert NaN-ish values to "".

    This prevents bugs like " 東京都" (leading whitespace) being treated as a different prefecture.
    """
    if pd.isna(val):
        return ""
    s = str(val)
    if s.lower() == "nan":
        return ""
    return s.replace("\u3000", " ").strip()


def clean_phone(val) -> str:
    if pd.isna(val):
        return ""
    s = str(val).strip()
    if s.lower() == "nan":
        return ""
    s = s.translate(_digit_map)
    return re.sub(r"[^0-9]", "", s)


def normalize_url(u) -> str:
    if pd.isna(u):
        return ""
    s = str(u).strip()
    if not s or s.lower() == "nan":
        return ""
    if re.match(r"^(https?://)", s, flags=re.I):
        return s
    if s.startswith("//"):
        return "https:" + s
    return "https://" + s


def split_address(pref: str, full_addr: str):
    """
    Crude municipality extraction for easier filtering.
    Returns:
      (addr_norm, addr_wo_pref, muni_guess, rest)
    """
    if pd.isna(full_addr):
        return ("", "", "", "")
    s = str(full_addr).strip().translate(_digit_map)
    pref = (pref or "").strip()
    s2 = s[len(pref):].lstrip() if pref and s.startswith(pref) else s
    municipality = ""
    remaining = s2

    if "市" in s2:
        i = s2.find("市") + 1
        city = s2[:i]
        rest = s2[i:]
        if "区" in rest:
            j = rest.find("区") + 1
            municipality = city + rest[:j]
            remaining = rest[j:]
        else:
            municipality = city
            remaining = rest
    elif "区" in s2:
        j = s2.find("区") + 1
        municipality = s2[:j]
        remaining = s2[j:]
    elif "郡" in s2:
        g = s2.find("郡") + 1
        after = s2[g:]
        m = re.search(r".*?[町村]", after)
        if m:
            municipality = s2[:g] + m.group(0)
            remaining = after[len(m.group(0)):]
        else:
            municipality = s2[:g]
            remaining = after
    else:
        m = re.search(r".*?[町村]", s2)
        if m:
            municipality = m.group(0)
            remaining = s2[len(m.group(0)):]
        else:
            municipality = ""
            remaining = s2

    without = s[len(pref):].lstrip() if pref and s.startswith(pref) else s
    return (s, without, municipality.strip(), remaining.strip())


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    data_dir = repo_root / "data"
    docs_dir = repo_root / "docs"
    line_dir = repo_root / "line_bot"
    data_dir.mkdir(parents=True, exist_ok=True)

    html = fetch_text(SOURCE_PAGE)
    xlsx_url = extract_xlsx_url(html)
    as_of = extract_as_of_date(html)

    # If already have this as-of version, skip to avoid noisy commits
    existing_json = data_dir / f"data_{as_of}.json"
    if existing_json.exists():
        print(f"No update needed: data_{as_of}.json already exists.")
        return 0

    # Download XLSX
    raw_xlsx_path = data_dir / f"source_raw_{as_of}.xlsx"
    with urlopen(Request(xlsx_url, headers={"User-Agent": "Mozilla/5.0"})) as r:
        raw_xlsx_path.write_bytes(r.read())

    # Load & normalize
    raw = pd.read_excel(raw_xlsx_path, sheet_name=0)
    df = raw.iloc[1:].copy()  # skip merged header row

    # Fix the split header in the original file
    df = df.rename(columns={
        "販売可能薬剤師数・性別": "販売可能薬剤師数_女性",
        "Unnamed: 7": "販売可能薬剤師数_男性",
        "Unnamed: 8": "販売可能薬剤師数_答えたくない",
    })
    if "Unnamed: 0" in df.columns:
        df = df.drop(columns=["Unnamed: 0"])

    # Trim whitespace early (prevents " 東京都" etc.)
    for col in [
        "都道府県",
        "薬局等名称",
        "住所",
        "開局等時間",
        "備考",
        "プライバシー確保策",
        "事前電話連絡",
        "時間外対応",
        "電話番号",
        "時間外の電話番号",
        "HP",
    ]:
        if col in df.columns:
            df[col] = df[col].apply(clean_text)

    # Normalize types
    if "薬局等番号" in df.columns:
        df["薬局等番号"] = pd.to_numeric(df["薬局等番号"], errors="coerce").astype("Int64")

    for col in ["電話番号", "時間外の電話番号"]:
        if col in df.columns:
            df[col] = df[col].astype(str)

    df["電話番号_数字"] = df.get("電話番号", "").apply(clean_phone)
    df["時間外の電話番号_数字"] = df.get("時間外の電話番号", "").apply(clean_phone)

    if "HP" in df.columns:
        df["HP"] = df["HP"].apply(normalize_url)

    addr_cols = df.apply(
        lambda r: split_address(r.get("都道府県", ""), r.get("住所", "")),
        axis=1,
        result_type="expand",
    )
    addr_cols.columns = ["住所_正規化", "住所_都道府県除く", "市区町村_推定", "住所_残り"]
    df = pd.concat([df, addr_cols], axis=1)

    if "時間外対応" in df.columns:
        df["時間外対応_有無"] = df["時間外対応"].apply(lambda x: True if str(x).strip() == "有" else False)
    if "事前電話連絡" in df.columns:
        df["事前電話連絡_要否"] = df["事前電話連絡"].apply(lambda x: True if str(x).strip() == "要" else False)

    df["データ時点"] = as_of
    df["データ出典_URL"] = SOURCE_PAGE
    df["データファイル_URL"] = xlsx_url

    # Write cleaned XLSX/CSV
    cleaned_xlsx = data_dir / f"mhlw_ec_pharmacies_cleaned_{as_of}.xlsx"
    with pd.ExcelWriter(cleaned_xlsx, engine="openpyxl") as w:
        df.to_excel(w, index=False, sheet_name="clean")
        meta = pd.DataFrame([{
            "asOf": as_of,
            "sourcePage": SOURCE_PAGE,
            "sourceXlsx": xlsx_url,
            "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
            "records": int(len(df)),
        }])
        meta.to_excel(w, index=False, sheet_name="meta")

    df.to_csv(data_dir / f"mhlw_ec_pharmacies_cleaned_{as_of}.csv", index=False, encoding="utf-8-sig")

    # Web/LINE JSON
    app_fields = {
        "薬局等番号": "id",
        "都道府県": "pref",
        "市区町村_推定": "muni",
        "薬局等名称": "name",
        "住所_正規化": "addr",
        "電話番号_数字": "tel",
        "HP": "url",
        "開局等時間": "hours",
        "時間外対応": "afterHours",
        "時間外の電話番号_数字": "afterHoursTel",
        "プライバシー確保策": "privacy",
        "事前電話連絡": "callAhead",
        "備考": "notes",
    }
    cols = [c for c in app_fields.keys() if c in df.columns]
    app_df = df[cols].rename(columns={k: v for k, v in app_fields.items() if k in cols}).copy()
    for c in app_df.columns:
        if c != "id":
            app_df[c] = app_df[c].replace({np.nan: ""}).apply(clean_text)

    records = []
    for rec in app_df.to_dict(orient="records"):
        rid = rec.get("id")
        rec["id"] = int(rid) if rid is not None and rid is not pd.NA else None
        records.append(rec)

    payload = {
        "meta": {
            "asOf": as_of,
            "sourcePage": SOURCE_PAGE,
            "sourceXlsx": xlsx_url,
            "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
            "records": len(records),
        },
        "data": records,
    }
    out_json = data_dir / f"data_{as_of}.json"
    out_json.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # Copy to places used by the UI / bot
    docs_dir.mkdir(parents=True, exist_ok=True)
    line_dir.mkdir(parents=True, exist_ok=True)

    (docs_dir / "data.json").write_text(out_json.read_text(encoding="utf-8"), encoding="utf-8")
    (line_dir / "data.json").write_text(out_json.read_text(encoding="utf-8"), encoding="utf-8")

    print("Updated to:", as_of)
    print("XLSX:", xlsx_url)
    print("Records:", len(records))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
