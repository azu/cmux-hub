---
description: Write a markdown document (plan, design, investigation, refactor, etc.) to cmux-hub's Review tab so the user can read and comment on it in the browser. Use the cmux-hub-review skill for the actual writing — it handles directory resolution and filename conventions.
---

Use the `cmux-hub-review` skill to write a markdown document for the
user to review in the cmux-hub **Review** tab.

Topic / scope from the user: `$ARGUMENTS`

Instructions:

1. If `$ARGUMENTS` is empty, pick up the **current conversation topic**
   — the thing the user just asked about or the change you were about
   to start implementing — and write a review document for that.
2. If `$ARGUMENTS` is provided, treat it as the topic / scope. Decide
   the right document shape based on what is asked:
   - "plan …" / "プラン …" → implementation plan (`plan-<topic>.md`)
   - "design …" / "設計 …" → design doc (`design-<topic>.md`)
   - "investigate …" / "調査 …" → investigation notes
     (`investigation-<topic>.md`)
   - "refactor …" / "リファクタ …" → refactor proposal
     (`refactor-<topic>.md`)
   - otherwise → pick the closest shape from the list above, or use
     a descriptive generic filename.
3. Follow the `cmux-hub-review` skill:
   - Resolve `REVIEW_DIR` from `CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID`
     (see the skill's Step 1 snippet).
   - Write the document with a descriptive, topical filename.
   - Tell the user which file you wrote and ask them to check the
     cmux-hub **Review** tab.
4. Wait for the user's feedback before making any code changes.
5. After the user reviews, re-read the same file to pick up any
   inline edits and iterate.

Do **not** start implementing code changes until the user has
explicitly approved the document in the Review tab.
