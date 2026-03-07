import React, { useState, useEffect, useCallback } from "react";
import { DiffFile } from "./DiffFile.tsx";
import { api } from "../lib/api.ts";
import type { ParsedDiff } from "../lib/diff-parser.ts";

type Props = {
  onBack: () => void;
  hasTerminal?: boolean;
};

export function PlanView({ onBack, hasTerminal = false }: Props) {
  const [files, setFiles] = useState<ParsedDiff>([]);
  const [planPath, setPlanPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleComment = useCallback(
    async (file: string, startLine: number, endLine: number, comment: string) => {
      try {
        await api.sendComment(file, startLine, endLine, comment);
      } catch (e) {
        console.error("Failed to send comment:", e);
      }
    },
    [],
  );

  useEffect(() => {
    api
      .getPlan()
      .then((res) => {
        if (res.found && res.files) {
          setFiles(res.files);
          setPlanPath(res.path ?? null);
        } else {
          setError("Plan file not found");
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load plan"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">Loading plan...</div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-red-400">{error}</p>
        <button onClick={onBack} className="text-blue-400 hover:text-blue-300 underline">
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 px-4 py-2 bg-[#161b22] border border-[#30363d] rounded-md">
        <button className="text-[#58a6ff] hover:text-[#79c0ff] text-sm" onClick={onBack}>
          ← Back
        </button>
        {planPath && <span className="text-[#848d97] text-sm font-mono truncate">{planPath}</span>}
      </div>
      {files.map((file, idx) => (
        <DiffFile
          key={`${file.newPath}-${idx}`}
          file={file}
          onComment={hasTerminal ? handleComment : undefined}
        />
      ))}
    </div>
  );
}
