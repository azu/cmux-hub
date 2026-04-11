import React, { useCallback } from "react";
import { DiffFile } from "./DiffFile.tsx";
import { api } from "../lib/api.ts";
import { useReviewData } from "../hooks/useReviewData.ts";

type Props = {
  onBack: () => void;
  hasTerminal?: boolean;
};

export function ReviewView({ onBack, hasTerminal = false }: Props) {
  const { files, reviewDirs, loading, error, isPending, refetch } = useReviewData();

  const handleComment = useCallback(
    async (file: string, startLine: number, endLine: number, comment: string) => {
      try {
        await api.sendComment(file, startLine, endLine, comment);
      } catch (e) {
        console.error("Failed to send review comment:", e);
      }
    },
    [],
  );

  const handleDelete = useCallback(
    async (path: string) => {
      if (!window.confirm(`Delete ${path}?`)) return;
      try {
        await api.deleteReview(path);
        refetch();
      } catch (e) {
        console.error("Failed to delete review file:", e);
      }
    },
    [refetch],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        Loading review files...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-[#848d97] text-sm">{error}</p>
        {reviewDirs.length > 0 && (
          <p className="text-[#848d97] text-xs font-mono">Watching: {reviewDirs.join(", ")}</p>
        )}
        <button onClick={onBack} className="text-[#58a6ff] hover:text-[#79c0ff] underline">
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 px-4 py-2 bg-[#161b22] border border-[#30363d] rounded-md relative overflow-hidden">
        {isPending && (
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#1a1e24] overflow-hidden">
            <div className="h-full bg-[#58a6ff] animate-progress-bar" />
          </div>
        )}
        <button className="text-[#58a6ff] hover:text-[#79c0ff] text-sm" onClick={onBack}>
          ← Back
        </button>
        {reviewDirs.length > 0 && (
          <span className="text-[#848d97] text-xs font-mono truncate">{reviewDirs.join(", ")}</span>
        )}
      </div>
      {files.map((file, idx) => (
        <div key={`${file.newPath}-${idx}`} className="space-y-1">
          <div className="flex items-center justify-between px-3 py-1 text-xs text-[#848d97]">
            <span className="font-mono truncate">{file.relativePath ?? file.newPath}</span>
            <button
              className="text-[#f85149] hover:text-[#ff6b6b] underline"
              onClick={() => handleDelete(file.newPath)}
              title="Delete this review file"
            >
              Delete
            </button>
          </div>
          <DiffFile file={file} onComment={hasTerminal ? handleComment : undefined} />
        </div>
      ))}
    </div>
  );
}
