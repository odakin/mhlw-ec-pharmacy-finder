# CLAUDE.md

## プロジェクト概要

厚生労働省が公表する緊急避妊薬の**薬局一覧**（要指導医薬品販売）と**医療機関一覧**（対面診療・処方）を検索しやすくした非公式ツール。GitHub Pages で静的ホスティング。

- **公開URL**: https://odakin.github.io/mhlw-ec-pharmacy-finder/
- **公式データ出典（薬局）**: https://www.mhlw.go.jp/stf/kinnkyuuhininnyaku_00005.html
- **公式データ出典（医療機関）**: https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000186912_00002.html

## リポジトリ構成

```
docs/                    → GitHub Pages 公開ディレクトリ
  index.html / app.js / style.css  → フロントエンド（バニラJS）
  data.json              → 薬局データ（9,951件。空レコード除外前の厚労省公表件数は10,128件）
  clinics.json           → 医療機関データ（3,107件、PDFパース）
  geocode_cache.json     → ジオコーディング結果（フロントエンド配信用コピー）
  FEATURE_SPEC.html / HOURS_PARSER.html → ドキュメントHTML（marked.jsで.mdをfetch+render）
  marked.min.js          → Markdownレンダリング（ローカルバンドル）
  .nojekyll              → Jekyll無効化
data/                    → 元データ・キャッシュ
  *.xlsx / *.csv / *.json → 厚労省データ加工済み
  geocode_cache.json     → ジオコーディング結果（マスター）
scripts/
  update_data.py         → 公式ページからデータ更新（薬局、XLSX）
  update_clinics.py      → 医療機関PDFパース → clinics.json 生成
  geocode.py             → 東大CSIS APIでジオコーディング（薬局+医療機関の住所→緯度経度）
  hooks/pre-commit       → SESSION.md 更新漏れ防止フック
line_bot/                → LINE Bot サンプル
AGENTS.md                → コードレビューガイドライン
docs/FEATURE_SPEC.md     → 機能仕様書（4機能の要件・技術方針、GitHub Pages で公開）
docs/HOURS_PARSER.md     → 営業時間パーサー設計ドキュメント（GitHub Pages で公開）
```

## データ構造（docs/data.json）

```json
{
  "meta": { "asOf": "2026-03-10", "records": 9951, "totalPublished": 10128, "scriptHash": "...", ... },
  "data": [
    {
      "id": 66,
      "pref": "北海道",
      "muni": "旭川市",
      "name": "調剤薬局ツルハドラッグ旭川駅前店",
      "addr": "北海道旭川市宮下通9丁目2番17号",
      "tel": "0166213269",
      "url": "",
      "hours": "月-金:9:00-18:00､土:9:00-13:00",
      "afterHours": "",
      "afterHoursTel": "",
      "privacy": "衝立",
      "callAhead": "",
      "notes": "",
      "pharmacistsFemale": 2,
      "pharmacistsMale": 1,
      "pharmacistsNoAnswer": 0
    }
  ]
}
```

**注**: 緯度経度は `data.json` には含まれない。`geocode_cache.json`（`{ "id": {"lat", "lng", "lvl", "addr"}, ... }`）を地図表示時に別途 fetch する設計。

## データ構造（docs/clinics.json）

```json
{
  "meta": { "asOf": "2026-02-20", "records": 3107, ... },
  "data": [
    {
      "id": "c1",
      "pref": "北海道",
      "muni": "江別市",
      "name": "江別市立病院",
      "postal": "067-8585",
      "addr": "北海道江別市若草町6",
      "tel": "0113822121",
      "url": "",
      "obgyn": "有",
      "hours": "8:45-11:00（月-金）",
      "stock": "有"
    }
  ]
}
```

### `stock`（常時在庫の有無）フィールドの意味

厚労省PDF の列名は「常時在庫の有無」。**「常時」がポイント。**

| 値 | 意味 | 件数（2026-03時点） | サイトでの扱い |
|---|---|---|---|
| `"有"` / `"あり"` / `"有 薬品名..."` | **常時在庫あり** — いつ行っても院内に薬がある。その場でもらえる | 2,964件（95%） | **表示対象** |
| `"無"` / `"無（院外処方）"` 等 | **常時在庫なし** — 診察・処方はできるが、薬は院内に常備していない。院外処方箋を持って薬局へ行く必要がある | 136件（4%） | **除外**（※1） |
| `""` （空欄） | **未回答・不明** | 7件（0.2%） | **除外** |

**※1 除外の理由**: [DESIGN.md §2「フィルター設計原則」](docs/DESIGN.html)参照。3軸評価（一次情報＋代替あり＋ノイズ除去の実益）で除外を判定。

**重要な注意**:
- `"無"` ≠ 「絶対にない」。常備していないだけで、たまたま在庫がある場合や取り寄せ対応の可能性はある
- `"無（門前薬局に在庫あり）"` 等、近隣薬局との連携を補足しているケースもある
- フロントエンド（`loadClinics()`）で `stock` が `"有"` または `"あり"` で始まるレコードのみ読み込む設計

### 医療機関の地図マーカー

- 薬局: Leafletデフォルト青ピン
- 医療機関: 同じLeafletデフォルトPNG + CSSフィルター `hue-rotate(130deg) saturate(1.3)` で赤ピン化
- 同一PNG画像を使うことで形状・サイズが完全一致し、色だけが異なる

## フィルター設計原則

詳細は [設計思想ドキュメント（DESIGN.md）](docs/DESIGN.html) §2「フィルター設計原則」を参照。

要点:
- **デフォルト除外**: 3軸（情報の出所・代替の有無・除外の害）で評価。医療機関の常時在庫フィルター=除外OK、「現在営業中」フィルター=実装しない
- **ユーザー起動型**: 一次情報であること＋絞り込み率が意味のある水準であること。個室フィルター=実装済み（`&room=1`）、衝立フィルター=実装しない（79%が該当、機能しない）

## セットアップ

クローン後に一度だけ実行:

```sh
git config core.hooksPath scripts/hooks
```

これで `scripts/hooks/pre-commit`（docs/ 変更時に SESSION.md 更新を促すフック）が有効になる。

## 開発ルール

- AGENTS.md のガイドラインに従うこと（免責表示の維持、公式ソースURL表示、個人データ混入禁止）
- `docs/` 配下が本番。変更はここに反映する
- 厚労省サーバーへの頻繁なアクセスは避ける

## 実装済み機能（docs/FEATURE_SPEC.md 参照）

4機能すべて実装・プッシュ済み:

1. **機能4**: Google Mapリンク — 各薬局カードに「📍 Google Mapで見る」リンク（コミット d83b795）
2. **機能1**: 地図表示 — Leaflet.js + OpenStreetMap + markercluster。東大CSISでジオコーディング（コミット 514ad56, 3c3c685）
3. **機能2**: 近い順ソート — Geolocation API + Haversine距離計算（コミット 3c3c685）
4. **機能3**: 営業時間表示 — 曜日別パーサー（97.1%カバー率）+ 今日ハイライト + 折りたたみ全曜日表示（コミット 3c3c685〜04853e7）

### ジオコーディング運用

- GitHub Actions で日次自動実行（データ更新後に `geocode.py --limit 500`）
- 東大CSISダウン時は `continue-on-error` でスキップ、翌日自動リトライ（キャッシュにないIDのみ処理する設計）
- 手動実行も可能: `python3 scripts/geocode.py`（差分更新）/ `--force`（全件再取得）
- 0.5秒間隔。初回 ~85分、以降は数秒〜数分
- キャッシュ: `data/geocode_cache.json` → `docs/geocode_cache.json` にコピー

## SESSION.md / push 前チェック

`~/Claude/CONVENTIONS.md` §3 に従う（SESSION.md 更新・棚卸し・4軸レビュー）。

## 年次タスク: 祝日法改正チェック

**毎年1月以降、このプロジェクトで最初に作業する際に実施すること。**

`docs/app.js` の `getJapaneseHolidays()` が現行の「国民の祝日に関する法律」と一致しているか確認する。

### チェック手順

1. Web検索で「国民の祝日に関する法律 改正」「祝日 追加 変更」等を検索し、前年に法改正があったか確認
2. 特に以下を確認:
   - 新しい祝日の追加
   - 既存祝日の日付変更
   - ハッピーマンデー対象の変更
   - 天皇誕生日の変更（退位・即位時）
   - オリンピック等の特例による一時的な祝日移動
3. `docs/app.js` の `getJapaneseHolidays()` を読み、現行法と照合
4. 春分・秋分の天文公式（~2099年有効）が引き続き正確か確認

### 現在のコードの前提

- 天皇誕生日: 2月23日（2020年〜）
- ハッピーマンデー: 成人の日(1月第2月曜)、海の日(7月第3月曜)、敬老の日(9月第3月曜)、スポーツの日(10月第2月曜)
- 春分: `Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))`
- 秋分: `Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))`
- 振替休日・国民の休日: 自動計算

### チェック結果の記録

チェック完了後、以下の行の日付を更新すること:

**最終チェック: 2026年3月（変更なし）**
