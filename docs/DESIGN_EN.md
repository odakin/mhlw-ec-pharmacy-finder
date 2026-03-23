# Design Philosophy

This document records the design decisions and their rationale behind the Emergency Contraception Pharmacy Finder. It is intended for developers who want to understand "why things are the way they are," and as a reference for those building similar projects.

For technical specifications, see the [Feature Spec](FEATURE_SPEC_EN.html) and the [Hours Parser Design](HOURS_PARSER_EN.html).

---

## 1. This Site Is a "Search Tool," Not a "Medical Information Site"

This is the most fundamental design decision. The site does not cover medical information such as the efficacy, side effects, or administration methods of emergency contraception.

**Reasons**:

- Ensuring the ongoing accuracy of medical information is the responsibility of specialized institutions, not something a personal project should take on
- Users of this site want to "find a pharmacy right now" — they are not in a phase of reading medical information
- By narrowing the scope, we can focus on search quality

For this reason, medical information and lengthy explanatory text are intentionally omitted from the header and filter areas. We should not add noise to the navigation path of users in a hurry. Questions like "What is the difference between pharmacies and medical institutions?" are addressed with a single FAQ entry, as they relate to usage decisions.

---

## 2. Filter Design Principles

This site has two types of filters, each with different criteria for implementation.

### Default Exclusion (Options Hidden from the User)

Emergency contraception is time-critical. The decision to hide options by default requires careful, **deep** consideration along each axis. Evaluated along **three axes**:

| Axis | Question |
|---|---|
| **Source of information** | Is it self-reported by the facility (primary source), or parsed/estimated by us (secondary processing)? |
| **Availability of alternatives** | Can the purpose of the excluded option be achieved through another route? |
| **Harm of not excluding** | Is it a risk of wasted trips (noise), or a loss of useful options? |

#### Example: Stock availability filter for medical institutions (医療機関) → Exclusion OK

The medical institution data includes a "stock availability" (常時在庫の有無) column from the MHLW PDF. Facilities marked "No" or "Unknown" are hidden by default.

- **Source**: The facility itself reported "not regularly stocked" to MHLW (primary source)
- **Alternatives**: Facilities without stock require an in-person consultation followed by an external prescription — the patient then goes to a pharmacy (薬局). Over 10,000 pharmacies are already listed, so there is no information loss
- **Harm of not excluding**: Risk of wasted trips to facilities that have reported they do not regularly stock the medication

> Primary source + alternatives available + practical benefit of noise removal. Exclusion is justified.

#### Example: "Currently Open" filter → Not implemented

This seems useful at first glance, but is intentionally not implemented.

- **Source**: Estimated by the hours parser (secondary processing). Coverage is 97.1%, meaning approximately 290 facilities cannot have their operating status determined
- **Alternatives**: The nearest pharmacy might be one of those unparseable entries — no alternative exists
- **Harm of not excluding**: None. The current design of displaying business hours on each card is sufficient

> Secondary processing creates a risk of inadvertently hiding useful options as collateral damage, and there is no harm in not excluding. The conditions differ from the stock filter on all three axes.

### User-Initiated Filters (User Turns Them ON)

Because everything is visible when the filter is OFF, the criteria are more relaxed than for default exclusion:

1. **Data must be from a primary source** — based on the facility's self-reporting
2. **The filter rate must be meaningful** — a filter with too high a pass rate does not function

#### Example: Private Room Available (個室あり) → Implemented

Filters to pharmacies whose `privacy` field contains "private room" (個室).

- **Data**: Self-reported by the facility (primary source)
- **Filter rate**: 1,443 out of 10,128 pharmacies (14%). A meaningfully selective filter

#### Example: Partition Available (衝立あり) → Not implemented

- 79% of all pharmacies qualify. A filter that 9 out of 10 entries pass does not function
- Too many filters in an emergency situation can cause decision paralysis

---

## 3. Empty Record Exclusion and Two-Layer Count Display

The MHLW dataset contains records where address, phone number, and hours are all empty (177 as of March 2026). Their notes field typically reads "Consolidated into #XXX" — these are defunct or merged facilities. They are worthless to users (no way to call or locate them), so they are excluded from `data.json`.

### Basis for Exclusion

Evaluated against the 3-axis framework from Section 2:

- **Source of information**: The MHLW data itself has addr / tel / hours all empty (primary source saying "no information")
- **Alternative availability**: The consolidated-into facility exists as a separate record. Zero information loss
- **Harm of not excluding**: Cards showing only a name and "Note: consolidated into #XXX" erode user trust

→ This is not even a filter — it is a **data quality issue**. There is no reason to display these.

### Count Display Design

Exclusion reduces `data.json` to 9,951 records, but MHLW officially publishes 10,128. These two numbers have different meanings:

| Number | Meaning | Displayed where |
|---|---|---|
| **10,128** | Facilities published by MHLW (data coverage) | Highlight card: "💊 10,128 nationwide" |
| **9,951** | Actually searchable facilities (what users can interact with) | Status bar: "Loaded 9,951 pharmacy records" |

The highlight card states "Complete official MHLW data." The number shown there should be the MHLW dataset size, not our filtered count. Hence it uses `meta.totalPublished`.

The status bar is an operational report from the search engine — it accurately shows the number of records loaded as search targets.

### Implementation

- **`update_data.py`**: Skips addr-empty records. `meta.totalPublished = len(records) + skipped` preserves the MHLW-published count. `meta.scriptHash` ensures automatic cache invalidation (see §8)
- **`app.js` (init)**: `!rr.addr` as a defensive filter (safety net against direct data.json edits)
- **`app.js` (highlight)**: `META.totalPublished || DATA.length` — falls back gracefully for older data without totalPublished

The title/meta text "全国10,000件以上" (over 10,000 nationwide) is an approximate expression referencing the MHLW dataset size and is unaffected by the exclusion.

---

## 4. Pharmacy-Default with Medical Institution Toggle

By default, only pharmacies (薬局) are displayed. Turning on the "Also show medical institutions with stock" toggle lazy-loads `clinics.json` and integrates the results.

### Rejected Alternatives

| Approach | Reason for Rejection |
|---|---|
| **Tab separation** (Pharmacy tab / Medical Institution tab) | Cannot cross-sort pharmacies and medical institutions by "nearest." Users may not notice if the nearest option is a medical institution |
| **Full integration** (always show both) | Filters become complex. Fields unique to pharmacies (female pharmacist, private room, etc.) and fields unique to medical institutions (OB/GYN department, stock status) would be mixed together |
| **Separate page** | An extra navigation step during an emergency. Everything should be on one page |

### Why Pharmacies Are the Default

- Pharmacies allow purchase without a prescription (OTC since February 2026). Medical institutions require an in-person consultation + prescription, adding one extra step
- Zero impact on existing SEO, bookmarks, and external links (existing user experience unchanged)
- Users who do not need `clinics.json` (972KB) are not forced to download it (performance)
- In areas with few pharmacies, a "You can also search medical institutions" banner appears automatically, so guidance is functional

### Visual Distinction of Cards

When pharmacies and medical institutions appear in mixed search results, users must be able to distinguish them at a glance. Medical institution cards feature a red left border + a "Medical Institution" (医療機関) label + a note: "An in-person consultation and prescription are required." On the map, pharmacies use blue pins and medical institutions use red pins.

---

## 5. Geolocation UX

Sorting by "nearest" requires the browser's geolocation, but we do not use the browser's standard `confirm()` dialog.

### Problem

In the context of emergency contraception, a system dialog feels like a "warning" and amplifies anxiety. The standard OS wording — "This site wants to use your location" — can be frightening in a privacy-sensitive situation.

### Solution: Inline Privacy Panel

- A permanent note next to the "📍 Nearest" button: "Your location is never recorded or transmitted"
- On first click: an in-page panel expands with a privacy explanation + "Sort by nearest using location" / "Cancel" buttons
- On subsequent uses: toggle only, no panel (do not re-explain to users who already understand)

Geolocation is used solely for in-browser distance calculations and is never sent to a server. As a static site, there is no server to send it to.

---

## 6. Hours Parser Philosophy

The MHLW data's `hours` field contains 6,933 distinct format variations. Rather than aiming for 100% parsing, we adopted a design of **97% accurate parsing + 3% graceful fallback**.

### Why Not Aim for 100%?

- The remaining 3% consists of natural language patterns (e.g., "1st and 3rd Saturday mornings only") or data quality issues that are fundamentally beyond what regex-based parsers can handle
- Pursuing 100% means adding complex logic for rare patterns → difficult maintenance → risk of introducing bugs in the existing accurate parsing
- Even when parsing fails, displaying the raw data as-is allows users to read it themselves. No information is lost

### Fallback Strategy

Unparseable business hours are displayed as raw data (exactly as recorded by MHLW). "Showing raw data" is safer than "pretending to have parsed it and displaying inaccurate information." With emergency contraception, believing incorrect business hours and arriving at a closed facility can have serious consequences.

### Holiday Handling

Holiday detection is implemented as pure computation with zero external API dependencies (`getJapaneseHolidays()`, approximately 70 lines). It covers fixed-date holidays, Happy Monday holidays, vernal and autumnal equinoxes (astronomical formulas), substitute holidays (振替休日), and citizens' holidays (国民の休日), valid through approximately 2099.

Reasons for not depending on external holiday APIs:
- We do not want to add network-dependent failure points to an emergency tool
- Japanese holidays are determined by law and are computable (temporary changes due to special legislation are handled through annual checks)

---

## 7. Technology Selection Principles

The consistent principle is **free, no API key required, static hosting**.

| Choice | Reason |
|---|---|
| **Leaflet.js + OpenStreetMap** | Free. Google Maps Platform is paid |
| **University of Tokyo CSIS Geocoding** | Free, no API key required, address-level precision |
| **GitHub Pages** | Free static hosting. No server operations required |
| **Vanilla JS (no framework)** | No build step. Files in `docs/` are the production build as-is. Fewer dependencies = easier long-term maintenance |
| **GitHub Actions** | Automated daily data updates. The free tier is sufficient |

For details on the rationale for each technology choice and rejected alternatives, see the [Feature Spec](FEATURE_SPEC_EN.html).

### Why a Static Site?

- We do not want to impose server operation costs and maintenance burden on a personal project
- As an emergency tool, we want to eliminate the risk of server downtime (GitHub Pages offers high availability)
- Data updates are processed as daily batches via GitHub Actions. Real-time updates are unnecessary (MHLW data is updated approximately once per month)

---

## 8. Data Pipeline Cache Design

`update_data.py` fetches and processes MHLW's XLSX to generate `data.json`. When a cache file (`data/data_*.json`) already exists for the same as-of date, the script skips regeneration to avoid unnecessary downloads and noisy git diffs.

### Problem: Incomplete Cache Key

Whether a cache is "valid" should depend on **two inputs combined**:

1. **Source data** (MHLW XLSX) — identified by the `as_of` date
2. **Processing logic** (`update_data.py` itself) — if the script changes, output changes

Originally, only the source data match was checked. This meant that when the processing logic was modified (e.g., adding empty record exclusion, adding meta fields), the existing cache was still judged "valid," and the new logic was never applied.

This has the same structure as a classic build system problem: if you modify source code but do not recompile the object files, the old binary continues to be used.

### Solution: Input-Hashed Cache Invalidation

`meta.scriptHash` stores the SHA-256 hash (first 16 characters) of the script itself. During cache validation, this hash is compared against the current script's hash. A mismatch triggers a cache miss and regeneration from the XLSX.

```
Cache key = as_of date + scriptHash
  → Same source data + different script → cache miss
  → Same script + different source data → cache miss
```

This technique follows the same principle as Docker layer caching, Webpack's contenthash, and Nix/Bazel build hashes: **never use the cache unless all inputs match.**

### Why a Hash Instead of a Version Number?

| Approach | Advantage | Disadvantage |
|---|---|---|
| Manual version number | Explicit | Can be forgotten — reproduces the same structural problem as this bug |
| Script hash | **Fully automatic.** Impossible to forget | Comment-only changes also trigger regeneration (no practical impact — regeneration takes seconds) |

Safety mechanisms that depend on manual procedures break the moment the procedure is forgotten. What can be automated, should be automated.

### Implementation

- **`_script_hash()`**: `Path(__file__).read_bytes()` → SHA-256 → first 16 characters
- **`looks_like_valid_app_json()`**: `meta.scriptHash != _script_hash()` → `False` (cache invalid)
- **Generation**: `meta.scriptHash = _script_hash()` embeds the hash

---

## Related Documents

- [Feature Spec](FEATURE_SPEC_EN.html) — Requirements and technical approach for all 4 features
- [Hours Parser Design](HOURS_PARSER_EN.html) — Detailed design of the multi-stage normalization pipeline
