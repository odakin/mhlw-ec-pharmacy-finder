# AGENTS.md

## Purpose
This repository turns the MHLW (厚生労働省) published list of pharmacies that can sell emergency contraception (緊急避妊薬 / 要指導医薬品) into formats that are easier to search and reuse:
- cleaned CSV/XLSX/JSON
- a simple static search UI (GitHub Pages)
- a minimal LINE bot sample
- an update script + scheduled GitHub Action

## Review guidelines
- Do not remove the disclaimer section from README / UI.
- Always keep the **official source URL** visible:
  https://www.mhlw.go.jp/stf/kinnkyuuhininnyaku_00005.html
- Avoid adding any non-public / personal data.
- If changing parsing, verify the record count and spot-check a few rows.

## Update guidelines
- Be polite to the source server: avoid frequent polling.
- Only regenerate files when the "as of" date changes, or when the source XLSX URL changes.
- Keep `docs/data.json` and `line_bot/data.json` in sync with the latest generated JSON.
