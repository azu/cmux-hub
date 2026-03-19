import React, { useState, useCallback, useEffect, useMemo, useContext } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffFile as DiffFileType, DiffLine as DiffLineType } from "../lib/diff-parser.ts";
import { DiffLine } from "./DiffLine.tsx";
import { CommentForm } from "./CommentForm.tsx";
import { InlinePRComment } from "./PRComments.tsx";
import { api } from "../lib/api.ts";
import { ScrollContainerContext } from "../App.tsx";

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

type FlatItem = FlatLine | FlatHunkHeader | FlatExpandButton;
type RenderItem = FlatItem | FlatPRComment | FlatCommentForm;

type Props = {
  file: DiffFileType;
  onComment?: (file: string, startLine: number, endLine: number, comment: string) => void;
  prComments?: PRCommentData[];
};

const EXPAND_LINES = 20;
const VIRTUALIZE_THRESHOLD = 100;

export function DiffFile({ file, onComment, prComments = [] }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [selStart, setSelStart] = useState<number | null>(null);
  const [selEnd, setSelEnd] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showComment, setShowComment] = useState(false);
  const [showFileComment, setShowFileComment] = useState(false);
  const [expandedLines, setExpandedLines] = useState<Map<string, DiffLineType[]>>(new Map());
  const [loadingExpand, setLoadingExpand] = useState<string | null>(null);
  const scrollContainerRef = useContext(ScrollContainerContext);

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

  const selMin = selStart !== null && selEnd !== null ? Math.min(selStart, selEnd) : null;
  const selMax = selStart !== null && selEnd !== null ? Math.max(selStart, selEnd) : null;

  // Flatten items with PR comments and comment form interleaved for rendering
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
        if (showComment && selMax !== null && item.index === selMax) {
          items.push({ type: "comment-form" });
        }
      }
    }
    return items;
  }, [flatItems, commentsByLine, showComment, selMax]);

  const shouldVirtualize = renderItems.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: shouldVirtualize && !collapsed ? renderItems.length : 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const item = renderItems[index];
      if (!item) return 24;
      if (item.type === "hunk-header" || item.type === "expand") return 28;
      if (item.type === "pr-comment") return 60;
      if (item.type === "comment-form") return 120;
      return 24;
    },
    overscan: 50,
  });

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

  const resolveLineRange = useCallback((): [number, number] | null => {
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

  const handleSubmitComment = useCallback(
    (comment: string) => {
      const range = resolveLineRange();
      if (onComment && range) {
        onComment(file.newPath, range[0], range[1], comment);
      }
      handleCancelComment();
    },
    [onComment, file.newPath, resolveLineRange, handleCancelComment],
  );

  const handleSubmitFileComment = useCallback(
    (comment: string) => {
      if (onComment) {
        onComment(file.newPath, 0, 0, comment);
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

      if (item.type === "comment-form") {
        return (
          <tr>
            <td colSpan={4} className="p-2 bg-gray-900">
              <CommentForm onSubmit={handleSubmitComment} onCancel={handleCancelComment} />
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

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      data-testid="diff-file"
      className="border border-[#30363d] rounded-md overflow-hidden mb-4"
    >
      <div
        className="flex items-center gap-2 px-4 py-2 bg-[#161b22] border-b border-[#30363d] cursor-pointer hover:bg-[#1c2128] sticky top-0 z-10"
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
        <div className="px-4 py-2 bg-gray-900 border-b border-[#30363d]">
          <CommentForm
            onSubmit={handleSubmitFileComment}
            onCancel={() => setShowFileComment(false)}
          />
        </div>
      )}
      {!collapsed && (
        <>
          {shouldVirtualize ? (
            <div
              style={{ height: virtualizer.getTotalSize(), position: "relative" }}
              className={file.isNew ? "bg-[#12261e]" : ""}
            >
              {virtualItems.map((virtualRow) => {
                const item = renderItems[virtualRow.index];
                if (!item) return null;
                return (
                  <div
                    key={renderItemKey(item, virtualRow.index)}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <table className="w-full border-collapse">
                      <tbody>{renderRow(item)}</tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          ) : (
            <table className={`w-full border-collapse ${file.isNew ? "bg-[#12261e]" : ""}`}>
              <tbody>
                {renderItems.map((item, i) => (
                  <React.Fragment key={renderItemKey(item, i)}>
                    {renderRow(item)}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
