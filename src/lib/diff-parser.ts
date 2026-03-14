export type DiffLineType = "add" | "delete" | "context" | "header";

export type DiffToken = {
  content: string;
  color?: string;
};

export type DiffLine = {
  type: DiffLineType;
  content: string;
  tokens?: DiffToken[];
  oldLineNumber: number | null;
  newLineNumber: number | null;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
};

export type DiffFile = {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  generated?: boolean;
};

export type ParsedDiff = DiffFile[];

// Supports a/, b/ (default) and c/, w/, i/ (diff.mnemonicPrefix)
const DIFF_HEADER_RE = /^diff --git [a-z]\/(.+) [a-z]\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseDiff(raw: string): ParsedDiff {
  const lines = raw.split("\n");
  const files: DiffFile[] = [];
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    const diffMatch = DIFF_HEADER_RE.exec(line);
    if (diffMatch) {
      currentFile = {
        oldPath: diffMatch[1] ?? "",
        newPath: diffMatch[2] ?? "",
        hunks: [],
        isNew: false,
        isDeleted: false,
        isRenamed: false,
      };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith("new file mode")) {
      currentFile.isNew = true;
      continue;
    }

    if (line.startsWith("deleted file mode")) {
      currentFile.isDeleted = true;
      continue;
    }

    if (line.startsWith("rename from") || line.startsWith("rename to")) {
      currentFile.isRenamed = true;
      continue;
    }

    // Skip index, ---, +++ lines
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1] ?? "0", 10);
      newLine = parseInt(hunkMatch[3] ?? "0", 10);
      currentHunk = {
        header: line,
        oldStart: oldLine,
        oldCount: parseInt(hunkMatch[2] ?? "1", 10),
        newStart: newLine,
        newCount: parseInt(hunkMatch[4] ?? "1", 10),
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "add",
        content: line.slice(1),
        oldLineNumber: null,
        newLineNumber: newLine++,
      });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "delete",
        content: line.slice(1),
        oldLineNumber: oldLine++,
        newLineNumber: null,
      });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({
        type: "context",
        content: line.slice(1),
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
      });
    } else if (line === "\\ No newline at end of file") {
      // skip
    }
  }

  return files;
}
