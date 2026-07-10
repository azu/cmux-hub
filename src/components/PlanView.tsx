import React, { useCallback } from "react";
import { DiffFile } from "./DiffFile.tsx";
import { api } from "../lib/api.ts";
import { handleDelivery } from "../lib/delivery.ts";
import { useToast } from "./Toast.tsx";
import { usePlanData } from "../hooks/usePlanData.ts";

type Props = {
  onBack: () => void;
  hasTerminal?: boolean;
};

export function PlanView({ onBack, hasTerminal = false }: Props) {
  const { files, planPath, loading, error, isPending } = usePlanData();
  const { showToast } = useToast();

  const handleComment = useCallback(
    async (file: string, startLine: number, endLine: number, comment: string) => {
      try {
        const result = await api.sendComment(file, startLine, endLine, comment);
        await handleDelivery(result, showToast);
      } catch (e) {
        console.error("Failed to send comment:", e);
        showToast(e instanceof Error ? e.message : "Failed to send comment");
      }
    },
    [showToast],
  );

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
      <div className="flex items-center gap-3 px-4 py-2 bg-[#161b22] border border-[#30363d] rounded-md relative overflow-hidden">
        {isPending && (
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#1a1e24] overflow-hidden">
            <div className="h-full bg-[#58a6ff] animate-progress-bar" />
          </div>
        )}
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
