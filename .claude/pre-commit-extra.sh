#!/bin/bash
# pre-commit-extra.sh — mhlw-ec-pharmacy-finder 固有の commit 規律
#
# claude-config の public-precommit-runner.sh が leak gate (Tier A/B)
# を pass した後に chain される。詳細は claude-config/DESIGN.md
# §2026-04-28 追補: pre-commit extension hook を参照。
#
# 規律:
#   1. docs/ が staged なら SESSION.md も含めるよう警告 (block ではなく
#      block: 同期忘れの再発防止)
#   2. 追加行に placeholder ((次コミット) / (next commit) / (TBD) /
#      (TODO: commit)) が残っていれば block

set -uo pipefail

DOCS_CHANGED=$(git diff --cached --name-only -- docs/ 2>/dev/null | head -1)
SESSION_CHANGED=$(git diff --cached --name-only -- SESSION.md 2>/dev/null | head -1)

if [ -n "$DOCS_CHANGED" ] && [ -z "$SESSION_CHANGED" ]; then
  cat >&2 << 'EOF'

⚠️  docs/ が変更されていますが SESSION.md が含まれていません。
   SESSION.md の更新を忘れていませんか?

   このまま続けるには: git commit --no-verify

EOF
  exit 1
fi

# 自分自身は pattern 文字列を grep 対象として抱えているので pathspec で
# exclude (self-block 回避)。エディット時に削らないこと。
PLACEHOLDER_HITS=$(
  git diff --cached --no-color -- ':(exclude).claude/pre-commit-extra.sh' 2>/dev/null \
    | grep '^+' | grep -v '^+++' \
    | grep -F -e '(次コミット)' -e '(next commit)' -e '(TBD)' -e '(TODO: commit)' \
    | head -5
)

if [ -n "$PLACEHOLDER_HITS" ]; then
  cat >&2 << 'EOF'

⚠️  プレースホルダーが残っています:
EOF
  printf '%s\n' "$PLACEHOLDER_HITS" >&2
  cat >&2 << 'EOF'

   コミットハッシュに置き換えてからコミットしてください。
   (どうしてもこのまま commit したい場合: git commit --no-verify)

EOF
  exit 1
fi

exit 0
