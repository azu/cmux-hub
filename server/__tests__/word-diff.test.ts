import { describe, expect, test } from "bun:test";
import { addWordDiffRanges, diffWords } from "../word-diff.ts";
import type { DiffFile, DiffLine } from "../../src/lib/diff-parser.ts";

function line(type: DiffLine["type"], content: string): DiffLine {
  return { type, content, oldLineNumber: null, newLineNumber: null };
}

function fileWith(lines: DiffLine[]): DiffFile {
  return {
    oldPath: "a.ts",
    newPath: "a.ts",
    isNew: false,
    isDeleted: false,
    isRenamed: false,
    hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines }],
  };
}

describe("diffWords", () => {
  test("highlights only the changed word", () => {
    const result = diffWords('const greeting = "hello";', 'const greeting = "world";');
    expect(result).not.toBeNull();
    expect(result!.oldRanges).toEqual([[18, 23]]);
    expect(result!.newRanges).toEqual([[18, 23]]);
  });

  test("merges adjacent changed tokens into one range", () => {
    const result = diffWords("value = a + b", "value = a * c + d");
    expect(result).not.toBeNull();
    // Every range boundary maps back to actually-changed text
    for (const [s, e] of result!.newRanges) {
      expect(e).toBeGreaterThan(s);
    }
  });

  test("identical lines produce empty ranges", () => {
    const result = diffWords("same", "same");
    expect(result).toEqual({ oldRanges: [], newRanges: [] });
  });

  test("fully rewritten line is skipped (no noisy emphasis)", () => {
    const result = diffWords("aaa bbb ccc", "xxx yyy zzz");
    expect(result).toBeNull();
  });

  test("change at line start and end", () => {
    const result = diffWords("foo middle bar", "baz middle qux");
    expect(result).not.toBeNull();
    expect(result!.oldRanges).toEqual([
      [0, 3],
      [11, 14],
    ]);
    expect(result!.newRanges).toEqual([
      [0, 3],
      [11, 14],
    ]);
  });
});

describe("addWordDiffRanges", () => {
  test("pairs delete/add runs positionally", () => {
    const del1 = line("delete", "const a = 1;");
    const del2 = line("delete", "const b = 2;");
    const add1 = line("add", "const a = 10;");
    const add2 = line("add", "const b = 20;");
    const file = fileWith([line("context", "x"), del1, del2, add1, add2]);

    addWordDiffRanges([file]);

    expect(del1.wordRanges).toEqual([[10, 11]]);
    expect(add1.wordRanges).toEqual([[10, 12]]);
    expect(del2.wordRanges).toEqual([[10, 11]]);
    expect(add2.wordRanges).toEqual([[10, 12]]);
  });

  test("unpaired lines get no ranges", () => {
    const del = line("delete", "const a = 1;");
    const add1 = line("add", "const a = 2;");
    const add2 = line("add", "const extra = true;");
    const file = fileWith([del, add1, add2]);

    addWordDiffRanges([file]);

    expect(del.wordRanges).toEqual([[10, 11]]);
    expect(add1.wordRanges).toEqual([[10, 11]]);
    expect(add2.wordRanges).toBeUndefined();
  });

  test("delete-only runs get no ranges", () => {
    const del = line("delete", "gone");
    const file = fileWith([del, line("context", "keep")]);
    addWordDiffRanges([file]);
    expect(del.wordRanges).toBeUndefined();
  });
});
