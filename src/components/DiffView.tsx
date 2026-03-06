import React, { useCallback } from "react";
import type { ParsedDiff } from "../lib/diff-parser.ts";
import { DiffFile } from "./DiffFile.tsx";
import { api } from "../lib/api.ts";

type Props = {
  diff: ParsedDiff;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
};

export function DiffView({ diff, loading, error, onRefresh }: Props) {
  const handleComment = useCallback(async (file: string, line: number, comment: string) => {
    try {
      await api.sendComment(file, line, comment);
    } catch (e) {
      console.error("Failed to send comment:", e);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        Loading diff...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-red-400">{error}</p>
        <button
          onClick={onRefresh}
          className="text-blue-400 hover:text-blue-300 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (diff.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        No changes detected
      </div>
    );
  }

  return (
    <div data-testid="diff-view" className="space-y-2">
      {diff.map((file, idx) => (
        <DiffFile key={`${file.newPath}-${idx}`} file={file} onComment={handleComment} />
      ))}
    </div>
  );
}
