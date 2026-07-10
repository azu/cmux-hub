/**
 * Word-level (intra-line) diff, GitHub style.
 *
 * Within each hunk, consecutive delete lines followed by consecutive add
 * lines are paired positionally (1st delete ↔ 1st add, ...). For each pair,
 * the lines are tokenized into words / whitespace / punctuation and an LCS
 * over tokens determines which character ranges changed. The ranges are
 * attached to the lines as `wordRanges` so the UI can paint the exact
 * changed words with a stronger background than the line tint.
 */
import type { DiffFile, DiffLine } from "../src/lib/diff-parser.ts";

// Skip emphasis when lines are too long or too different — GitHub does the
// same: a fully-rewritten line gets no word emphasis, just the line tint.
const MAX_TOKENS = 400;
const MAX_CHANGED_RATIO = 0.85;

type Token = { text: string; start: number };

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push({ text: m[0], start: m.index });
  }
  return tokens;
}

/**
 * Longest common subsequence over tokens. Returns per-side boolean arrays
 * where true = token is part of the LCS (unchanged).
 */
function lcsKeep(a: Token[], b: Token[]): { keepA: boolean[]; keepB: boolean[] } {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i]!.text;
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        ai === b[j]!.text ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const keepA = Array.from({ length: n }, () => false);
  const keepB = Array.from({ length: m }, () => false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i]!.text === b[j]!.text) {
      keepA[i] = true;
      keepB[j] = true;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return { keepA, keepB };
}

/** Convert changed tokens into merged character ranges [start, end). */
function changedRanges(tokens: Token[], keep: boolean[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (keep[i]) continue;
    const t = tokens[i]!;
    const end = t.start + t.text.length;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === t.start) {
      last[1] = end;
    } else {
      ranges.push([t.start, end]);
    }
  }
  return ranges;
}

function nonWhitespaceLength(s: string): number {
  return s.replace(/\s/g, "").length;
}

/** Changed-character count, ignoring whitespace (spaces survive most rewrites) */
function changedLength(line: string, ranges: Array<[number, number]>): number {
  return ranges.reduce((sum, [s, e]) => sum + nonWhitespaceLength(line.slice(s, e)), 0);
}

/**
 * Compute word ranges for one delete/add line pair.
 * Returns null when the pair is too different for emphasis to be useful.
 */
export function diffWords(
  oldLine: string,
  newLine: string,
): { oldRanges: Array<[number, number]>; newRanges: Array<[number, number]> } | null {
  if (oldLine === newLine) return { oldRanges: [], newRanges: [] };
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
  const { keepA, keepB } = lcsKeep(a, b);
  const oldRanges = changedRanges(a, keepA);
  const newRanges = changedRanges(b, keepB);
  // Whole-line rewrites: emphasis over ~everything is noise, skip it
  const oldTotal = nonWhitespaceLength(oldLine);
  const newTotal = nonWhitespaceLength(newLine);
  const oldRatio = oldTotal > 0 ? changedLength(oldLine, oldRanges) / oldTotal : 0;
  const newRatio = newTotal > 0 ? changedLength(newLine, newRanges) / newTotal : 0;
  if (oldRatio > MAX_CHANGED_RATIO && newRatio > MAX_CHANGED_RATIO) return null;
  return { oldRanges, newRanges };
}

/**
 * Annotate parsed diff files in place with word-level ranges.
 * Pairs runs of deletes with the following run of adds inside each hunk.
 */
export function addWordDiffRanges(files: DiffFile[]): DiffFile[] {
  for (const file of files) {
    for (const hunk of file.hunks) {
      const lines = hunk.lines;
      let i = 0;
      while (i < lines.length) {
        if (lines[i]!.type !== "delete") {
          i++;
          continue;
        }
        const deletes: DiffLine[] = [];
        while (i < lines.length && lines[i]!.type === "delete") {
          deletes.push(lines[i]!);
          i++;
        }
        const adds: DiffLine[] = [];
        let j = i;
        while (j < lines.length && lines[j]!.type === "add") {
          adds.push(lines[j]!);
          j++;
        }
        const pairs = Math.min(deletes.length, adds.length);
        for (let k = 0; k < pairs; k++) {
          const del = deletes[k]!;
          const add = adds[k]!;
          const result = diffWords(del.content, add.content);
          if (result && (result.oldRanges.length > 0 || result.newRanges.length > 0)) {
            del.wordRanges = result.oldRanges;
            add.wordRanges = result.newRanges;
          }
        }
        i = j;
      }
    }
  }
  return files;
}
