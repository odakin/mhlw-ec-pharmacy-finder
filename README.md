# 緊急避妊薬（要指導医薬品）販売可能な薬局等：検索しやすい形にしたもの（非公式）

このリポジトリは、厚生労働省が公表している「要指導医薬品である緊急避妊薬の販売が可能な薬局等の一覧」を、
検索しやすい **CSV / XLSX / JSON** に整形し、さらに **静的Web検索（GitHub Pages）** と **LINE Botサンプル** を添えたものです。

- 出典（公式ページ）: https://www.mhlw.go.jp/stf/kinnkyuuhininnyaku_00005.html
- 最新取り込みデータ時点: 2026-01-27
- 生成物:
  - `data/` : 整形済みデータ（CSV/XLSX/JSON、原本XLSXも保存）
  - `docs/` : 静的Web検索（GitHub Pages用）
  - `line_bot/` : LINE Bot（Node.js最小サンプル）
  - `scripts/update_data.py` : 公式ページから最新データを取り込み直す更新スクリプト

---

## 重要な注意（必ずお読みください）

- このリポジトリは医療アドバイスを提供しません。
- 実際の購入可否・在庫・営業時間・販売条件は、**必ず各薬局等に確認**してください。
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

- `data/mhlw_ec_pharmacies_cleaned_2026-01-27.xlsx`
- `data/mhlw_ec_pharmacies_cleaned_2026-01-27.csv`（UTF-8 BOM）
- `data/data_2026-01-27.json`（Web/LINE Bot用）

追加した列（例）:
- `市区町村_推定`：住所文字列から市区町村相当を推定（完璧ではありません）
- `電話番号_数字`：ハイフン等を除去して通話リンクに使いやすくしたもの

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
```

更新が入ると、次が作られます:
- `data/` に日付付きの CSV/XLSX/JSON
- `docs/data.json` と `line_bot/data.json` が最新に差し替え

---

## ライセンス
- コード: MIT License
- データ: 出典（厚労省）に従ってください（本リポジトリは原データの権利を主張しません）。
