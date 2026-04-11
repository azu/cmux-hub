---
description: |
  Write a plan, design doc, or any markdown document to cmux-hub's Review
  directory so the user can review it in the browser before you start
  implementing. プラン・設計書・リファクタ案などのマークダウンを cmux-hub
  のレビュー用ディレクトリに書き出し、コードを書き始める前にユーザーがブラ
  ウザ上でレビューできるようにします。Trigger when the user says
  "レビューして", "cmuxでレビュー", "プランをレビュー", "計画をチェック",
  "review this plan", "check this design", or otherwise asks for human
  review of a document you generated. Also use this skill proactively
  when you want the user to sanity-check a plan before making code
  changes (変更を加える前にプランの確認を取りたいとき).
---

# Plan Review via cmux-hub

Use this skill whenever the user asks to review a plan, design doc, or
any markdown document before you commit changes. Files placed in the
cmux-hub review directory are immediately visible in the **Review** tab
of the cmux-hub browser view, and the user can leave inline comments
there which you can read back in subsequent turns.

## When to use

- "レビューして" / "cmuxでレビュー" / "プランをレビュー" / "review this plan"
- Before making non-trivial code changes, proactively write a plan and
  ask for review.
- When you've produced a design document, migration plan, or refactor
  outline that the user should sign off on.

## Step 1 — Resolve the review directory

cmux-hub derives its review directory from the cmux workspace (or
surface) the Claude session is running in. Mirror that derivation so
your file lands in the directory cmux-hub is watching:

```bash
# Default: bind to the cmux workspace (tab). One workspace = one review
# bucket; panes/surfaces inside that workspace share the same bucket.
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

Give the file a descriptive name so multiple review documents in the
same workspace stay organized:

```bash
cat > "$REVIEW_DIR/plan.md" <<'EOF'
# Plan: <short title>

## Goal
...

## Steps
1. ...
2. ...

## Risks / Open questions
- ...
EOF
```

Use `plan.md` for the main proposal. If you want to split concerns
(e.g., a separate migration doc), use a topical filename like
`migration.md` or `refactor-auth.md`. Do not use subdirectories unless
you have a good reason — cmux-hub displays files flat, newest first.

## Step 3 — Point the user at the Review tab

After writing the file, tell the user that the plan is ready in
cmux-hub's Review tab and wait for feedback. A short message is enough:

> Plan を `$REVIEW_DIR/plan.md` に書き出しました。cmux-hub の **Review** タブで確認してコメントしてください。

## Step 4 — Read back the user's edits or comments

After the user says they've reviewed the plan, re-read the same file
to pick up any edits they made inline:

```bash
cat "$REVIEW_DIR/plan.md"
```

If the user asks you to iterate on the plan, overwrite the same file
and tell them to refresh the Review tab (it auto-updates via
WebSocket, so usually no manual refresh is needed).

## Cleanup

cmux-hub removes the auto-created review directory when the session
ends (SIGHUP/SIGINT/SIGTERM), so you don't need to clean up manually.
Files are ephemeral by design — if something is worth keeping, commit
it to the repo.
