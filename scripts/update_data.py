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

import argparse
import datetime
import hashlib
import json
import re
from pathlib import Path
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd

def _script_hash() -> str:
    """Hash of this script — changes whenever the processing logic changes.

    Used as a cache key: if the script is modified, cached outputs are
    automatically invalidated and regenerated from the source XLSX.
    This follows the same principle as Docker layer caching or Nix
    derivation hashes — all inputs (source data + processing logic)
    must match for the cache to be valid.
    """
    content = Path(__file__).resolve().read_bytes()
    return hashlib.sha256(content).hexdigest()[:16]


def _norm_col(x):
    import re as _re
    return _re.sub(r"\s+", "", str(x).replace("\u3000", " ")).strip()

def col_like(df, key, default="", avoid=()):
    """Return a column as a Series, tolerant to header variations.
    - exact match after whitespace normalization
    - prefix match
    - contains match
    If not found, returns a same-length Series filled with default.
    """
    key_n = _norm_col(key)
    avoid_n = [_norm_col(a) for a in avoid]

    def ok(cn):
        return not any(a and a in cn for a in avoid_n)

    best = None
    for c in df.columns:
        cn = _norm_col(c)
        if cn == key_n:
            best = c
            break
    if best is None:
        for c in df.columns:
            cn = _norm_col(c)
            if cn.startswith(key_n) and ok(cn):
                best = c
                break
    if best is None:
        for c in df.columns:
            cn = _norm_col(c)
            if key_n in cn and ok(cn):
                best = c
                break

    if best is None:
        import pandas as pd
        return pd.Series([default] * len(df), index=df.index)
    return df[best]


def read_mhlw_xlsx_table(xlsx_path: Path) -> pd.DataFrame:
    """Read the first sheet of the official XLSX into a DataFrame with the
    correct header row.

    The MHLW XLSX sometimes starts with blank rows and/or a multi-row header.
    When pandas reads such a sheet with the default header=0, the real headers
    end up as the first *data* row and the columns become Unnamed.*

    We detect the header row by searching for known header tokens (e.g.
    '都道府県', '薬局等名称', '住所') in the first few rows.
    """

    raw0 = pd.read_excel(xlsx_path, sheet_name=0, header=None)

    def norm_cell(x) -> str:
        if pd.isna(x):
            return ""
        return _norm_col(x)

    header_row = None
    for i in range(min(30, len(raw0))):
        row = [norm_cell(x) for x in raw0.iloc[i].tolist()]
        if ("都道府県" in row) and ("住所" in row) and any(("薬局" in c and "名称" in c) for c in row):
            header_row = i
            break

    if header_row is None:
        # fallback: first non-empty row
        for i in range(min(30, len(raw0))):
            if raw0.iloc[i].notna().any():
                header_row = i
                break
        if header_row is None:
            header_row = 0

    df = raw0.iloc[header_row + 1 :].copy()
    df.columns = raw0.iloc[header_row].tolist()

    # Drop columns whose header cell is empty/NaN
    df = df.loc[:, [c for c in df.columns if not pd.isna(c) and str(c).strip() != ""]]

    # Drop fully empty rows
    df = df.dropna(how="all")

    # Normalize column names (trim whitespace / full-width spaces)
    df = df.rename(columns=lambda c: str(c).replace("\u3000", " ").strip())
    return df


SOURCE_PAGE = "https://www.mhlw.go.jp/stf/kinnkyuuhininnyaku_00005.html"


def guess_as_of_from_xlsx(xlsx_path: Path) -> str:
    """Best-effort guess for --as-of when using a local XLSX.

    MHLW files often use a sheet name like "★260131公表用（一般向け）".
    We interpret 260131 as YYYYMMDD -> 2026-01-31.
    """
    try:
        import openpyxl

        wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
        for name in wb.sheetnames:
            m = re.search(r"(\d{6})", str(name))
            if not m:
                continue
            yymmdd = m.group(1)
            yy = int(yymmdd[0:2])
            mm = int(yymmdd[2:4])
            dd = int(yymmdd[4:6])
            year = 2000 + yy
            if 1 <= mm <= 12 and 1 <= dd <= 31:
                return f"{year:04d}-{mm:02d}-{dd:02d}"
    except Exception:
        pass
    return datetime.date.today().isoformat()

# Full-width digits to ASCII + normalize hyphens
_digit_map = {ord(fw): ord(hw) for fw, hw in zip("０１２３４５６７８９", "0123456789")}
for h in "－ー―−‐ｰ–—":
    _digit_map[ord(h)] = ord("-")


def fetch_text(url: str) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req) as r:
        return r.read().decode("utf-8", errors="ignore")


def extract_xlsx_url(html: str) -> str:
    # MHLW page often uses a relative URL like /content/...xlsx.
    # Accept absolute or relative; normalize to absolute URL.
    m = re.search(
        r'''(?:https?://(?:www\.)?mhlw\.go\.jp)?/content/[^"'\s]+\.xlsx(?:\?[^"'\s]*)?''',
        html,
        flags=re.IGNORECASE,
    )
    if not m:
        raise RuntimeError("XLSX URL not found in HTML.")
    url = m.group(0)
    if url.startswith("/"):
        url = "https://www.mhlw.go.jp" + url
    return url

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


def clean_int(val, default: int = 0) -> int:
    """Parse an integer-ish cell (counts) safely.

    The official sheet often leaves "0" cells blank. We treat blanks/NaN as 0.
    """
    if pd.isna(val):
        return default
    s = str(val).strip()
    if not s or s.lower() == "nan":
        return default
    try:
        # Handle values like "1", "1.0".
        return int(float(s))
    except Exception:
        return default


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


def looks_like_valid_app_json(path: Path, as_of: str) -> bool:
    """Heuristic validation so we can safely skip regeneration.

    We only skip when:
    - JSON parses
    - meta.asOf matches
    - meta.scriptHash matches current script (input-hashed cache invalidation)
    - data is a list
    - at least one record has the keys the web UI expects
    """
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return False

    if not isinstance(obj, dict):
        return False
    meta = obj.get("meta")
    data = obj.get("data")
    if not isinstance(meta, dict) or not isinstance(data, list):
        return False
    if meta.get("asOf") != as_of:
        return False
    # If the script has changed since this cache was generated, regenerate.
    if meta.get("scriptHash") != _script_hash():
        return False

    # Find the first dict-like record
    rec0 = None
    for r in data:
        if isinstance(r, dict):
            rec0 = r
            break
    if rec0 is None:
        return False

    required = {"id", "pref", "muni", "name", "addr", "tel", "url", "hours", "afterHours", "afterHoursTel", "privacy", "callAhead", "notes", "pharmacistsFemale", "pharmacistsMale", "pharmacistsNoAnswer"}
    if not required.issubset(set(rec0.keys())):
        return False

    # Also require that the dataset isn't "structurally valid but empty".
    return any(
        isinstance(r, dict) and r.get("pref") and r.get("name") and r.get("addr")
        for r in data
    )


def write_json_strict(path: Path, obj) -> None:
    """Write strict JSON (no NaN/Infinity) to avoid breaking browsers."""
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    path.write_text(s, encoding="utf-8")


def update_readme_as_of(repo_root: Path, as_of: str) -> bool:
    """Update README.md markers so the repo stays self-describing.

    We keep these in sync:
    - "- 最新取り込みデータ時点: YYYY-MM-DD"
    - Example artifact filenames under "2) 整形済みデータ"
    """
    readme = repo_root / "README.md"
    if not readme.exists():
        return False

    text = readme.read_text(encoding="utf-8")
    orig = text

    # Latest as-of marker
    text = re.sub(
        r"(?m)^(-\s*最新取り込みデータ時点:\s*)(\d{4}-\d{2}-\d{2})\s*$",
        r"\g<1>" + as_of,
        text,
    )

    # Update example filenames (keep other dates untouched)
    text = re.sub(
        r"(mhlw_ec_pharmacies_cleaned_)\d{4}-\d{2}-\d{2}(\.xlsx)",
        r"\g<1>" + as_of + r"\g<2>",
        text,
    )
    text = re.sub(
        r"(mhlw_ec_pharmacies_cleaned_)\d{4}-\d{2}-\d{2}(\.csv)",
        r"\g<1>" + as_of + r"\g<2>",
        text,
    )
    text = re.sub(
        r"(data_)\d{4}-\d{2}-\d{2}(\.json)",
        r"\g<1>" + as_of + r"\g<2>",
        text,
    )

    if text != orig:
        readme.write_text(text, encoding="utf-8")
        return True
    return False


def main(argv: list[str] | None = None) -> int:
    repo_root = Path(__file__).resolve().parents[1]
    data_dir = repo_root / "data"
    docs_dir = repo_root / "docs"
    line_dir = repo_root / "line_bot"
    data_dir.mkdir(parents=True, exist_ok=True)

    parser = argparse.ArgumentParser(
        description="Fetch the latest MHLW XLSX (or use a local XLSX), normalize it, and regenerate CSV/XLSX/JSON artifacts."
    )
    parser.add_argument("--xlsx", type=Path, default=None, help="Use a local XLSX file instead of downloading from the MHLW page")
    parser.add_argument("--as-of", dest="as_of", default=None, help="Override as-of date (YYYY-MM-DD)")
    parser.add_argument("--source-page", dest="source_page", default=SOURCE_PAGE, help="Override the source page URL used in metadata")
    parser.add_argument("--source-xlsx", dest="source_xlsx", default=None, help="Override the source XLSX URL used in metadata")
    args = parser.parse_args(argv)

    source_page = args.source_page

    if args.xlsx:
        as_of = args.as_of or guess_as_of_from_xlsx(args.xlsx)
        xlsx_url = args.source_xlsx or ""
        # Keep a dated copy under data/ (matches the download naming convention).
        raw_xlsx_path = data_dir / f"source_raw_{as_of}.xlsx"
        raw_xlsx_path.write_bytes(Path(args.xlsx).read_bytes())
    else:
        html = fetch_text(source_page)
        xlsx_url = extract_xlsx_url(html)
        as_of = args.as_of or extract_as_of_date(html)

        # Download XLSX
        raw_xlsx_path = data_dir / f"source_raw_{as_of}.xlsx"
        with urlopen(Request(xlsx_url, headers={"User-Agent": "Mozilla/5.0"})) as r:
            raw_xlsx_path.write_bytes(r.read())

    # If already have this as-of version *and it's valid*, skip to avoid noisy commits.
    # (If a previous run produced a broken JSON, we must regenerate even for the same as-of date.)
    existing_json = data_dir / f"data_{as_of}.json"
    if existing_json.exists() and looks_like_valid_app_json(existing_json, as_of):
        # Keep UI/bot copies in sync (in case they were manually edited).
        docs_dir.mkdir(parents=True, exist_ok=True)
        line_dir.mkdir(parents=True, exist_ok=True)
        (docs_dir / "data.json").write_text(existing_json.read_text(encoding="utf-8"), encoding="utf-8")
        (line_dir / "data.json").write_text(existing_json.read_text(encoding="utf-8"), encoding="utf-8")

        if update_readme_as_of(repo_root, as_of):
            print("Updated README.md (as-of):", as_of)
        print(f"No update needed: data_{as_of}.json already exists and looks valid.")
        return 0

    # Load & normalize (robust header handling)
    df = read_mhlw_xlsx_table(raw_xlsx_path)

    # Create canonical columns used below (official header labels vary across versions)
    df["薬局等番号"] = col_like(df, "薬局等番号", default="")
    df["都道府県"] = col_like(df, "都道府県", default="")
    df["薬局等名称"] = col_like(df, "薬局等名称", default="")
    df["住所"] = col_like(df, "住所", default="")
    df["電話番号"] = col_like(df, "電話番号", default="", avoid=("時間外",))
    df["時間外の電話番号"] = col_like(df, "時間外の電話番号", default="")
    df["HP"] = col_like(df, "HP", default="")
    # These columns have known variations:
    # - 開局等時間 / 開局時間
    # - 時間外対応 / 時間外対応の有無
    # - 事前電話連絡 / 事前連絡
    df["開局等時間"] = col_like(df, "開局", default="")
    df["時間外対応"] = col_like(df, "時間外対応", default="")
    df["事前電話連絡"] = col_like(df, "事前", default="")
    df["プライバシー確保策"] = col_like(df, "プライバシー", default="")
    df["備考"] = col_like(df, "備考", default="")

    # Fix the split header in the original file
    # The gender/count section has changed formats over time:
    # - Older: "販売可能薬剤師数・性別" + Unnamed columns
    # - Newer: merged header "販売可能薬剤師・性別" with subheaders: 女性 / 男性 / 答えたくない
    df = df.rename(columns={
        "販売可能薬剤師数・性別": "販売可能薬剤師数_女性",
        "販売可能薬剤師・性別": "販売可能薬剤師数_女性",
        "Unnamed: 7": "販売可能薬剤師数_男性",
        "Unnamed: 8": "販売可能薬剤師数_答えたくない",
    })
    if "販売可能薬剤師数_女性" not in df.columns and "女性" in df.columns:
        df = df.rename(columns={"女性": "販売可能薬剤師数_女性"})
    if "販売可能薬剤師数_男性" not in df.columns and "男性" in df.columns:
        df = df.rename(columns={"男性": "販売可能薬剤師数_男性"})
    if "販売可能薬剤師数_答えたくない" not in df.columns and "答えたくない" in df.columns:
        df = df.rename(columns={"答えたくない": "販売可能薬剤師数_答えたくない"})
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

    # Gender count columns are numeric-ish; treat blanks as 0.
    for col in ["販売可能薬剤師数_女性", "販売可能薬剤師数_男性", "販売可能薬剤師数_答えたくない"]:
        if col in df.columns:
            df[col] = df[col].apply(clean_int)

    # Sanity check: if we couldn't parse the real header, these will be empty.
    if (df["都道府県"].astype(str).str.strip() == "").all() or (df["薬局等名称"].astype(str).str.strip() == "").all():
        raise RuntimeError(
            "Parsed XLSX but key columns are empty (都道府県/薬局等名称). "
            "The header layout likely changed again; update the parser."
        )

    # Normalize types
    if "薬局等番号" in df.columns:
        id_num = pd.to_numeric(df["薬局等番号"], errors="coerce")
        mask = id_num.notna()
        df = df[mask].copy()
        df["薬局等番号"] = id_num[mask].astype("Int64")

    for col in ["電話番号", "時間外の電話番号"]:
        if col in df.columns:
            df[col] = df[col].astype(str)

    tel = col_like(df, "電話番号", default="", avoid=("時間外",)).fillna("")
    df["電話番号_数字"] = tel.astype(str).apply(clean_phone)
    df["時間外の電話番号_数字"] = col_like(df, "時間外の電話番号").apply(clean_phone)

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
    df["データ出典_URL"] = source_page
    df["データファイル_URL"] = xlsx_url

    # Write cleaned XLSX/CSV
    cleaned_xlsx = data_dir / f"mhlw_ec_pharmacies_cleaned_{as_of}.xlsx"
    with pd.ExcelWriter(cleaned_xlsx, engine="openpyxl") as w:
        df.to_excel(w, index=False, sheet_name="clean")
        meta = pd.DataFrame([{
            "asOf": as_of,
            "sourcePage": source_page,
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
        "販売可能薬剤師数_女性": "pharmacistsFemale",
        "販売可能薬剤師数_男性": "pharmacistsMale",
        "販売可能薬剤師数_答えたくない": "pharmacistsNoAnswer",
    }
    cols = [c for c in app_fields.keys() if c in df.columns]
    app_df = df[cols].rename(columns={k: v for k, v in app_fields.items() if k in cols}).copy()
    num_keys = {"pharmacistsFemale", "pharmacistsMale", "pharmacistsNoAnswer"}
    for c in app_df.columns:
        if c == "id":
            continue

        if c in num_keys:
            # Keep these as numbers in JSON (safer + easier for UI filtering)
            app_df[c] = pd.to_numeric(app_df[c], errors="coerce").fillna(0).astype(int)
        else:
            # Prevent NaN/pd.NA from leaking into JSON (browsers reject NaN).
            app_df[c] = app_df[c].replace({np.nan: "", pd.NA: ""}).fillna("").apply(clean_text)

    records = []
    skipped = 0
    for rec in app_df.to_dict(orient="records"):
        rid = rec.get("id")
        rec["id"] = int(rid) if rid is not None and rid is not pd.NA else None
        # Skip records with no address — these are consolidated/defunct entries
        # with no usable information (no tel, no hours, no addr).
        if not rec.get("addr"):
            skipped += 1
            continue
        records.append(rec)

    total_published = len(records) + skipped
    payload = {
        "meta": {
            "asOf": as_of,
            "sourcePage": source_page,
            "sourceXlsx": xlsx_url,
            "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
            "records": len(records),
            "totalPublished": total_published,
            "scriptHash": _script_hash(),
        },
        "data": records,
    }
    out_json = data_dir / f"data_{as_of}.json"
    write_json_strict(out_json, payload)

    # Copy to places used by the UI / bot
    docs_dir.mkdir(parents=True, exist_ok=True)
    line_dir.mkdir(parents=True, exist_ok=True)

    (docs_dir / "data.json").write_text(out_json.read_text(encoding="utf-8"), encoding="utf-8")
    (line_dir / "data.json").write_text(out_json.read_text(encoding="utf-8"), encoding="utf-8")

    if update_readme_as_of(repo_root, as_of):
        print("Updated README.md (as-of):", as_of)

    print("Updated to:", as_of)
    print("XLSX:", xlsx_url)
    print("Records:", len(records))
    if skipped:
        print(f"Skipped {skipped} records with no address (consolidated/defunct)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
