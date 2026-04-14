# DESIGN — mhlw-ec-pharmacy-finder

設計判断とその理由を記録する。CLAUDE.md には「何をするか」、ここには「なぜそうするか」。

---

## 現在の状態

このファイルは 2026-04-14 に claude-config 規約 (CLAUDE / SESSION / DESIGN の三層) に沿って初期整備された。**本リポは CLAUDE.md が大きく (>= 100 行)、暗黙の設計判断 (なぜそう構成したか・なぜその技術を選んだか) が CLAUDE.md / README.md / docs/ に混在している可能性が高い**。今後のセッションで判断を本ファイルに抽出していく。

抽出時の形式:

```
## <判断のタイトル>

**判断:** 何を決めたか (1-2 文)。

### 理由
なぜそう決めたか。

### 代替案と棄却理由
| 案 | 棄却理由 |
|---|---|

### 関連
関連 commit / CLAUDE.md セクション / 過去の事故等への pointer。
```

参考フォーマット: `~/Claude/claude-config/DESIGN.md`, `~/Claude/lectures/DESIGN.md`, `~/Claude/twcu-seminar/DESIGN.md`。

---

## 抽出候補 (TODO)

CLAUDE.md / README.md / docs/ から将来抽出すべき設計判断の候補 (発見次第本セクションを埋める or 上の本体セクションへ昇格):

- (未確認 - 本リポの CLAUDE.md / docs/ を読み返したときに発見した「なぜ」を一旦ここにメモして溜め、まとまったら上位セクションへ昇格)
