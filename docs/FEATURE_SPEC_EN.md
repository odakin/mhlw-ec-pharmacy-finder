# mhlw-ec-pharmacy-finder Feature Specification

## Overview

This document specifies features to be added to the emergency contraceptive pill (EC) pharmacy finder site: https://odakin.github.io/mhlw-ec-pharmacy-finder/. The goal is to close the gap with competing sites (e.g., EPARK Kusuri no Madoguchi https://www.kusurinomadoguchi.com/s?is_ecp=1) while preserving existing strengths (11,000+ pharmacies from official MHLW data, female pharmacist filter, no-appointment-needed filter, etc.).

**Constraints**:
- Static hosting on GitHub Pages. No server-side processing
- Avoid services that require external API keys (e.g., Google Maps Platform); prefer free, key-free alternatives
- Do not break existing UI/UX. Existing features (prefecture selector, free-text search, checkbox filters) remain as-is

---

## Feature 4: Google Maps Link (External Navigation to Each Pharmacy) -- Implemented

- A "📍 View on Google Maps" link has been added to each pharmacy card (commit d83b795)
- Link format: `https://www.google.com/maps/search/?api=1&query={encodeURIComponent(pharmacyName + ' ' + address)}`
- No API key required. One click gives access to photos, reviews, Street View, and navigation

---

## Feature 1: Map View -- Implemented (commits 514ad56, 3c3c685)

### Requirements
- Display search-result pharmacies as pins on a map
- Show a popup with pharmacy name, address, phone number, etc. on pin click/tap
- Include a "View on Google Maps" link inside each popup
- Allow toggling between list view and map view (tabs or toggle)
- Responsive design that works well on mobile

### Technical Approach
- **Map engine**: Leaflet.js + OpenStreetMap tiles (free, no API key)
- **Geocoding**: University of Tokyo CSIS Simple Geocoding Service
  - Endpoint: `https://geocode.csis.u-tokyo.ac.jp/cgi-bin/simple_geocode.cgi?charset=UTF8&addr={address}`
  - Free, no API key, no user registration required
  - High accuracy down to house-number level (iLvl 5-8)
  - Verified: 9 out of 10 test addresses resolved to house-number level or better. Nominatim failed on all Japanese addresses and was rejected
- **Cache design**: `data/geocode_cache.json` (append-only)
  - Structure: `{ "66": {"lat": 43.762955, "lng": 142.359726, "lvl": 8, "addr": "original address"}, ... }`
  - ID is the MHLW "pharmacy number" (yakkyoku-tou bangou), which is stable
  - Retains data for deleted pharmacies (reusable if re-registered)
  - Only new or address-changed entries query CSIS. If CSIS is down, the entry is skipped (daily GitHub Actions run provides automatic retry)
- **Incremental updates**: 0.5-second interval. Initial run for 10,128 entries takes ~85 minutes. Subsequent daily runs process only dozens of new entries in seconds
- **Frontend delivery**: Copied to `docs/geocode_cache.json` at build time. Fetched only when the map tab is displayed (keeps initial load light)
- **Clustering**: Leaflet.markercluster (loaded via CDN)
- A guidance message is shown when search results exceed 200 entries, but display is not blocked
- Map is hidden on initial load (before any search)

---

## Feature 2: Distance from Current Location and Sort by Proximity -- Implemented (commit 3c3c685)

### Requirements
- Add a "Sort by nearest" button
- On button press, obtain the user's current location via the browser Geolocation API, calculate distance to each pharmacy, and sort
- Add an "approx. XX km" distance label to each pharmacy row
- If location access fails (denied/unsupported), show an appropriate error message and fall back to the default sort order
- In map view mode, also show the user's current location as a differently-colored pin

### Technical Approach
- Uses `navigator.geolocation.getCurrentPosition()`
- Haversine formula (straight-line distance) is sufficient; route distance is not needed
- UI informs the user that a location permission dialog will appear
- Sort toggle: switch between default order and nearest-first
- Distance calculation requires latitude/longitude, so Feature 1 (geocoding) is a prerequisite

---

## Feature 3: Business Hours Display -- Implemented (parser coverage: pharmacy 98.2% / clinic 88.3%)

### Challenges
- The `hours` field has 6,933 distinct format variations
- ~80% can be parsed with simple patterns, but ~20% are free-form text
- Misclassification risk is serious given the nature of emergency contraception -- going to a pharmacy that appears "open" but is actually closed is a critical failure
- The Google Maps link (Feature 4) already provides business hour information on Google Maps, so there is some functional overlap

### Implementation Details
- Multi-stage normalization parser (`~` -> `-`, `月曜日` -> `月` (Monday), `年中無休` -> `毎日` (every day), `平日` -> `月-金` (Mon-Fri), `24時間` -> `毎日:0:00-24:00` (24 hours), etc.)
- `splitHoursSegments()`: splits comma-less concatenated patterns using lookbehind
- `parseDaySpecExtended()`: handles patterns like `土日祝` (Sat/Sun/holidays), `月-水・金` (Mon-Wed & Fri), `月火水金` (Mon/Tue/Wed/Fri), etc. (holidays are skipped)
- Today's business status is highlighted (Open / Closed / Day off)
- Full weekly schedule shown in a collapsible section
- Unparseable entries (2.9%) display raw data as-is. See [HOURS_PARSER](HOURS_PARSER_EN.html) for design details
- **Exclusion info preservation and display**: Closed-day, exclusion, and partial-closure info is extracted before normalization and shown as amber-highlighted notes above the schedule grid in the collapsible section. Unambiguous closures are also applied to the schedule (conservative rule). Design principle: **Correct > Correct + caveat > Unknown > Wrong** (see DESIGN.md §6)
- Holiday support: national holidays (kokumin no shukujitsu) are determined by pure calculation; holiday closures and holiday-specific hours are displayed correctly
- Late-night business hours (close > 24:00) with date-crossing logic
- All entries include the note: "Please confirm business hours directly with the pharmacy"

---

## Implementation Priority

1. ~~**Feature 4** (Google Maps Link)~~ -- Done (d83b795)
2. ~~**Feature 1** (Map View)~~ -- Done (514ad56, 3c3c685)
3. ~~**Feature 2** (Sort by Proximity)~~ -- Done (3c3c685)
4. ~~**Feature 3** (Business Hours Display)~~ -- Done (pharmacy 98.2% / clinic 88.3% coverage)

## Data Structure (Investigated)

- **Latitude/longitude: Not present** -- Geocoded via University of Tokyo CSIS (house-number-level accuracy, free)
- **Business hours: Present** -- `hours` field. Pharmacy 98.2% / clinic 88.3% parseable (see [HOURS_PARSER](HOURS_PARSER_EN.html))
- **Data loading**: Fetches `docs/data.json`. 10,128 entries
- **Coordinate data loading**: Fetches `docs/geocode_cache.json` only when map is displayed (separate file to keep initial load light)
- **Public directory**: `docs/` (GitHub Pages)
- **Frontend**: `docs/index.html` + `docs/app.js` + `docs/style.css` (vanilla JS, no framework)

---

## Other Decisions

- **Online reservation integration**: Out of scope -- requires pharmacy-side systems
- **Direct pharmacy photos**: Out of scope -- no data source, API costs unrealistic. Google Maps link (Feature 4) serves as an alternative
- **User reviews**: Same as above. Google Maps link serves as an alternative
- **Nominatim**: Failed on all Japanese addresses (0 out of 10 hits). Rejected
- **Google Geocoding API**: High accuracy but paid (~$50). University of Tokyo CSIS provides equivalent accuracy for free. Rejected
