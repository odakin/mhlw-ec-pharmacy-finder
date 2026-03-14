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
line_bot/                → LINE Bot サンプル
AGENTS.md                → コードレビューガイドライン
FEATURE_SPEC.md          → 機能仕様書（4機能の要件・技術方針）
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

## 開発ルール

- AGENTS.md のガイドラインに従うこと（免責表示の維持、公式ソースURL表示、個人データ混入禁止）
- `docs/` 配下が本番。変更はここに反映する
- 厚労省サーバーへの頻繁なアクセスは避ける

## 実装済み機能（FEATURE_SPEC.md 参照）

4機能すべて実装・プッシュ済み:

1. **機能4**: Google Mapリンク — 各薬局カードに「📍 Google Mapで見る」リンク（コミット d83b795）
2. **機能1**: 地図表示 — Leaflet.js + OpenStreetMap + markercluster。東大CSISでジオコーディング（コミット 514ad56, 3c3c685）
3. **機能2**: 近い順ソート — Geolocation API + Haversine距離計算（コミット 3c3c685）
4. **機能3**: 営業時間表示 — 曜日別パーサー（89.4%カバー率）+ 今日ハイライト + 折りたたみ全曜日表示（コミット 3c3c685）

### ジオコーディング運用

- `python3 scripts/geocode.py` で差分更新（新規/住所変更分のみ）
- 0.5秒間隔。初回 ~85分、以降は数秒〜数分
- 完了後 `data/geocode_cache.json` → `docs/geocode_cache.json` にコピーしてコミット

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
