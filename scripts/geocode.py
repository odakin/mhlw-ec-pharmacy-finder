"""
scripts/geocode.py

Geocode pharmacy addresses using the University of Tokyo CSIS
Simple Geocoding API (free, no API key required).

Usage:
    python3 scripts/geocode.py                  # process all missing
    python3 scripts/geocode.py --limit 100      # process up to 100
    python3 scripts/geocode.py --force           # re-geocode everything

Cache: data/geocode_cache.json (append-only, survives deletions)
Output: docs/geocode_cache.json (copy for frontend)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

CSIS_URL = "https://geocode.csis.u-tokyo.ac.jp/cgi-bin/simple_geocode.cgi"
DELAY = 0.5  # seconds between requests
TIMEOUT = 15  # seconds per request

ROOT = Path(__file__).resolve().parent.parent
DATA_JSON = ROOT / "docs" / "data.json"
CACHE_FILE = ROOT / "data" / "geocode_cache.json"
DOCS_CACHE = ROOT / "docs" / "geocode_cache.json"


def load_cache() -> dict:
    if CACHE_FILE.exists():
        with open(CACHE_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_cache(cache: dict) -> None:
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, separators=(",", ":"))
    # Also copy to docs/ for frontend
    with open(DOCS_CACHE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, separators=(",", ":"))


def _call_csis(addr: str) -> dict | None:
    """Single CSIS API call. Returns {"lat", "lng", "lvl"} or None."""
    params = urllib.parse.urlencode({"charset": "UTF8", "addr": addr})
    url = f"{CSIS_URL}?{params}"
    headers = {"User-Agent": "mhlw-ec-pharmacy-finder/1.0 (geocode script)"}
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT)
        root = ET.fromstring(resp.read())
        cand = root.find(".//candidate")
        if cand is None:
            return None
        lat = cand.findtext("latitude")
        lng = cand.findtext("longitude")
        lvl = cand.findtext("iLvl")
        if lat and lng:
            return {
                "lat": float(lat),
                "lng": float(lng),
                "lvl": int(lvl) if lvl else 0,
            }
    except Exception as e:
        print(f"  ERROR: {e}", file=sys.stderr)
    return None


def _clean_addr(addr: str) -> list[str]:
    """Generate progressively simplified addresses for fallback geocoding.

    Returns a list of cleaned addresses to try (most specific first).
    The original address is NOT included (caller tries it first).
    """
    candidates = []

    # 1. Remove building/floor info: everything after common suffixes
    #    e.g. "...17号M&Cビル1階" -> "...17号"
    cleaned = re.sub(
        r'[A-Za-z０-９&＆].{0,30}$'
        r'|[0-9０-９]*[FＦ階]$'
        r'|[ー\-][0-9０-９]*[FＦ階].*$',
        '', addr
    ).strip()
    if cleaned and cleaned != addr:
        candidates.append(cleaned)

    # 2. Remove trailing non-address parts (ビル, マンション, etc.)
    cleaned2 = re.sub(
        r'[^\d丁目番号]+(?:ビル|マンション|ハイツ|コーポ|アパート|タワー|プラザ|'
        r'センター|会館|薬局|店舗|テナント).*$',
        '', addr
    ).strip()
    if cleaned2 and cleaned2 != addr and cleaned2 not in candidates:
        candidates.append(cleaned2)

    return candidates


def geocode_one(addr: str) -> dict | None:
    """Call CSIS geocoder with automatic address cleaning fallback.

    Tries the original address first. On failure, tries progressively
    cleaned versions (building names removed, etc.).
    Returns {"lat", "lng", "lvl"} or None on failure.
    """
    result = _call_csis(addr)
    if result:
        return result

    # Try cleaned addresses as fallback
    for cleaned in _clean_addr(addr):
        time.sleep(DELAY)
        print(f"  retry: {cleaned[:40]}...", end=" ")
        result = _call_csis(cleaned)
        if result:
            print(f"OK (lvl={result['lvl']})")
            return result
        print("FAIL")

    return None


def main():
    parser = argparse.ArgumentParser(description="Geocode pharmacies via CSIS")
    parser.add_argument("--limit", type=int, default=0, help="Max items to geocode (0=all)")
    parser.add_argument("--force", action="store_true", help="Re-geocode everything")
    args = parser.parse_args()

    # Load data
    with open(DATA_JSON, encoding="utf-8") as f:
        data = json.load(f)["data"]
    print(f"Loaded {len(data)} pharmacies from data.json")

    cache = load_cache()
    print(f"Cache has {len(cache)} entries")

    # Build work list
    todo = []
    for r in data:
        rid = str(r.get("id", ""))
        addr = (r.get("addr") or "").strip()
        if not rid or not addr:
            continue
        if args.force:
            todo.append((rid, addr))
        elif rid not in cache:
            todo.append((rid, addr))
        elif cache[rid].get("addr") != addr:
            # Address changed -> re-geocode
            todo.append((rid, addr))

    print(f"Need to geocode: {len(todo)} items")
    if args.limit:
        todo = todo[: args.limit]
        print(f"Limited to: {len(todo)} items")

    if not todo:
        print("Nothing to do.")
        save_cache(cache)  # still copy to docs/
        return

    est_min = len(todo) * DELAY / 60
    print(f"Estimated time: {est_min:.0f} minutes")
    print()

    ok = 0
    fail = 0
    for i, (rid, addr) in enumerate(todo):
        pct = (i + 1) / len(todo) * 100
        print(f"[{i+1}/{len(todo)} {pct:.0f}%] id={rid} {addr[:40]}...", end=" ")
        result = geocode_one(addr)
        if result:
            result["addr"] = addr
            cache[rid] = result
            print(f"OK (lvl={result['lvl']})")
            ok += 1
        else:
            print("FAIL")
            fail += 1

        # Save periodically (every 100 items)
        if (i + 1) % 100 == 0:
            save_cache(cache)
            print(f"  [saved cache: {len(cache)} entries]")

        if i < len(todo) - 1:
            time.sleep(DELAY)

    save_cache(cache)
    print()
    print(f"Done: {ok} OK, {fail} failed, cache now has {len(cache)} entries")


if __name__ == "__main__":
    main()
