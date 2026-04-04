import React, { useState, useCallback, useEffect, useMemo } from "react";
import type { DiffFile as DiffFileType, DiffLine as DiffLineType } from "../lib/diff-parser.ts";
import { DiffLine } from "./DiffLine.tsx";
import { CommentForm } from "./CommentForm.tsx";
import type { CommentMode } from "./CommentForm.tsx";
import { InlinePRComment } from "./PRComments.tsx";
import { PendingComment } from "./PendingComment.tsx";
import { api } from "../lib/api.ts";
import { useReviewQueue } from "../hooks/useReviewQueue.tsx";
import type { PendingComment as PendingCommentData } from "../hooks/useReviewQueue.tsx";

type PRCommentData = {
  id: number;
  body: string;
  bodyHtml: string;
  user: string;
  path: string;
  line: number;
  createdAt: string;
  isResolved: boolean;
};

type FlatLine = {
  type: "line";
  line: DiffLineType;
  index: number;
};

type FlatHunkHeader = {
  type: "hunk-header";
  header: string;
  hunkIndex: number;
};

type FlatExpandButton = {
  type: "expand";
  direction: "up" | "down" | "both";
  fromLine: number;
  toLine: number;
  hunkIndex: number;
};

type FlatPRComment = {
  type: "pr-comment";
  comment: PRCommentData;
};

type FlatCommentForm = {
  type: "comment-form";
};

type FlatPendingComment = {
  type: "pending-comment";
  pendingComment: PendingCommentData;
};

type FlatCopyTooltip = {
  type: "copy-tooltip";
  file: string;
  startLine: number;
  endLine: number;
};

type FlatItem = FlatLine | FlatHunkHeader | FlatExpandButton;
type RenderItem = FlatItem | FlatPRComment | FlatCommentForm | FlatPendingComment | FlatCopyTooltip;

type Props = {
  file: DiffFileType;
  onComment?: (file: string, startLine: number, endLine: number, comment: string, mode: CommentMode) => void;
  prComments?: PRCommentData[];
  pendingComments?: PendingCommentData[];
};

const EXPAND_LINES = 20;

export function DiffFile({ file, onComment, prComments = [], pendingComments = [] }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [selStart, setSelStart] = useState<number | null>(null);
  const [selEnd, setSelEnd] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showComment, setShowComment] = useState(false);
  const [showFileComment, setShowFileComment] = useState(false);
  const [expandedLines, setExpandedLines] = useState<Map<string, DiffLineType[]>>(new Map());
  const [loadingExpand, setLoadingExpand] = useState<string | null>(null);
  const [copiedRef, setCopiedRef] = useState(false);
  const { updatePending, removePending, pending: allPending } = useReviewQueue();

  // Review mode: no diff coloring for new files or files with only additions
  const isReviewMode = useMemo(() => {
    if (file.isNew) return true;
    return file.hunks.every((hunk) => hunk.lines.every((line) => line.type === "add"));
  }, [file]);

  // Flatten all lines with sequential index, including expand buttons
  const flatItems = useMemo(() => {
    const items: FlatItem[] = [];
    let idx = 0;

    for (let hi = 0; hi < file.hunks.length; hi++) {
      const hunk = file.hunks[hi];
      if (!hunk) continue;
      const prevHunk = hi > 0 ? (file.hunks[hi - 1] ?? null) : null;

      // Expand button before hunk
      if (hi === 0 && hunk.newStart > 1) {
        // Lines before the first hunk
        const expandKey = `before-${hi}`;
        const expanded = expandedLines.get(expandKey);
        if (expanded) {
          for (const line of expanded) {
            items.push({ type: "line", line, index: idx++ });
          }
        } else {
          items.push({
            type: "expand",
            direction: "up",
            fromLine: Math.max(1, hunk.newStart - EXPAND_LINES),
            toLine: hunk.newStart - 1,
            hunkIndex: hi,
          });
        }
      } else if (prevHunk) {
        const prevEnd = prevHunk.newStart + prevHunk.newCount;
        const gapStart = prevEnd;
        const gapEnd = hunk.newStart - 1;
        if (gapEnd >= gapStart) {
          const expandKey = `between-${hi}`;
          const expanded = expandedLines.get(expandKey);
          if (expanded) {
            for (const line of expanded) {
              items.push({ type: "line", line, index: idx++ });
            }
          } else {
            items.push({
              type: "expand",
              direction: "both",
              fromLine: gapStart,
              toLine: gapEnd,
              hunkIndex: hi,
            });
          }
        }
      }

      items.push({ type: "hunk-header", header: hunk.header, hunkIndex: hi });

      for (const line of hunk.lines) {
        items.push({ type: "line", line, index: idx++ });
      }

      // Expand button after last hunk
      if (hi === file.hunks.length - 1) {
        const lastEnd = hunk.newStart + hunk.newCount;
        const expandKey = `after-${hi}`;
        const expanded = expandedLines.get(expandKey);
        if (expanded) {
          for (const line of expanded) {
            items.push({ type: "line", line, index: idx++ });
          }
        } else {
          items.push({
            type: "expand",
            direction: "down",
            fromLine: lastEnd,
            toLine: lastEnd + EXPAND_LINES - 1,
            hunkIndex: hi,
          });
        }
      }
    }

    return items;
  }, [file.hunks, expandedLines]);

  // Group PR comments by line number
  const commentsByLine = useMemo(() => {
    const map = new Map<number, PRCommentData[]>();
    for (const c of prComments) {
      if (c.line === null) continue;
      const existing = map.get(c.line);
      if (existing) {
        existing.push(c);
      } else {
        map.set(c.line, [c]);
      }
    }
    return map;
  }, [prComments]);

  // Group pending comments by endLine
  const pendingByLine = useMemo(() => {
    const map = new Map<number, PendingCommentData[]>();
    for (const c of pendingComments) {
      const ln = c.endLine;
      const existing = map.get(ln);
      if (existing) {
        existing.push(c);
      } else {
        map.set(ln, [c]);
      }
    }
    return map;
  }, [pendingComments]);

  const selMin = selStart !== null && selEnd !== null ? Math.min(selStart, selEnd) : null;
  const selMax = selStart !== null && selEnd !== null ? Math.max(selStart, selEnd) : null;

  const selectedLineRange = useMemo((): [number, number] | null => {
    if (selMin === null || selMax === null) return null;
    let startLine: number | null = null;
    let endLine: number | null = null;
    for (const item of flatItems) {
      if (item.type !== "line") continue;
      if (item.index >= selMin && item.index <= selMax) {
        const ln = item.line.newLineNumber ?? item.line.oldLineNumber;
        if (ln !== null) {
          if (startLine === null) startLine = ln;
          endLine = ln;
        }
      }
    }
    if (startLine !== null && endLine !== null) return [startLine, endLine];
    return null;
  }, [flatItems, selMin, selMax]);

  // Flatten items with PR comments, pending comments, and comment form interleaved for rendering
  const renderItems = useMemo(() => {
    const items: RenderItem[] = [];
    for (const item of flatItems) {
      items.push(item);
      if (item.type === "line") {
        const lineNum = item.line.newLineNumber;
        const lineComments = lineNum !== null ? commentsByLine.get(lineNum) : undefined;
        if (lineComments) {
          for (const c of lineComments) {
            items.push({ type: "pr-comment", comment: c });
          }
        }
        const linePending = lineNum !== null ? pendingByLine.get(lineNum) : undefined;
        if (linePending) {
          for (const p of linePending) {
            items.push({ type: "pending-comment", pendingComment: p });
          }
        }
        if (showComment && selMax !== null && item.index === selMax) {
          if (selectedLineRange) {
            items.push({ type: "copy-tooltip", file: file.newPath, startLine: selectedLineRange[0], endLine: selectedLineRange[1] });
          }
          items.push({ type: "comment-form" });
        }
      }
    }
    return items;
  }, [flatItems, commentsByLine, pendingByLine, showComment, selMax, selectedLineRange, file.newPath]);


  const handleMouseDown = useCallback(
    (index: number) => {
      if (!onComment) return;
      setSelStart(index);
      setSelEnd(index);
      setDragging(true);
      setShowComment(false);
    },
    [onComment],
  );

  const handleMouseEnter = useCallback(
    (index: number) => {
      if (dragging) {
        setSelEnd(index);
      }
    },
    [dragging],
  );

  useEffect(() => {
    if (!dragging) return;
    const handleMouseUp = () => {
      setDragging(false);
      setShowComment(true);
    };
    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, [dragging]);

  const handleCancelComment = useCallback(() => {
    setSelStart(null);
    setSelEnd(null);
    setShowComment(false);
  }, []);


  const handleSubmitComment = useCallback(
    (comment: string, mode: CommentMode) => {
      if (onComment && selectedLineRange) {
        onComment(file.newPath, selectedLineRange[0], selectedLineRange[1], comment, mode);
      }
      handleCancelComment();
    },
    [onComment, file.newPath, selectedLineRange, handleCancelComment],
  );

  const handleSubmitFileComment = useCallback(
    (comment: string, mode: CommentMode) => {
      if (onComment) {
        onComment(file.newPath, 0, 0, comment, mode);
      }
      setShowFileComment(false);
    },
    [onComment, file.newPath],
  );

  const handleExpand = useCallback(
    async (direction: string, fromLine: number, toLine: number, hunkIndex: number) => {
      const key =
        direction === "up"
          ? `before-${hunkIndex}`
          : direction === "down"
            ? `after-${hunkIndex}`
            : `between-${hunkIndex}`;

      setLoadingExpand(key);
      try {
        const { lines, tokenLines } = await api.getFileLines(file.newPath, fromLine, toLine);
        const contextLines: DiffLineType[] = lines.map((content, i) => ({
          type: "context" as const,
          content,
          oldLineNumber: fromLine + i,
          newLineNumber: fromLine + i,
          tokens: tokenLines[i],
        }));
        setExpandedLines((prev) => new Map(prev).set(key, contextLines));
      } catch {
        // ignore
      } finally {
        setLoadingExpand(null);
      }
    },
    [file.newPath],
  );

  const renderRow = useCallback(
    (item: RenderItem) => {
      if (item.type === "hunk-header") {
        return (
          <tr className="bg-[#121d2f]">
            <td colSpan={4} className="text-[#58a6ff]/80 text-xs font-mono px-4 py-1">
              {item.header}
            </td>
          </tr>
        );
      }

      if (item.type === "expand") {
        const key =
          item.direction === "up"
            ? `before-${item.hunkIndex}`
            : item.direction === "down"
              ? `after-${item.hunkIndex}`
              : `between-${item.hunkIndex}`;
        const isLoading = loadingExpand === key;

        return (
          <tr className="bg-[#161b22] hover:bg-[#1c2128]">
            <td colSpan={4} className="text-center py-1">
              <button
                className="text-[#58a6ff] hover:text-[#79c0ff] text-xs font-mono px-4 py-0.5 disabled:opacity-50"
                disabled={isLoading}
                onClick={() =>
                  handleExpand(item.direction, item.fromLine, item.toLine, item.hunkIndex)
                }
              >
                {isLoading
                  ? "..."
                  : item.direction === "up"
                    ? "↑ Show lines above"
                    : item.direction === "down"
                      ? "↓ Show lines below"
                      : `↕ Show ${item.toLine - item.fromLine + 1} hidden lines`}
              </button>
            </td>
          </tr>
        );
      }

      if (item.type === "pr-comment") {
        return (
          <tr>
            <td colSpan={4} className="px-4 py-1 bg-[#1c2128] border-l-2 border-[#58a6ff]">
              <InlinePRComment comment={item.comment} filePath={file.newPath} />
            </td>
          </tr>
        );
      }

      if (item.type === "pending-comment") {
        return (
          <tr>
            <td colSpan={4} className="px-4 py-1 bg-[#1c2128] border-l-2 border-[#d29922]">
              <PendingComment
                comment={item.pendingComment.comment}
                onUpdate={(text) => updatePending(item.pendingComment.id, text)}
                onDelete={() => removePending(item.pendingComment.id)}
              />
            </td>
          </tr>
        );
      }

      if (item.type === "copy-tooltip") {
        const range = item.startLine === item.endLine ? `${item.startLine}` : `${item.startLine}-${item.endLine}`;
        const ref = `${item.file}:${range}`;
        return (
          <tr>
            <td colSpan={4} className="px-4 py-1">
              <button
                className="text-xs text-[#848d97] hover:text-[#adbac7] border border-[#30363d] rounded px-2 py-0.5 hover:border-[#848d97]"
                onClick={async () => {
                  await navigator.clipboard.writeText(ref);
                  setCopiedRef(true);
                  setTimeout(() => setCopiedRef(false), 1500);
                }}
              >
                {copiedRef ? "Copied!" : ref}
              </button>
            </td>
          </tr>
        );
      }

      if (item.type === "comment-form") {
        return (
          <tr>
            <td colSpan={4} className="p-2 bg-gray-900">
              <CommentForm
                onSubmit={handleSubmitComment}
                onCancel={handleCancelComment}
              />
            </td>
          </tr>
        );
      }

      const isSelected =
        selMin !== null && selMax !== null && item.index >= selMin && item.index <= selMax;

      return (
        <DiffLine
          line={item.line}
          filePath={file.newPath}
          reviewMode={isReviewMode}
          isNewFile={file.isNew}
          selected={isSelected}
          canComment={!!onComment}
          onMouseDown={onComment ? () => handleMouseDown(item.index) : undefined}
          onMouseEnter={onComment ? () => handleMouseEnter(item.index) : undefined}
        />
      );
    },
    [
      file.newPath,
      file.isNew,
      isReviewMode,
      onComment,
      selMin,
      selMax,
      loadingExpand,
      handleExpand,
      handleMouseDown,
      handleMouseEnter,
      handleSubmitComment,
      handleCancelComment,
      updatePending,
      removePending,
      copiedRef,
      allPending.length,
    ],
  );

  const renderItemKey = (item: RenderItem, i: number): string => {
    switch (item.type) {
      case "hunk-header":
        return `hdr-${item.hunkIndex}`;
      case "expand":
        return `expand-${item.direction}-${item.hunkIndex}`;
      case "pr-comment":
        return `pr-comment-${item.comment.id}`;
      case "pending-comment":
        return `pending-${item.pendingComment.id}`;
      case "copy-tooltip":
        return `copy-tooltip`;
      case "comment-form":
        return `comment-form`;
      case "line":
        return `line-${item.index}`;
      default:
        return `item-${i}`;
    }
  };

  const badge = file.isNew ? "New" : file.isDeleted ? "Deleted" : file.isRenamed ? "Renamed" : null;

  const badgeColor = file.isNew
    ? "bg-[#238636] text-white"
    : file.isDeleted
      ? "bg-[#da3633] text-white"
      : "bg-[#9e6a03] text-white";

  return (
    <div data-testid="diff-file" className="mb-4">
      <div
        className="flex items-center gap-2 px-4 py-2 bg-[#161b22] border-b border-[#30363d] cursor-pointer hover:bg-[#1c2128] sticky top-0 z-10 -mx-4"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="text-[#848d97] select-none text-xs">
          {collapsed ? "\u25b6" : "\u25bc"}
        </span>
        <span className="text-[#adbac7] font-mono text-sm flex-1">{file.newPath}</span>
        {onComment && (
          <button
            className="text-[#848d97] hover:text-[#58a6ff] text-sm px-4 py-1.5 rounded hover:bg-[#30363d] transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              setShowFileComment((v) => !v);
            }}
            title="Comment on file"
          >
            Comment
          </button>
        )}
        {badge && (
          <span className={`${badgeColor} text-xs px-2 py-0.5 rounded-full font-medium`}>
            {badge}
          </span>
        )}
      </div>
      {showFileComment && (
        <div className="px-4 py-2 bg-gray-900 border-x border-b border-[#30363d]">
          <CommentForm
            onSubmit={handleSubmitFileComment}
            onCancel={() => setShowFileComment(false)}
          />
        </div>
      )}
      {!collapsed && (
        <div className="border-x border-b border-[#30363d] rounded-b-md overflow-hidden" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 500px" } as React.CSSProperties}>
          <table className={`w-full border-collapse ${file.isNew ? "bg-[#12261e]" : ""}`}>
            <tbody>
              {renderItems.map((item, i) => (
                <React.Fragment key={renderItemKey(item, i)}>
                  {renderRow(item)}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
