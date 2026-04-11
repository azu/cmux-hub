---
description: |
  Write any markdown document (plan, design doc, research notes,
  refactor proposal, migration checklist, investigation report, etc.)
  to cmux-hub's review directory so the user can read it in the
  browser and leave inline comments before you start — or continue —
  implementing. プラン・設計書・調査メモ・リファクタ案・マイグレー
  ション手順・バグ調査のまとめなど、AI が生成した **どんなマークダウン
  でも** cmux-hub のレビュー用ディレクトリに書き出して、ブラウザでユ
  ーザにレビューしてもらうための skill です。Trigger when the user
  says "レビューして", "cmuxでレビュー", "確認して", "これチェック",
  "プラン/設計/計画を見て", "review this", "check this design", or
  otherwise asks for human review of a document you generated. Also
  use proactively when you want the user to sanity-check a write-up
  before taking action (変更を加える前に確認を取りたいとき、調査結果を
  共有したいとき、設計の妥当性を相談したいとき など).
---

# cmux-hub Review

Use this skill whenever you want the user to read and comment on a
markdown document you just wrote. Files placed in the cmux-hub review
directory are immediately visible in the **Review** tab of the
cmux-hub browser view, and the user can leave inline comments there
which you can read back in subsequent turns.

## What to put in here

Anything written in markdown that benefits from human review. Examples:

- **Plans** — "ここから何をやるか" の手順書。実装前の確認用
- **Design docs** — アーキテクチャ案、モジュール分割、データモデル
- **Refactor proposals** — 何をどう変えるか、影響範囲、リスク
- **Research / investigation notes** — バグ調査、パフォーマンス分析、
  既存コード読解のまとめ
- **Migration checklists** — DB スキーマ変更、API 変更、依存アップデート
- **Impact analysis** — ある変更が他の箇所にどう波及するか
- **PR description drafts** — PR を作る前の文面確認
- **API design proposals** — エンドポイント定義、型シグネチャ

Plan is just one shape of document — use this skill for anything where
"ユーザに一度読んでもらってからコードに手を付けたい" と感じるものすべて。

## Step 1 — Resolve the review directory

cmux-hub derives its review directory from the cmux workspace (or
surface) the Claude session is running in. Mirror that derivation so
your file lands in the directory cmux-hub is watching:

```bash
# Default: bind to the cmux workspace (tab). One workspace = one
# review bucket; panes/surfaces inside the same workspace share it.
review_dir_for_cmux() {
  local root="${TMPDIR:-/tmp}/cmux-hub-review"
  local id_safe
  if [ -n "${CMUX_WORKSPACE_ID:-}" ]; then
    id_safe=$(printf '%s' "$CMUX_WORKSPACE_ID" | tr -c 'A-Za-z0-9._-' '_')
    printf '%s/workspace-%s\n' "$root" "$id_safe"
  elif [ -n "${CMUX_SURFACE_ID:-}" ]; then
    id_safe=$(printf '%s' "$CMUX_SURFACE_ID" | tr -c 'A-Za-z0-9._-' '_')
    printf '%s/surface-%s\n' "$root" "$id_safe"
  else
    printf '%s/pid-%d\n' "$root" "$$"
  fi
}

REVIEW_DIR=$(review_dir_for_cmux)
mkdir -p "$REVIEW_DIR"
```

If `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID` are both unset, cmux is
probably not running and this skill won't help — fall back to asking
the user how they want to review the document.

## Step 2 — Write the markdown document

Give the file a **descriptive, topical filename** that reflects what
kind of document it is, so multiple review files in the same workspace
stay organized. Examples:

```bash
# Plans / implementation proposals
cat > "$REVIEW_DIR/plan-add-auth.md" <<'EOF'
# Plan: add OAuth authentication
## Goal
...
EOF

# Design docs
cat > "$REVIEW_DIR/design-event-bus.md" <<'EOF'
# Design: internal event bus
## Context
...
EOF

# Investigation / research
cat > "$REVIEW_DIR/investigation-flaky-test.md" <<'EOF'
# Investigation: flaky integration test
## Findings
...
EOF

# Refactor proposals
cat > "$REVIEW_DIR/refactor-api-layer.md" <<'EOF'
# Refactor: consolidate API layer
## Motivation
...
EOF
```

Suggested naming conventions:

- `plan-<topic>.md` — implementation plans
- `design-<topic>.md` — design docs
- `investigation-<topic>.md` — bug / perf investigation
- `refactor-<topic>.md` — refactor proposals
- `migration-<topic>.md` — migration / upgrade checklists
- `analysis-<topic>.md` — impact / dependency analysis

Do not use subdirectories unless you have a good reason — cmux-hub
displays files flat, newest first.

## Step 3 — Point the user at the Review tab

After writing the file, tell the user that the document is ready in
cmux-hub's Review tab and wait for feedback. Keep the message short:

> `$REVIEW_DIR/plan-add-auth.md` に書き出しました。cmux-hub の
> **Review** タブで確認してコメントしてください。

Mention **which document** you wrote if there could be multiple open
at once, so the user knows what to look at.

## Step 4 — Read back the user's edits or comments

After the user says they've reviewed the document, re-read the same
file to pick up any edits they made inline:

```bash
cat "$REVIEW_DIR/plan-add-auth.md"
```

If the user asks you to iterate, overwrite the same file and tell
them to refresh the Review tab (it auto-updates via WebSocket, so
usually no manual refresh is needed).

When a review document has served its purpose (approved, obsolete,
or rewritten into a different document), suggest the user deletes it
via the Delete button in the Review tab — or leave it and cmux-hub
will clean up the auto-created directory when the session ends.

## Cleanup

cmux-hub removes the auto-created review directory when the session
ends (SIGHUP / SIGINT / SIGTERM), so you don't need to clean up
manually. Files are ephemeral by design — if something is worth
keeping long-term, commit it to the repo as a real doc.
