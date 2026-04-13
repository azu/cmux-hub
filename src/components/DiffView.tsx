import React, { useCallback } from "react";
import type { ParsedDiff } from "../lib/diff-parser.ts";
import type { SelectedCommit } from "../hooks/useDiff.ts";
import { DiffFile } from "./DiffFile.tsx";
import { CommitList } from "./CommitList.tsx";
import { api } from "../lib/api.ts";
import { useReviewQueue } from "../hooks/useReviewQueue.tsx";
import type { CommentMode } from "./CommentForm.tsx";

type PRComment = {
  id: number;
  body: string;
  bodyHtml: string;
  user: string;
  path: string;
  line: number;
  createdAt: string;
  isResolved: boolean;
};

type Props = {
  diff: ParsedDiff;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  hasTerminal?: boolean;
  selectedCommit?: SelectedCommit | null;
  showCommitList?: boolean;
  hasUncommittedChanges?: boolean;
  prComments?: PRComment[];
  onSelectCommit?: (commit: SelectedCommit) => void;
  onClearCommit?: () => void;
};

export function DiffView({
  diff,
  loading,
  error,
  onRefresh,
  hasTerminal = false,
  selectedCommit,
  showCommitList,
  hasUncommittedChanges,
  prComments = [],
  onSelectCommit,
  onClearCommit,
}: Props) {
  const { addToReview, pending } = useReviewQueue();

  const handleComment = useCallback(
    async (
      file: string,
      startLine: number,
      endLine: number,
      comment: string,
      mode: CommentMode,
    ) => {
      if (mode === "review") {
        addToReview({ file, startLine, endLine, comment });
      } else {
        try {
          await api.sendComment(file, startLine, endLine, comment);
        } catch (e) {
          console.error("Failed to send comment:", e);
        }
      }
    },
    [addToReview],
  );

  if (loading && diff.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">Loading diff...</div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-red-400">{error}</p>
        <button onClick={onRefresh} className="text-blue-400 hover:text-blue-300 underline">
          Retry
        </button>
      </div>
    );
  }

  if (showCommitList && onSelectCommit && onClearCommit) {
    return (
      <div>
        <div className="max-w-3xl mx-auto mb-3">
          <button className="text-[#58a6ff] hover:text-[#79c0ff] text-sm" onClick={onClearCommit}>
            ← Back
          </button>
        </div>
        <CommitList
          onSelectCommit={onSelectCommit}
          showNoDiffMessage={false}
          hasUncommittedChanges={hasUncommittedChanges}
          onShowUncommitted={onClearCommit}
        />
      </div>
    );
  }

  if (diff.length === 0 && !selectedCommit) {
    if (onSelectCommit) {
      return <CommitList onSelectCommit={onSelectCommit} />;
    }
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">No changes detected</div>
    );
  }

  return (
    <div data-testid="diff-view" className="space-y-2">
      {selectedCommit && onClearCommit && (
        <div className="flex items-center gap-3 px-4 py-2 bg-[#161b22] border border-[#30363d] rounded-md">
          <button className="text-[#58a6ff] hover:text-[#79c0ff] text-sm" onClick={onClearCommit}>
            ← Back
          </button>
          <span className="text-[#848d97] text-sm">
            <span className="font-mono text-[#58a6ff]">{selectedCommit.hash}</span>{" "}
            {selectedCommit.message}
          </span>
        </div>
      )}
      {diff
        .filter((file) => !file.generated)
        .map((file, idx) => (
          <DiffFile
            key={`${file.newPath}-${idx}`}
            file={file}
            onComment={hasTerminal ? handleComment : undefined}
            prComments={prComments.filter((c) => c.path === file.newPath)}
            pendingComments={pending.filter((c) => c.file === file.newPath)}
          />
        ))}
    </div>
  );
}
