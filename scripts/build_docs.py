#!/usr/bin/env python3
"""
docs/*.md → docs/*.html 静的ビルドスクリプト

既存の HTML テンプレート（nav, style, JS）を維持しつつ、
<div id="content"> に Markdown から変換した HTML を埋め込む。

これにより Googlebot が JS レンダリングなしで本文を読めるようになる。
ブラウザ側の JS (fetch + marked.js) も残るため、
ローカル開発時に .md を編集すればリロードで即反映される。

使い方:
    python scripts/build_docs.py
"""
import re
import sys
from pathlib import Path

import markdown

DOCS_DIR = Path(__file__).resolve().parent.parent / "docs"

# 対象ファイル: (MDファイル名, HTMLファイル名)
TARGETS = [
    ("DESIGN.md", "DESIGN.html"),
    ("DESIGN_EN.md", "DESIGN_EN.html"),
    ("FEATURE_SPEC.md", "FEATURE_SPEC.html"),
    ("FEATURE_SPEC_EN.md", "FEATURE_SPEC_EN.html"),
    ("HOURS_PARSER.md", "HOURS_PARSER.html"),
    ("HOURS_PARSER_EN.md", "HOURS_PARSER_EN.html"),
]

# frontmatter (---\n...\n---\n) を除去
FRONTMATTER_RE = re.compile(r"^---\n.*?\n---\n", re.DOTALL)

# <div id="content">...</div> を置換（JS の fetch スクリプトより前にある）
CONTENT_RE = re.compile(
    r'(<div id="content">)(.*?)(</div>\s*<script>)',
    re.DOTALL,
)


def convert_md(md_path: Path) -> str:
    """Markdown ファイルを読み込み、frontmatter を除去して HTML に変換する。"""
    text = md_path.read_text(encoding="utf-8")
    text = FRONTMATTER_RE.sub("", text)
    html = markdown.markdown(
        text,
        extensions=["tables", "fenced_code", "toc"],
        output_format="html",
    )
    return html


def embed_content(html_path: Path, content_html: str) -> bool:
    """HTML ファイルの <div id="content"> に変換済み HTML を埋め込む。
    変更があれば True を返す。"""
    original = html_path.read_text(encoding="utf-8")

    def replacer(m):
        return f'{m.group(1)}\n{content_html}\n{m.group(3)}'

    updated = CONTENT_RE.sub(replacer, original, count=1)

    if updated == original:
        return False

    html_path.write_text(updated, encoding="utf-8")
    return True


def main():
    changed = 0
    errors = 0

    for md_name, html_name in TARGETS:
        md_path = DOCS_DIR / md_name
        html_path = DOCS_DIR / html_name

        if not md_path.exists():
            print(f"  SKIP  {md_name} (not found)")
            continue
        if not html_path.exists():
            print(f"  SKIP  {html_name} (not found)")
            continue

        try:
            content_html = convert_md(md_path)
            if embed_content(html_path, content_html):
                print(f"  OK    {html_name} (updated)")
                changed += 1
            else:
                print(f"  --    {html_name} (no change)")
        except Exception as e:
            print(f"  ERR   {html_name}: {e}", file=sys.stderr)
            errors += 1

    print(f"\nDone: {changed} updated, {len(TARGETS) - changed - errors} unchanged, {errors} errors")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
