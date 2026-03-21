# Business Hours Parser Design Document

## Why Is It So Complex?

### Root Cause: Free-Text Data from MHLW

The `hours` field in the MHLW (Ministry of Health, Labour and Welfare) pharmacy dataset (10,128 records) is **free-form text**. There is no standardized format specified; each prefecture and pharmacy enters data in its own way. The same schedule "Mon-Fri 9:00-18:00" can be written in thousands of different ways.

### The Simple Approach We Tried First

The first version (89.4% coverage) only handled "clean" patterns like `月-金:9:00-18:00,土:9:00-13:00` (Mon-Fri:9:00-18:00,Sat:9:00-13:00). However, more than 10% of records failed to parse due to full-width characters, kanji time notation, parentheses, slashes, typos, and more.

### Why It Grew Complex Incrementally

Each time a new rule was added, cases were discovered where it interfered with existing rules' output. For example, converting `金9時` (Fri 9 o'clock) to `金9:00` then required a colon insertion step to produce `金:9:00`. Because **normalization rules have order dependencies**, they cannot be added ad hoc — the entire pipeline's consistency must be maintained.

### The Complexity in Numbers

- Out of 9,951 records (non-empty hours), there are approximately 6,933 unique formats
- `normalizeHoursText` alone has 75 `.replace()` calls (~156 lines)
- The entire parser (normalization through rendering) is ~590 lines with ~150 regex patterns
- The result: 97.1% coverage (9,659 records parseable; the remaining 2.9% are natural language, URLs, or bad data)

## Architecture Overview

```
Raw text
  |
  +-> holidayClosed detection (at start of parseHours, before normalization)
  |
normalizeHoursText()  <- Text normalization (75 replacement rules)
  |
Normalized text (e.g., "月-金:9:00-18:00,土:9:00-13:00")
  |
splitHoursSegments()  <- Split by day-of-week groups
  |
Segment array (e.g., ["月-金:9:00-18:00", "土:9:00-13:00"])
  |
parseHours()          <- Extract days + time ranges + holiday info from each segment
  |
Structured data: { schedule, holidaySchedule, holidayClosed }
  |
getHoursInfo(raw, ctx) <- Determine today's business status (considering holidays & overnight hours)
  |                        ctx = getJstContext() (compute JST date/time once per batch)
  |                        isJapaneseHoliday() for holiday detection
  |
{ todayRanges, isOpen, isHoliday, holidayClosed, ... }
  |
renderHoursHtml(raw, info) <- Generate HTML: badges + weekly schedule + holiday row
```

## normalizeHoursText(): Why 75 Rules?

The purpose is to converge input text variations into "one canonical form." Each rule addresses a specific pattern found in real data.

### Phase 1: Character-Level Unification

**Why this comes first**: All subsequent rules assume half-width, standard characters like `9:00`, `-`, `月` (Mon). Without this unification, every subsequent regex would need both full-width and half-width variants, making maintenance impossible.

| Rule | Input example | Output | Why needed |
|------|---------------|--------|------------|
| Full-width digits -> half-width | `９：００` | `9:00` | Full-width mixing is very common |
| Colon-like unification | `：` `∶` `︓` `ː` | `:` | 5 types of colon-like characters exist in real data |
| Tilde variants -> `~` | `～` `〜` `∼` | `~` | 4 types of range symbols |
| Dash variants -> `-` | `－` `‐` `−` `–` `—` `ー` `―` `ｰ` | `-` | 9 types of hyphens/dashes exist |
| Punctuation unification | `､` `、` `，` | `,` | Delimiter variation |
| CJK compatibility chars | `⽉` `⼟` `⽇` | `月` `土` `日` (Mon, Sat, Sun) | Unicode compatibility-area characters found in some data |

> **Real example**: One prefecture's entire dataset used `⽉⽕⽔⽊⾦⼟⽇` (CJK compatibility forms) for all day-of-week characters.
> They look identical to `月火水` (Mon Tue Wed) visually, but have different Unicode code points, so the regex `[月火水]` does not match them.

### Phase 2: Japanese Expression Normalization

**Why needed**: The same day of the week can be written three ways: `月` `月曜` `月曜日` (Mon / Monday / Monday-day). There are also Japanese abbreviations like `平日` (weekdays) and `年中無休` (open year-round). Without unifying days to single characters, the day-of-week parser (`parseDaySpec`) would face combinatorial explosion.

| Rule | Input example | Output | Why needed |
|------|---------------|--------|------------|
| Day-of-week suffix stripping | `月曜日` `金曜` | `月` `金` (Mon, Fri) | Single char suffices. But `金曜日曜` -> `金日` (see below) |
| Range-end + day adjacency | `月-金日` (after stripping) | `月-金・日` (Mon-Fri + Sun) | Stripping `曜` causes `金` (Fri) and `日` (Sun) to merge |
| `年中無休` -> `毎日` | `年中無休` (open year-round) | `毎日` (every day) | Day-unspecified expression |
| `平日` -> `月-金` | `平日` (weekdays) | `月-金` (Mon-Fri) | Japanese abbreviation |
| `24時間` -> all day | `24時間` (24 hours) | `毎日:0:00-24:00` (every day:0:00-24:00) | |
| `時`/`分` notation | `9時30分` `18時` | `9:30` `18:00` | Kanji time notation (hour/minute) |
| `から` -> `-` | `月から金` `9:00から18:00` (Mon to Fri, 9:00 to 18:00) | `月-金` `9:00-18:00` | Hiragana conjunction ("from...to") |
| `は`/`が` -> `:` | `月は9:00` `水が8:00` (Mon is 9:00, Wed is 8:00) | `月:9:00` `水:8:00` | Particles used as delimiters |

> **Tricky case: Greedy match on `金曜日曜` (Friday + Sunday)**
> Stripping `曜日?` from `月曜-金曜日曜9:00-18:00` (Mon-Fri-Sun 9:00-18:00) causes `金曜日` (Friday) to match greedily, consuming the `日` (Sun) character, and Sunday disappears.
> Fix: `曜(?:日(?!曜))?` — do not consume `日` if followed by `曜` (it's the start of the next day-of-week).
> An additional rule was then needed to separate `月-金日` (Mon-FriSun) into `月-金・日` (Mon-Fri + Sun) after stripping.

### Phase 3: Delimiter Normalization

**Why needed**: parseHours recognizes only the `day:time` format. But input data uses the following as delimiters between day-of-week and time:

- Colon `:` (standard)
- Space: `月-金 9:00`
- Direct concatenation: `月-金9:00`
- Slash: `月-金/9:00`
- Semicolon: `月-金;9:00`
- Parentheses: `(月火金)9:00`, `月火木）9:15`
- Square/corner brackets: `［月-金］9:00`, `【月】9:00`

All are unified to the `day:time` format.

Segment delimiters are similarly varied:
- Comma `,` (standard)
- Slash: `月-金:9:00/土:9:00`
- Period: `月-金:8:30.土:8:30`
- Space: `月-金:9:00 土:9:00`
- Japanese period: `｡`
- Direct concatenation: `月-金:9:00-18:00土:9:00-13:00`

### Phase 4: Time Format Correction

| Rule | Input example | Output | Why needed |
|------|---------------|--------|------------|
| 3-4 digit times | `1800` `900` | `18:00` `9:00` | Colon omitted |
| Minutes omitted | `9-18:00` | `9:00-18:00` | Start time `:00` omitted |
| `.` -> `:` | `18.30` | `18:30` | Period as time separator |
| Double colon | `水::9:00` | `水:9:00` (Wed:9:00) | Typo |
| Consecutive time ranges | `14:0015:00` | `14:00 15:00` | Missing delimiter |

### Phase 5: Closed-Day and Holiday Information Extraction and Removal

**Two-stage processing**: With the addition of holiday support, this phase became a two-stage process: "extract then remove."

#### 5a: Holiday Information Extraction (inside parseHours, before normalization)

`parseHours()` extracts holiday-related information from the raw text **before** normalization:

1. **holidayClosed flag**: Patterns like `祝休み` (holidays closed), `日祝:閉局` (Sun/holidays: closed), `定休日:日・祝` (regular holidays: Sun + holidays), `祝を除く` (excluding holidays), etc. are detected using 6 regex patterns. These strings would be removed during normalization, so they must be detected first.
2. **holidaySchedule**: After normalization and segment splitting, holiday business hours like `祝:9:00-17:00` (holidays: 9:00-17:00) are captured and stored in the `holidaySchedule` array.

```
月-金:9:00-18:00,日祝:休み → holidayClosed = true
  (Mon-Fri:9:00-18:00, Sun/holidays: closed)
月-金:9:00-18:00,祝:9:00-12:00 → holidaySchedule = [{open:"9:00", close:"12:00"}]
  (Mon-Fri:9:00-18:00, holidays:9:00-12:00)
```

#### 5b: Closed-Day Text Removal (inside normalizeHoursText)

After extraction, closed-day text is removed during the normalization pipeline. The day-of-week parser outputs `{days, open, close}` arrays and has no type to represent "closed." Leaving the text in causes parse failures that drag down otherwise-parseable business hours to raw-data display. By removing it, only business days are structured, and closed days are implicitly represented as "not in the schedule = closed."

```
月-金:9:00-18:00,土日祝休み      → 月-金:9:00-18:00
  (Mon-Fri:..., Sat/Sun/holidays closed)
月-金:9:00-18:00,日祝:定休       → 月-金:9:00-18:00
  (Mon-Fri:..., Sun/holidays: regular holiday)
月-金:9:00-18:00,休:日祝         → 月-金:9:00-18:00
  (Mon-Fri:..., closed: Sun/holidays)
月-金:9:00-18:00 日              → 月-金:9:00-18:00
  (Mon-Fri:... Sun — trailing bare day-of-week = closed)
月-金:9:00-18:00,水日祝は        → 月-金:9:00-18:00
  (Mon-Fri:..., Wed/Sun/holidays [closed])
```

### Phase 6: Ordinal Day (Nth weekday) Handling

**Why skip**: `第1・3土曜:9:00-12:00` (1st & 3rd Sat: 9:00-12:00) means "open only on the 1st and 3rd Saturdays of the month." A weekly schedule (`{days, open, close}`) cannot represent "which week's which day."

Initially, the plan was to "strip the ordinal and treat it as a regular weekday" (i.e., display as every Saturday). However, **the user pointed out that this is incorrect — it changes the meaning of the information.** Displaying "1st & 3rd Saturday only" as "every Saturday" would cause people to visit on the 2nd, 4th, and 5th Saturdays. Since this information relates to medication access, **missing information is better than wrong information** — that was the design decision.

During normalization:
- Kanji numerals to Arabic: `第一土` (1st Sat) -> `第1土`
- Ordinal separator unification: `第1,3,5` / `第1.3.5` -> `第1・3・5`
- Parenthesized ordinal + time range: `(第2,4木:9:00-19:30)` ((2nd,4th Thu:9:00-19:30)) -> removed

During parseHours:
- `土(第1-3):8:30-18:00` (Sat (1st-3rd):...) -> skip Sat (ordinal-limited, not weekly)
- `水・土(第1・3・4):9:00-13:00` (Wed + Sat(1st,3rd,4th):...) -> keep only Wed, skip Sat(1st,3rd,4th)
- `月-金,第1・3・5土:9:00-19:00` (Mon-Fri, 1st/3rd/5th Sat:...) -> keep only Mon-Fri, skip ordinal Sat

**Design decision**: Missing information is acceptable, but **displaying incorrect information is not**. It is better for Saturday information to be absent than to mislead users into thinking "this pharmacy is open on Saturdays."

## splitHoursSegments(): Why Simple Split Doesn't Work

**Initially it was just `.split(",")`.** But since the meaning of commas changes with context, simple splitting broke in many cases:

1. **Segment delimiter**: `月-金:9:00-18:00,土:9:00-13:00` (Mon-Fri and Sat are separate groups)
2. **Time range delimiter**: `月-金:9:00-13:00,14:00-18:00` (AM and PM sessions — split shift)
3. **Day enumeration**: `月,水,金:9:00-18:00` (Mon, Wed, Fri share the same hours)

Algorithm:
1. First split at boundaries where a time is followed by a day-of-week (`9:00-18:00土:` -> 2 segments)
2. Within each segment, split by comma and merge using heuristics:
   - "day + time" -> new segment
   - "time only" -> append to previous segment (AM/PM split shift)
   - "day only" -> merge with next element (`月,水,金:9:00` -> `月・水・金:9:00`)

## parseTimeRange(): Time Validation

**Why allow up to 29:59**: In Japanese convention, late-night hours are written as `25:00` (= 1:00 AM the next day). Rejecting times after `24:00` would reject valid data. An upper limit of 29:59 is sufficient in practice.

**Why validation is needed**: The source data contains typos:
- `8:30-6:00` — probably `8:30-16:00` or `8:30-18:00`
- `9:00-1:30` — probably `9:00-13:00`

Without validation, `80:30` or `88:50` would also pass (both actually occurred). Range checking for hours 0-29 and minutes 0-59 catches these, falling back to raw data display.

## expandDayRange(): Wrap-Around Handling

**Why do-while**: `月-日` (Mon-Sun) means "Monday through Sunday = all 7 days." Internal day-of-week numbers are `日(Sun)=0, 月(Mon)=1, ..., 土(Sat)=6`, so `月(1)-日(0)` wraps as `1->2->3->4->5->6->0`.

The initial implementation was `for (i=start; i<=end; i++)`. For `月-日` (Mon-Sun), `1<=0` was immediately false, producing an empty array and a parse failure. Fixed with `do-while` + modular arithmetic to correctly handle wrap-around.

## parseDaySpecExtended(): Compound Day-of-Week Specifications

`parseDaySpec()` handles only simple patterns (`月-金` (Mon-Fri) or `月・火・木` (Mon/Tue/Thu)). `parseDaySpecExtended()` handles the following compound patterns:

- Range + individual: `月-水・金` -> [Mon, Tue, Wed, Fri]
- Consecutive characters: `月火水金` -> [Mon, Tue, Wed, Fri] (enumeration without `・` separators)
- Comma-separated: `月,火,水,金` -> [Mon, Tue, Wed, Fri]
- Mixed: `月-水,金,土日祝` -> [Mon, Tue, Wed, Fri, Sat, Sun] (`祝` (holiday) is skipped)

## Why the Remaining 2.9% Cannot Be Parsed

Main causes for the 292 unparseable records:

| Cause | Example | Count (approx.) |
|-------|---------|-----------------|
| Exception conditions inside parentheses | `月～金：9:00-17:00、（13:00-14:00は閉局）` (Mon-Fri:9:00-17:00, (closed 13:00-14:00)) | ~50 |
| Per-day descriptions (tab-separated) | `月\t09:00～19:00火\t09:00～19:00...` (Mon\t09:00-19:00 Tue\t09:00-19:00...) | ~20 |
| URLs | `https://www.example.com` | A few |
| No time range | `月-金:` (Mon-Fri:) | A few |
| Natural-language conditions | `お客様感謝デーを除く` (except customer appreciation days) `隔週で17:00まで` (until 17:00 every other week) | ~30 |
| Mismatched parentheses | `土(第２，4:8:30-17:00)` (Sat(2nd,4th:8:30-17:00)) | ~20 |
| Bad data | `9:00-8:00` `8:30-6:00` | ~10 |

The cost of handling these individually (increased code complexity) yields only marginal coverage improvement, so they fall back to raw data display.

## Holiday Support

### Why Consider Holidays

The business hours data contains holiday-related information such as `祝日休み` (closed on holidays) and `日祝:9:00-12:00` (Sun/holidays: 9:00-12:00), but the initial implementation did not check whether today is a holiday. This resulted in:

- A pharmacy with `月-金:9:00-18:00,日祝休み` (Mon-Fri:9:00-18:00, closed Sun/holidays) showing as "Open" on a holiday Monday
- In reality it's closed -> the user makes a wasted trip

### Three-Layer Architecture

```
Layer B: getJapaneseHolidays(year) / isJapaneseHoliday(date)
  -> Pure computation (~60 lines). Zero external dependencies, valid through ~2099
  -> Fixed dates, Happy Monday, vernal/autumnal equinox (astronomical formula),
     substitute holidays, citizens' holidays

Layer A: parseHours() extension
  -> Detect holidayClosed (holiday-closed flag) from raw text via regex
  -> Extract holidaySchedule (holiday business hours) from post-normalization segments
  -> Existing day-of-week parsing is completely unchanged

Layer C: getHoursInfo() extension
  -> Use isJapaneseHoliday(today) for holiday detection
  -> holidayClosed -> show as closed
  -> holidaySchedule -> use holiday hours
  -> Neither -> fall back to regular weekday schedule
```

### holidayClosed Detection

Detected via 6 regex patterns against the raw text (before normalization):
- `祝休み` `祝:休み` `祝は休業` (holiday closed — forward patterns)
- `休業日:日祝` `定休日:日・祝` (closed days: Sun/holidays — reverse patterns)
- `祝を除く` `(祝除く)` (excluding holidays — exclusion expressions)
- `祝祭日` (national holidays) -> normalized to `祝`; half-width katakana middle dot `･` is also normalized

Detection rate: 137 / 152 cases (remaining 15 require parser core changes, high cost). False positives: 0.

### Overnight Hours: Cross-Midnight Determination

For time slots where `close > 24:00` (e.g., 25:00 = 1:00 AM the next day):
- Check the previous day's schedule and use `nowMin < closeMin - 1440` for determination
- If the previous day was a holiday, the holiday override is also considered

### Performance: getJstContext()

The `toLocaleString("en-US", {timeZone: "Asia/Tokyo"})` call inside `getHoursInfo()` is expensive. Calling it per card means ~50 calls per search, which is wasteful. The design was changed to compute JST date/time once per batch via `getJstContext()` and pass it as `getHoursInfo(raw, ctx)`.

## Code Notes

### Normalization Rule Order Dependencies

Many rules depend on the output of previous rules. Examples:

1. The `時` (hour) -> `:00` conversion must run after day-of-week stripping (`金9時` -> `金9:00` -> `金:9:00`)
2. Colon insertion (`金9:00` -> `金:9:00`) must re-run after the `時` conversion
3. Tilde-to-dash conversion must also re-run after `時` conversion (new `9:00~18:00` instances are generated)
4. Closed-day stripping must run after the `お休み` -> `休み` conversion

**Changing rule order requires regression testing against the full dataset.**

### parseHours Design Policy: Why No Partial Parse Results

When an unparseable segment is encountered, the **entire parse fails** (`return null`).

**Reason**: If `月-金:9:00-18:00,土:???,日:9:00-14:00` (Mon-Fri:..., Sat:???, Sun:...) skips only Saturday and returns Mon-Fri + Sun, the user would misunderstand that "this pharmacy is not open on Saturday." In reality, it may well be open on Saturday. Failing entirely and showing raw data lets the user judge for themselves.

Exceptions where graceful skipping is allowed are cases where skipping does not distort information:
- "Closed" segments (not operating anyway)
- Holiday segments (outside the scope of weekly schedules)
- Ordinal segments (Nth-weekday-only cannot be represented weekly; skipping is correct)
- Invalid time ranges (data typos)

### Testing Method

```sh
# Coverage test
node -e '
const code = require("fs").readFileSync("docs/app.js","utf8");
const endIdx = code.indexOf("function timeToMinutes");
global.document = {getElementById:()=>null};
eval(code.substring(0, endIdx));
const data = require("./docs/data.json").data;
let total=0, ok=0;
for (const r of data) {
  if (!r.hours?.trim()) continue;
  total++;
  const p = parseHours(r.hours);
  if (p?.schedule?.length) ok++;
}
console.log(ok + "/" + total + " = " + (ok/total*100).toFixed(1) + "%");
'
```

## Revision History

| Commit | Description | Coverage |
|--------|-------------|----------|
| 3c3c685 | Initial parser | 89.4% |
| 4fb20eb | 6 normalization improvements | 95.7% |
| 39c4597 | Ordinal day support | 96.6% |
| 03987aa | Fix Sat(Nth) skip (prevent information distortion) | 96.3% |
| 0580d00 | Ordinal handling refactor | 96.9% |
| 8d48a6a | Deep validation bug fix | 97.1% |
| 04853e7 | Fix greedy match on `金曜日曜` (FridaySunday) | 97.1% |
| c3a7f62 | Holiday support (3-layer architecture), Monday-start week | 97.1% |
| 85870b8 | holidayClosed regex expansion (125->137 cases), overnight isOpen fix, double parse elimination | 97.1% |
| d3091c7 | Performance improvement via getJstContext() | 97.1% |
