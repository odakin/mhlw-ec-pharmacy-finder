"""
scripts/update_clinics.py

Download and parse MHLW clinic PDFs (47 prefectures) for emergency
contraception face-to-face consultations, and generate clinics.json.

Source page:
https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000186912_00002.html

Usage:
  python3 scripts/update_clinics.py              # download all + generate
  python3 scripts/update_clinics.py --pref 東京都  # single prefecture (debug)
  python3 scripts/update_clinics.py --local-dir data/clinics  # use cached PDFs
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import time
from pathlib import Path
from urllib.request import Request, urlopen

import pdfplumber

# ── Constants ────────────────────────────────────────────────────────

SOURCE_PAGE = "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000186912_00002.html"
MHLW_BASE = "https://www.mhlw.go.jp"

# Full-width → ASCII digits + hyphen normalization
_FW_MAP = {ord(fw): ord(hw) for fw, hw in zip("０１２３４５６７８９", "0123456789")}
for h in "－ー―−‐ｰ–—":
    _FW_MAP[ord(h)] = ord("-")
# Full-width colon
_FW_MAP[ord("：")] = ord(":")

PREFECTURES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県",
    "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県",
    "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]


# ── Helpers ──────────────────────────────────────────────────────────

def fetch_text(url: str) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="ignore")


def fetch_bytes(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=60) as r:
        return r.read()


def extract_pdf_urls(html: str) -> dict[str, str]:
    """Extract prefecture → PDF URL mapping from the MHLW source page.

    The HTML structure is: <a href="/content/...pdf">県名[サイズ]</a>
    So the prefecture name appears in the link TEXT, not before the link.
    """
    urls: dict[str, str] = {}

    # Match: href="(pdf_path)"...>県名
    pref_pattern = "|".join(re.escape(p) for p in PREFECTURES)
    for m in re.finditer(
        rf'href="(/content/[^"]+\.pdf)"[^>]*>({pref_pattern})',
        html,
    ):
        pdf_path = m.group(1)
        pref = m.group(2)
        urls[pref] = MHLW_BASE + pdf_path

    return urls


def clean_text(val: str | None) -> str:
    if val is None:
        return ""
    s = str(val).strip()
    # Normalize full-width spaces
    s = s.replace("\u3000", " ").strip()
    # Remove embedded newlines (from PDF cell wrapping)
    s = s.replace("\n", "").replace("\r", "")
    return s


def clean_phone(val: str | None) -> str:
    if val is None:
        return ""
    s = str(val).strip().translate(_FW_MAP)
    return re.sub(r"[^0-9]", "", s)


def normalize_url(u: str | None) -> str:
    if not u:
        return ""
    s = str(u).strip()
    if not s or s.lower() == "nan":
        return ""
    if re.match(r"^https?://", s, flags=re.I):
        return s
    if s.startswith("//"):
        return "https:" + s
    return "https://" + s


def normalize_hours(h: str) -> str:
    """Normalize hours text from PDF (full-width digits/colons → ASCII)."""
    if not h:
        return ""
    return h.translate(_FW_MAP).strip()


def guess_pref_from_address(addr: str) -> str:
    """Extract prefecture from address string."""
    for pref in PREFECTURES:
        if addr.startswith(pref):
            return pref
    return ""


def extract_municipality(pref: str, addr: str) -> str:
    """Extract municipality (市区町村) from address."""
    s = addr
    if pref and s.startswith(pref):
        s = s[len(pref):]

    # 政令指定都市: X市Y区
    if "市" in s:
        i = s.find("市") + 1
        city = s[:i]
        rest = s[i:]
        if "区" in rest:
            j = rest.find("区") + 1
            return city + rest[:j]
        return city
    if "区" in s:
        return s[:s.find("区") + 1]
    if "郡" in s:
        g = s.find("郡") + 1
        after = s[g:]
        m = re.search(r".*?[町村]", after)
        if m:
            return s[:g] + m.group(0)
        return s[:g]
    m = re.search(r".*?[町村]", s)
    if m:
        return m.group(0)
    return ""


# ── PDF Parsing ──────────────────────────────────────────────────────

# Expected column headers (after whitespace normalization)
EXPECTED_HEADERS = {"施設名", "郵便番号", "住所", "電話番号"}


def is_header_row(row: list[str | None]) -> bool:
    """Check if a row is a table header."""
    cleaned = {clean_text(c) for c in row if c}
    return bool(EXPECTED_HEADERS & cleaned)


def is_meta_row(row: list[str | None]) -> bool:
    """Check if a row is a top-level meta header like '基本情報'."""
    cleaned = [clean_text(c) for c in row if c]
    if len(cleaned) <= 2:
        joined = "".join(cleaned)
        if "基本情報" in joined or "一覧" in joined:
            return True
    return False


def detect_column_offset(table: list[list]) -> int:
    """Detect if the table has extra leading columns (e.g. 沖縄's '公表の希望の有無').

    Returns the offset to add to standard column indices.
    """
    for row in table[:3]:
        cleaned = [clean_text(c) for c in row]
        for i, c in enumerate(cleaned):
            if c == "施設名":
                return i  # Standard layout has 施設名 at index 0
    return 0


def is_section_header(row: list[str | None]) -> bool:
    """Check if a row is a section header like ≪下田市≫ (Shizuoka-style)."""
    non_empty = [c for c in row if c and clean_text(c)]
    if len(non_empty) == 1:
        val = clean_text(non_empty[0])
        # Section headers: ≪...≫, 【...】, or just a city/area name with no postal code
        if re.match(r"^[≪《【〈].*[≫》】〉]$", val):
            return True
    return False


def parse_pdf(pdf_path: Path, pref: str) -> list[dict]:
    """Parse a single prefecture PDF and return clinic records."""
    records = []

    with pdfplumber.open(pdf_path) as pdf:
        col_offset = 0

        for page_idx, page in enumerate(pdf.pages):
            table = page.extract_table()
            if not table:
                continue

            # Detect column offset on first page
            if page_idx == 0:
                col_offset = detect_column_offset(table)

            for row in table:
                if len(row) < 7 + col_offset:
                    continue
                if is_header_row(row) or is_meta_row(row) or is_section_header(row):
                    continue

                name = clean_text(row[0 + col_offset])
                if not name:
                    continue

                postal = clean_text(row[1 + col_offset])
                addr = clean_text(row[2 + col_offset])
                tel = clean_text(row[3 + col_offset])
                url = clean_text(row[4 + col_offset])
                obgyn = clean_text(row[5 + col_offset]) if len(row) > 5 + col_offset else ""
                hours = clean_text(row[6 + col_offset]) if len(row) > 6 + col_offset else ""
                stock = clean_text(row[7 + col_offset]) if len(row) > 7 + col_offset else ""

                # Skip rows that look like they contain no real clinic data
                # (e.g. postal code should look like NNN-NNNN)
                if postal and not re.match(r"\d{3}-?\d{4}", postal.translate(_FW_MAP)):
                    continue

                # Derive pref from address if not provided
                actual_pref = pref or guess_pref_from_address(addr)

                # Build full address with postal code normalization
                full_addr = addr.translate(_FW_MAP) if addr else ""
                muni = extract_municipality(actual_pref, full_addr)

                records.append({
                    "pref": actual_pref,
                    "muni": muni,
                    "name": name,
                    "postal": postal.translate(_FW_MAP) if postal else "",
                    "addr": full_addr,
                    "tel": clean_phone(tel),
                    "url": normalize_url(url),
                    "obgyn": obgyn,
                    "hours": normalize_hours(hours),
                    "stock": stock,
                })

    return records


# ── Main ─────────────────────────────────────────────────────────────

def write_json(path: Path, obj) -> None:
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    path.write_text(s, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    repo_root = Path(__file__).resolve().parents[1]
    data_dir = repo_root / "data" / "clinics"
    docs_dir = repo_root / "docs"
    data_dir.mkdir(parents=True, exist_ok=True)

    parser = argparse.ArgumentParser(
        description="Download MHLW clinic PDFs and generate clinics.json"
    )
    parser.add_argument("--pref", default=None, help="Process single prefecture (e.g. 東京都)")
    parser.add_argument("--local-dir", type=Path, default=None, help="Use cached PDFs from this directory")
    parser.add_argument("--as-of", default=None, help="Override as-of date (YYYY-MM-DD)")
    args = parser.parse_args(argv)

    as_of = args.as_of or datetime.date.today().isoformat()

    # Determine which prefectures to process
    target_prefs = [args.pref] if args.pref else PREFECTURES

    # Get PDF URLs (unless using local files)
    pdf_urls: dict[str, str] = {}
    if not args.local_dir:
        print("Fetching source page...")
        html = fetch_text(SOURCE_PAGE)
        pdf_urls = extract_pdf_urls(html)

        # Extract as-of date from page if not overridden
        if not args.as_of:
            m = re.search(r"令和\s*([0-9０-９]+)年\s*([0-9０-９]+)月\s*([0-9０-９]+)日", html)
            if m:
                ry = int(m.group(1).translate(_FW_MAP))
                mm = int(m.group(2).translate(_FW_MAP))
                dd = int(m.group(3).translate(_FW_MAP))
                as_of = f"{ry + 2018:04d}-{mm:02d}-{dd:02d}"

    all_records: list[dict] = []
    errors: list[str] = []

    for pref in target_prefs:
        pdf_path = None

        if args.local_dir:
            # Try to find a cached PDF by prefecture name
            candidates = list(args.local_dir.glob(f"*{pref}*")) + list(args.local_dir.glob("*.pdf"))
            for c in candidates:
                if c.suffix.lower() == ".pdf":
                    pdf_path = c
                    break
            if pdf_path is None and args.pref:
                # For single-pref debug, also try tokyo.pdf etc.
                for p in args.local_dir.glob("*.pdf"):
                    pdf_path = p
                    break
        else:
            if pref not in pdf_urls:
                errors.append(f"{pref}: PDF URL not found")
                continue

            # Download PDF
            pdf_path = data_dir / f"{pref}.pdf"
            try:
                print(f"  Downloading {pref}...")
                data = fetch_bytes(pdf_urls[pref])
                pdf_path.write_bytes(data)
                time.sleep(0.5)  # Be kind to MHLW server
            except Exception as e:
                errors.append(f"{pref}: download failed: {e}")
                continue

        if pdf_path is None or not pdf_path.exists():
            errors.append(f"{pref}: PDF not found")
            continue

        try:
            recs = parse_pdf(pdf_path, pref)
            print(f"  {pref}: {len(recs)} clinics")
            all_records.extend(recs)
        except Exception as e:
            errors.append(f"{pref}: parse failed: {e}")

    # Assign IDs with "c" prefix
    for i, rec in enumerate(all_records, start=1):
        rec["id"] = f"c{i}"

    # Build clinics.json
    payload = {
        "meta": {
            "asOf": as_of,
            "sourcePage": SOURCE_PAGE,
            "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
            "records": len(all_records),
        },
        "data": all_records,
    }

    out_path = docs_dir / "clinics.json"
    write_json(out_path, payload)

    # Also save a dated copy
    dated_path = repo_root / "data" / f"clinics_{as_of}.json"
    write_json(dated_path, payload)

    print(f"\nTotal: {len(all_records)} clinics from {len(target_prefs)} prefectures")
    print(f"Output: {out_path}")

    if errors:
        print(f"\nErrors ({len(errors)}):")
        for e in errors:
            print(f"  - {e}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
