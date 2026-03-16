# 緊急避妊薬（要指導医薬品）販売可能な薬局検索

> **English version below** / [Jump to English](#english)


このリポジトリは、厚生労働省が公表している緊急避妊薬（要指導医薬品）の販売が可能な薬局の一覧を、
検索しやすい **CSV / XLSX / JSON** に整形し、さらに **静的Web検索（GitHub Pages）** と **LINE Botサンプル** を添えたものです。

- 出典（公式ページ）: https://www.mhlw.go.jp/stf/kinnkyuuhininnyaku_00005.html
- 最新取り込みデータ時点: 2026-03-10
- 生成物:
  - `data/` : 整形済みデータ（CSV/XLSX/JSON、原本XLSX、ジオコーディングキャッシュ）
  - `docs/` : 静的Web検索（GitHub Pages用、地図・営業時間表示対応）
  - `line_bot/` : LINE Bot（Node.js最小サンプル）
  - `scripts/update_data.py` : 公式ページから最新データを取り込み直す更新スクリプト
  - `scripts/geocode.py` : 住所→緯度経度変換（東大CSIS API）

---

## 重要な注意（必ずお読みください）

- このリポジトリは医療アドバイスを提供しません。
- 実際の購入可否・在庫・営業時間・販売条件は、**各薬局に確認**してください。
- 公式ページでも、市販化直後は在庫等が変動しうるため **来局前に電話確認が推奨**されています。  
  最終的な根拠は、上記の公式ページを最優先にしてください。

---

## 1) Web検索（GitHub Pages）

`docs/` 配下は静的ファイルだけで動作します。

### 公開
1. GitHub の Settings → Pages
2. Source を「Deploy from a branch」
3. Branch を `main` / Folder を `/docs` にして保存

公開後のURLは通常 `https://<ユーザー名>.github.io/<リポジトリ名>/` になります。
例：リポジトリ名を `mhlw-ec-pharmacy-finder` にした場合 → `https://odakin.github.io/mhlw-ec-pharmacy-finder/`

### ローカルで試す
```bash
cd docs
python -m http.server 8000
# http://localhost:8000 を開く
```

---

## 2) 整形済みデータ

- `data/mhlw_ec_pharmacies_cleaned_2026-03-10.xlsx`
- `data/mhlw_ec_pharmacies_cleaned_2026-03-10.csv`（UTF-8 BOM）
- `data/data_2026-03-10.json`（Web/LINE Bot用）

追加した列（例）:
- `市区町村_推定`：住所文字列から市区町村相当を推定（完璧ではありません）
- `電話番号_数字`：ハイフン等を除去して通話リンクに使いやすくしたもの
- `時間外の電話番号_数字`：時間外の電話番号を同様に数字化したもの
- `販売可能薬剤師数_女性` / `販売可能薬剤師数_男性` / `販売可能薬剤師数_答えたくない`：公式一覧の「販売可能薬剤師・性別（人数）」

Web UI の絞り込み:
- 事前連絡「要」を除く
- 時間外対応あり
- 女性薬剤師がいる

Web UI の機能:
- **地図表示**: Leaflet.js + OpenStreetMap で検索結果をピン表示（マーカークラスタリング対応）
- **近い順ソート**: ブラウザの位置情報から現在地を取得し、距離順にソート
- **営業時間表示**: 今日の営業状況（営業中/営業時間外/休み）をハイライト + 全曜日スケジュール折りたたみ表示
- **Google Mapリンク**: 各薬局カードから Google Map へ直接遷移（写真・口コミ・ナビ）

---

## 3) LINE Bot（Node.jsサンプル）

`line_bot/` に最小構成のサンプルがあります。

### 準備
- LINE Developers で Messaging API チャネル作成
- 環境変数
  - `LINE_CHANNEL_ACCESS_TOKEN`
  - `LINE_CHANNEL_SECRET`

### 実行
```bash
cd line_bot
npm install
npm start
```

---

## 4) 更新（公式ページから再生成）

```bash
pip install -r scripts/requirements.txt
python scripts/update_data.py

# 参考：ローカルに保存した XLSX から再生成する場合
# python scripts/update_data.py --xlsx path/to/source.xlsx --as-of YYYY-MM-DD
```

更新が入ると、次が作られます:
- `data/` に日付付きの CSV/XLSX/JSON
- `docs/data.json` と `line_bot/data.json` が最新に差し替え

### ジオコーディング（地図機能用）

GitHub Actions でデータ更新後に自動実行されます（`geocode.py --limit 500`）。
東大CSISがダウンしていても翌日自動リトライされます（キャッシュにないIDのみ処理する設計）。

手動実行も可能:

```bash
python3 scripts/geocode.py            # 未取得分のみ処理
python3 scripts/geocode.py --limit 100  # 最大100件
python3 scripts/geocode.py --force      # 全件再取得
```

- 東大CSIS Simple Geocoding API（無料・APIキー不要・番地レベル精度）を使用
- キャッシュ: `data/geocode_cache.json`（append-only、削除された薬局のデータも保持）
- 0.5秒間隔。初回約85分、以降の更新は新規分のみ数秒〜数分

---

## 5) 技術ドキュメント

実装の設計判断や技術的背景を記録したドキュメントです。同種のプロジェクトを作る方や、コードを読む方の参考にどうぞ。

- **[機能仕様書](https://odakin.github.io/mhlw-ec-pharmacy-finder/FEATURE_SPEC.html)** — 4機能の要件・技術選定の理由（なぜ東大CSISか、なぜNominatimは不採用か等）
- **[営業時間パーサー設計](https://odakin.github.io/mhlw-ec-pharmacy-finder/HOURS_PARSER.html)** — 6,933種のフォーマット揺れを97.1%パースする多段正規化パイプラインの設計と、各判断の背景

---

## ライセンス
- コード: MIT License
- データ: 出典（厚労省）に従ってください（本リポジトリは原データの権利を主張しません）。

---

<a id="english"></a>

# Emergency Contraceptive Pill — Pharmacy Finder (Japan)

A search tool for pharmacies in Japan that sell emergency contraceptive pills (afterpills / morning-after pills), based on official data published by the Ministry of Health, Labour and Welfare (MHLW).

- **Live site**: https://odakin.github.io/mhlw-ec-pharmacy-finder/
- **Official data source**: https://www.mhlw.go.jp/stf/kinnkyuuhininnyaku_00005.html

## Features

- **10,000+ pharmacies** across all 47 prefectures
- **Map view** with marker clustering (Leaflet.js + OpenStreetMap)
- **Sort by nearest** using browser geolocation
- **Business hours** display with today's status highlighted
- **Filters**: female pharmacist available, after-hours support, no appointment needed
- **Google Maps link** for each pharmacy (directions, reviews, photos)
- **Daily auto-update** via GitHub Actions

## Important Notice

- This tool does not provide medical advice.
- Always confirm availability, hours, and conditions directly with the pharmacy before visiting.
- The MHLW official page is the authoritative source.

## Components

| Directory | Description |
|-----------|-------------|
| `docs/` | Static website (GitHub Pages) |
| `data/` | Cleaned CSV / XLSX / JSON data |
| `scripts/` | Data update & geocoding scripts |
| `line_bot/` | LINE Bot sample (Node.js) |

## Technical Documentation

Design documents recording the reasoning behind implementation decisions:

- **[Feature Specification](https://odakin.github.io/mhlw-ec-pharmacy-finder/FEATURE_SPEC.html)** — Requirements and technical choices for all 4 features
- **[Business Hours Parser Design](https://odakin.github.io/mhlw-ec-pharmacy-finder/HOURS_PARSER.html)** — How the multi-stage normalization pipeline parses 6,933 format variations at 97.1% coverage

## License
- Code: MIT License
- Data: Subject to MHLW terms (this repository does not claim rights over the original data).
