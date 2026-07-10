import React from "react";
import type { DiffLine as DiffLineType } from "../lib/diff-parser.ts";

type Props = {
  line: DiffLineType;
  filePath: string;
  reviewMode?: boolean;
  isNewFile?: boolean;
  selected?: boolean;
  canComment?: boolean;
  onMouseDown?: () => void;
  onMouseEnter?: () => void;
};

const LINE_BG: Record<DiffLineType["type"], string> = {
  add: "bg-[#12261e]",
  delete: "bg-[#2a1516]",
  context: "",
  header: "bg-[#121d2f]",
};

const GUTTER_BG: Record<DiffLineType["type"], string> = {
  add: "bg-[#1a3329]",
  delete: "bg-[#31191b]",
  context: "bg-[#161b22]",
  header: "bg-[#121d2f]",
};

const GUTTER_TEXT: Record<DiffLineType["type"], string> = {
  add: "text-[#3fb950]/60",
  delete: "text-[#f85149]/60",
  context: "text-[#848d97]",
  header: "text-[#58a6ff]/60",
};

const PREFIX_COLOR: Record<DiffLineType["type"], string> = {
  add: "text-[#3fb950]",
  delete: "text-[#f85149]",
  context: "text-transparent",
  header: "text-[#58a6ff]",
};

const LINE_TEXT: Record<DiffLineType["type"], string> = {
  add: "text-[#adbac7]",
  delete: "text-[#adbac7]",
  context: "text-[#adbac7]",
  header: "text-[#58a6ff]",
};

// GitHub-style word-level emphasis: a stronger tint on the exact words that
// changed, layered over the softer line background.
const WORD_BG: Partial<Record<DiffLineType["type"], string>> = {
  add: "bg-[#2ea043]/40",
  delete: "bg-[#f85149]/30",
};

type Segment = { text: string; color?: string; emphasized: boolean };

/**
 * Split the line into render segments, cutting syntax-highlight tokens at
 * word-diff range boundaries so changed words get the emphasis background.
 * `wordRanges` are sorted, non-overlapping [start, end) offsets in content.
 */
function segmentLine(line: DiffLineType): Segment[] {
  const ranges = line.wordRanges ?? [];
  const tokens =
    line.tokens && line.tokens.length > 0
      ? line.tokens
      : [{ content: line.content, color: undefined }];
  const segments: Segment[] = [];
  let offset = 0;
  for (const token of tokens) {
    const start = offset;
    const end = offset + token.content.length;
    let cursor = start;
    for (const [rs, re] of ranges) {
      if (re <= cursor || rs >= end) continue;
      const s = Math.max(rs, cursor);
      const e = Math.min(re, end);
      if (s > cursor) {
        segments.push({
          text: token.content.slice(cursor - start, s - start),
          color: token.color,
          emphasized: false,
        });
      }
      segments.push({
        text: token.content.slice(s - start, e - start),
        color: token.color,
        emphasized: true,
      });
      cursor = e;
    }
    if (cursor < end) {
      segments.push({
        text: token.content.slice(cursor - start),
        color: token.color,
        emphasized: false,
      });
    }
    offset = end;
  }
  return segments;
}

export function DiffLine({
  line,
  reviewMode,
  isNewFile,
  selected,
  canComment,
  onMouseDown,
  onMouseEnter,
}: Props) {
  const prefix = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
  const selectedBg = selected ? "!bg-[#264f78]" : "";
  const hasTokens = line.tokens && line.tokens.length > 0;

  // Review mode: neutral colors (no diff background tinting)
  // New files: use green-tinted gutter to match the file background
  const bg = reviewMode ? "" : LINE_BG[line.type];
  const gutterBg = reviewMode
    ? isNewFile
      ? "bg-[#1a3329]"
      : "bg-[#161b22]"
    : GUTTER_BG[line.type];
  const gutterText = reviewMode ? "text-[#848d97]" : GUTTER_TEXT[line.type];
  const prefixColor = reviewMode ? "text-transparent" : PREFIX_COLOR[line.type];
  const textColor = hasTokens ? "" : reviewMode ? "text-[#adbac7]" : LINE_TEXT[line.type];

  const handleMouseDown = (e: React.MouseEvent) => {
    if (onMouseDown) {
      e.preventDefault();
      onMouseDown();
    }
  };

  return (
    <tr className={`${bg} ${selectedBg} group font-mono text-sm leading-6`}>
      <td
        className={`${gutterBg} ${gutterText} w-8 text-right px-1 select-none align-top text-xs ${canComment ? "cursor-pointer hover:bg-[#1f6feb]/30" : ""}`}
        onMouseDown={handleMouseDown}
        onMouseEnter={onMouseEnter}
      >
        {line.oldLineNumber ?? ""}
      </td>
      <td
        className={`${gutterBg} ${gutterText} w-8 text-right px-1 select-none align-top text-xs ${canComment ? "cursor-pointer hover:bg-[#1f6feb]/30" : ""}`}
        onMouseDown={handleMouseDown}
        onMouseEnter={onMouseEnter}
      >
        {line.newLineNumber ?? ""}
      </td>
      <td className={`${prefixColor} w-4 text-center select-none align-top pl-2`}>{prefix}</td>
      <td className={`${textColor} px-2 whitespace-pre-wrap break-all`}>
        {!reviewMode && line.wordRanges && line.wordRanges.length > 0
          ? segmentLine(line).map((seg, i) => (
              <span
                key={i}
                className={seg.emphasized ? `${WORD_BG[line.type] ?? ""} rounded-[2px]` : undefined}
                style={seg.color ? { color: seg.color } : undefined}
              >
                {seg.text}
              </span>
            ))
          : hasTokens
            ? line.tokens?.map((token, i) => (
                <span key={i} style={token.color ? { color: token.color } : undefined}>
                  {token.content}
                </span>
              ))
            : line.content}
      </td>
    </tr>
  );
}
