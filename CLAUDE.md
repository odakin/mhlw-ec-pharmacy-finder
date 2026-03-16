# CLAUDE.md

## プロジェクト概要

厚生労働省が公表する「緊急避妊薬（要指導医薬品）の販売が可能な薬局等の一覧」を検索しやすくした非公式ツール。GitHub Pages で静的ホスティング。

- **公開URL**: https://odakin.github.io/mhlw-ec-pharmacy-finder/
- **公式データ出典**: https://www.mhlw.go.jp/stf/kinnkyuuhininnyaku_00005.html

## リポジトリ構成

```
docs/                    → GitHub Pages 公開ディレクトリ
  index.html / app.js / style.css  → フロントエンド（バニラJS）
  data.json              → 薬局データ（10,128件）
  geocode_cache.json     → ジオコーディング結果（フロントエンド配信用コピー）
data/                    → 元データ・キャッシュ
  *.xlsx / *.csv / *.json → 厚労省データ加工済み
  geocode_cache.json     → ジオコーディング結果（マスター）
scripts/
  update_data.py         → 公式ページからデータ更新
  geocode.py             → 東大CSIS APIでジオコーディング（住所→緯度経度）
  hooks/pre-commit       → SESSION.md 更新漏れ防止フック
line_bot/                → LINE Bot サンプル
AGENTS.md                → コードレビューガイドライン
docs/FEATURE_SPEC.md     → 機能仕様書（4機能の要件・技術方針、GitHub Pages で公開）
docs/HOURS_PARSER.md     → 営業時間パーサー設計ドキュメント（GitHub Pages で公開）
```

## データ構造（docs/data.json）

```json
{
  "meta": { "asOf": "2026-03-10", "records": 10128, ... },
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

## SESSION.md ルール（全プロジェクト共通）

各プロジェクトフォルダに `SESSION.md` を置き、autocompact 後の復帰に使う。

### 必須: 進行ごとに SESSION.md を更新すること

- コードを変更したとき
- 新しいファイルを作成・削除したとき
- 作業方針が決まったとき
- ユーザーと何かを確認・決定したとき
- 作業の区切り（コミット前など）

### 更新時の整合性チェック（必須）

SESSION.md を更新するたびに、以下を確認すること：

1. **直前の議論との矛盾がないか** — 会話で訂正・修正した内容が SESSION.md に正しく反映されているか
2. **コードと記述の一致** — スクリプトの出力や検証結果と、SESSION.md の記述が食い違っていないか
3. **ファイル構成の正確性** — 実際のファイル一覧と SESSION.md のコードベース構成が合っているか
4. **古い情報の残留** — 訂正済みの結論が「以前の誤った記述」のまま残っていないか

矛盾を見つけたら、更新前に修正すること。SESSION.md は autocompact 後の唯一の復帰情報なので、不正確な記述は致命的。

### SESSION.md に書くこと

- リポジトリ情報（リモート、ブランチ等）
- プロジェクト概要（何をやっているか）
- コードベース構成（主要ファイルと役割）
- 実行方法（ビルド・テスト・実行コマンド）
- 現在の作業状況（チェックリスト形式）
- ユーザーとの決定事項

### autocompact 後の復帰手順

1. まず対象プロジェクトの `SESSION.md` を読む
2. 必要に応じて関連ファイルを確認
3. ユーザーに「ここまでの理解」を簡潔に伝えてから再開

### 新規プロジェクト作成時

プロジェクトフォルダを作ったら、最初の作業前に `SESSION.md` を作成すること。

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
