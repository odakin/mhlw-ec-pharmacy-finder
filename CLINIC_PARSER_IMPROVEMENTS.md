# 医療機関データ解析の改善指示書

## 概要

医療機関データ（clinics.json, 3,105件）のパース品質を3点改善する。

1. **obgyn フィールドの URL 断片混入修正**（Python パーサー）
2. **stock フィールドの正規化とフィルター漏れ修正**（Python パーサー）
3. **医療機関の営業時間パーサー改善**（JS フロントエンド）

## 設計原則（DESIGN.md 準拠）

- **Missing info > Wrong info**: 不確実なデータは表示しないより、パースせず生テキスト表示
- **既存薬局パーサーのリグレッション禁止**: 変更後に薬局カバー率 97.1% を維持すること
- **最小限の変更**: 各修正は独立しており、段階的に適用可能

---

## 改善1: obgyn フィールドの URL 断片混入修正

### 現状

PDF の URL 列が長いとセルが溢れて隣の obgyn 列に食い込む（10件）。

| 施設名 | obgyn 値 | 原因 |
|--------|---------|------|
| 坂出市立病院 | `e-hospital/ 有` | URL 末尾が混入 |
| さぬき市民病院 | `pital/ 有` | 同上 |
| はやし女性クリニック | `hayashi 有` | 同上 |
| 大沼産婦人科医院 | `00899/ 有` | 同上 |
| 他6件 | `/ 有`, `n/ 有` 等 | 同上 |

### 修正方針

`update_clinics.py` の `parse_pdf()` 後処理で obgyn を正規化する。

```python
def normalize_obgyn(val: str) -> str:
    """Normalize obgyn field (産婦人科の有無).

    PDF parsing sometimes leaks URL fragments into this column.
    Strip ASCII prefix garbage and normalize to 有/無/あり/empty.
    """
    if not val:
        return ""
    # Strip leading URL fragments (ASCII chars, digits, slashes, dots)
    cleaned = re.sub(r'^[a-zA-Z0-9/.:_\-]+\s*', '', val)
    if not cleaned:
        return val  # Safety: don't destroy data if pattern doesn't match
    return cleaned
```

### 影響範囲

- 10件の obgyn が正規化される
- `有産婦人科` 等の意味ある接尾辞はそのまま保持（ASCII prefix のみ除去）
- フロントエンド変更なし（obgyn はカード上に表示されないが、検索ブロブに含まれる）

### 安全性

- obgyn は現在フィルタリング・表示に使用されていない。修正は検索精度のみに影響
- 正規表現は ASCII 文字列のみ除去し、日本語部分は一切変更しない
- `有` を含まない値（`無` 等）は除去パターンに合致しないため変更されない

---

## 改善2: stock フィールドの正規化

### 現状

フロントエンドのフィルター（`startsWith("有")` or `=== "あり"`）で漏れるエッジケース（8件）。

| 施設名 | stock 値 | 正しい扱い |
|--------|---------|-----------|
| 戸田医院 | `ほぼ有（在庫少）` | 有 相当 → 表示すべき |
| 住吉レディースクリニック | `少々有` | 有 相当 → 表示すべき |
| 産科婦人科すがのウィメンズクリニック | `16:00-17:30あり` | 条件付き → 除外が妥当（時間限定は信頼性低い） |
| つるぎ町立半田病院 | `病院前院外薬局に有` | 院外 → 除外（DESIGN.md §2 の3軸評価: 院外処方は除外） |
| 新田クリニック | `0 有` | PDF パースのカラムずれ → `有` に正規化 |
| 東京医科大学茨城医療センター | `0` | 同上のずれで欠損 → 空文字に正規化 |
| 愛育レディースクリニック | `原則予約対応` | stock 情報ではない → 変更不要（フィルター除外で正しい） |
| 医療法人 塚原医院 | `※要有予約` | 「予約が要る」であり stock 情報ではない → 変更不要 |

### 修正方針

`update_clinics.py` に stock 正規化関数を追加:

```python
def normalize_stock(val: str) -> str:
    """Normalize stock field for consistent frontend filtering.

    Frontend filters on startsWith("有") or === "あり".
    Fix known edge cases where stock info doesn't match this pattern.
    """
    if not val:
        return ""
    # Fix column offset artifact: leading "0 " or standalone "0"
    s = re.sub(r'^0\s+', '', val)
    if s == '0':
        return ''
    # Normalize "ほぼ有" -> "有（在庫少）"
    if s.startswith('ほぼ有'):
        return '有（在庫少）'
    # Normalize "少々有" -> "有（少量）"
    if s == '少々有':
        return '有（少量）'
    return s
```

### 影響範囲

- 4件が正規化される（ほぼ有 → 有、少々有 → 有、0 有 → 有、0 → 空）
- 他の4件（16:00-17:30あり、病院前院外薬局に有、原則予約対応、※要有予約）は変更しない
  - 理由: DESIGN.md §2 の設計原則に沿って除外が正しい

### 安全性

- `startsWith("有")` フィルターに合致するよう正規化するだけ。新たに除外される施設はない
- `0` → 空文字は、データが欠損しているケースなので除外が正しい
- 条件付き stock（16:00-17:30あり）は意図的に放置 — 時間帯に来れるか不明な利用者に見せるのはミスリーディング

---

## 改善3: 医療機関の営業時間パーサー改善

### 現状

既存パーサー（normalizeHoursText + parseHours）を医療機関データに適用すると:
- パース成功: 2,268/3,103 = **73.1%**
- パース失敗: 835件（26.9%）

失敗の内訳:

| カテゴリ | 件数 | 割合 | 対応可能性 |
|---------|------|------|-----------|
| セパレータなし（時間→曜日の連結） | 231 | 27.7% | 後述: 原因は注記セグメント |
| 外来診療時間内/なし/予約等 | 159 | 19.0% | 対応不可（構造化された時間ではない） |
| X曜を除く | 48 | 5.7% | 対応可能 |
| 括弧で曜日囲み | 40 | 4.8% | 既存 normalizeHoursText で部分対応済み |
| AM/PM 表記 | 18 | 2.2% | 対応可能 |
| 年中/常時 + 接尾辞 | 6 | 0.7% | 対応可能 |
| その他 | 333 | 39.9% | 後述: 大半は注記セグメントが原因 |

### 根本原因分析

最大の失敗原因は **parseHours の564行目 `return null`**:

```javascript
const m = seg.match(/^([月火水木金土日祝毎第]...)[:](.+)$/);
if (!m) return null; // can't parse -> give up on entire string
```

医療機関データには `日・祝・GW・お盆・年末年始除く` `火・祭日・日・土午後休診` のような **注記セグメント** が頻出する。現在のパーサーは1つでもパース不能なセグメントがあると文字列全体を失敗にするため、前半の有効な曜日:時間セグメントも道連れで失われる。

これは薬局データ向けの設計判断（HOURS_PARSER.md: "Unparseable day spec → fail entire string, display raw text"）だが、医療機関データとの相性が悪い。

### 修正方針

2段階で改善する。

#### 段階A: normalizeHoursText の拡張（6変更）

既存の正規化パイプラインに追加。薬局データにも適用されるため、リグレッションテスト必須。

1. **AM/PM → 24h 変換**（18件回収）
   - `PM3:30` → `15:30`、`AM9:00` → `9:00`
   - 挿入位置: 全角→半角変換の直後、時間正規化の前
   - 注意: `PM16:00`（既に24h）は変換しない（hour >= 12 の場合はそのまま）

2. **午前/午後の除去**（一部回収）
   - `午前9:00` → `9:00`、`午後3:30` → `15:30`
   - 午後で hour < 12 の場合のみ +12
   - `午前診` `午後休診` 等のテキスト内の午前/午後は変換しない（後ろに数字がある場合のみ）

3. **`Xを除く` の汎用化**（48件回収）
   - 現在: `祝を?除く` のみ除去
   - 拡張: `[月火水木金土日祝]+を?除く` を除去
   - 注意: 曜日除外情報は失われるが、既存設計思想（"Missing info > Wrong info"）に合致。水曜を除く月-金 の場合、月-金として表示（水曜が休みという情報は失われるが、完全な失敗よりまし）

4. **常時 → 毎日**（6件回収）
   - `常時` → `毎日` に変換
   - `常時可` `常時対応` なども `毎日` に（接尾辞はパーサーがスキップ）

5. **24時間変換後の接尾辞除去**
   - 現在: `24時間` → `毎日:0:00-24:00` だが `24時間可` → `毎日:0:00-24:00可` で失敗
   - 修正: 変換後に `(毎日:0:00-24:00).+` → `毎日:0:00-24:00`

6. **休診/対応不可 等の接尾辞除去の強化**
   - 現在のパターン: `休み`, `閉局`, `定休`, `休業`
   - 追加: `休診`, `対応不可`
   - `土日祝対応不可` `火・祭日・日・土午後休診` 等を除去

#### 段階B: parseHours の注記セグメントスキップ（最大効果）

parseHours 564行目の `return null` を条件分岐に変更:

```javascript
if (!m) {
  // If segment looks like a note/comment (not a real day:time spec), skip it
  if (/[除休不]{1}|対応|要|予約|限|可能|時間外|時間内|緊急|指定|のみ$|GW|お盆|年末|祭/.test(seg)) {
    continue;  // Skip note segments
  }
  return null; // Genuinely malformed -> fail entire string
}
```

**この変更の根拠**:
- 注記セグメント（`日・祝・GW・お盆・年末年始除く`）は時間情報を含まない。スキップしても情報は失われない
- `return null` を維持するケース: 曜日+時間のように見えるがパースできないセグメント（例: `月・火 不定期`）→ 部分パースはミスリーディングなので全体失敗が正しい
- 注記かどうかの判定は保守的: 上記キーワードを1つも含まないセグメントは従来通り全体失敗

**薬局データへの影響**:
- 薬局データの失敗ケース（292件）の大半は括弧内例外や複数行パターン。注記セグメントは稀
- 万が一スキップされても、表示される情報（パース成功した前半セグメント）は正しい

### 期待されるカバー率

- 段階A のみ: 73.1% → 推定 78-82%
- 段階A + B: → 推定 **85-90%**
- 残りの 10-15% は「外来診療時間内」「なし」等の非構造化テキストで、パース不可能（生テキスト表示が正しい）

### フロントエンドの変更

現在の医療機関カード（app.js 1121行目）:
```javascript
${r.hours ? `<div class="detail"><span class="k">対応可能時間帯</span> ${escapeHtml(r.hours)}</div>` : ``}
```

パース結果を使うよう変更:
```javascript
// Clinic hours: use parsed hours if available, raw text fallback
const clinicHoursInfo = getHoursInfo(r.hours, jstCtx);
const clinicHoursHtml = clinicHoursInfo.parsed
  ? renderHoursHtml(r.hours, clinicHoursInfo)
  : (r.hours ? `<div class="detail"><span class="k">対応可能時間帯</span> ${escapeHtml(r.hours)}</div>` : ``);
```

### リグレッションテスト手順

1. 変更前に薬局データのパース成功件数を記録（現在 9,659/9,951 = 97.1%）
2. normalizeHoursText 変更後に同じテストを実行
3. 成功件数が下がっていないことを確認
4. 医療機関データのパース成功件数を記録（目標: 85%以上）

---

## 実装順序

1. `update_clinics.py` に `normalize_obgyn()` と `normalize_stock()` を追加 → clinics.json 再生成
2. `docs/app.js` の normalizeHoursText を拡張（段階A）→ リグレッションテスト
3. `docs/app.js` の parseHours を修正（段階B）→ リグレッションテスト
4. 医療機関カードのテンプレートを修正
5. SESSION.md / HOURS_PARSER.md を更新

## 除外事項（今回やらないこと）

- 括弧内の昼休み除外パース（`13:00-14:00は閉局` 等）— 複雑度が高く ROI が低い
- 第N週パターンの部分表示 — 設計判断の再検討が必要
- 「現在営業中」フィルター — DESIGN.md §2 で実装しないと決定済み
