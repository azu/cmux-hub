import { useState, useEffect } from "react";
import { api } from "../lib/api.ts";
import type { SelectedCommit } from "../hooks/useDiff.ts";

type Props = {
  onSelectCommit: (commit: SelectedCommit) => void;
};

export function CommitList({ onSelectCommit }: Props) {
  const [commits, setCommits] = useState<SelectedCommit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getLog(20)
      .then((result) => setCommits(result.commits))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        Loading commits...
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        No changes detected
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <p className="text-[#848d97] text-sm mb-3">No changes detected. Recent commits:</p>
      <div className="border border-[#30363d] rounded-md overflow-hidden">
        {commits.map((commit) => (
          <button
            key={commit.hash}
            className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-[#161b22] border-b border-[#30363d] last:border-b-0 transition-colors"
            onClick={() => onSelectCommit(commit)}
          >
            <span className="text-[#58a6ff] font-mono text-xs shrink-0">{commit.hash}</span>
            <span className="text-[#c9d1d9] text-sm truncate">{commit.message}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
