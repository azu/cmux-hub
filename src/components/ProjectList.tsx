import React, { useCallback } from "react";
import { api, type ProjectSummary } from "../lib/api.ts";
import { useWSFetch } from "../hooks/useWSFetch.ts";

type Props = {
  onSelectProject: (id: string) => void;
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function prStateColor(state: string): string {
  if (state === "MERGED") return "text-[#a371f7] border-[#a371f7]/40";
  if (state === "CLOSED") return "text-[#f85149] border-[#f85149]/40";
  return "text-[#3fb950] border-[#3fb950]/40";
}

export function ProjectList({ onSelectProject }: Props) {
  const { data, loading, refetch } = useWSFetch({
    fetch: () => api.getProjects(),
    wsMessageType: ["projects-updated", "diff-updated", "pr-updated"],
    // The list aggregates every project — tagged events from any of them
    // should refresh the stats
    matchAllProjects: true,
  });

  const handleDismiss = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      try {
        await api.dismissProject(id);
        refetch();
      } catch (err) {
        console.error("Failed to dismiss project:", err);
      }
    },
    [refetch],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">Loading projects...</div>
    );
  }

  const projects = data?.projects ?? [];

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-4 text-center">
        <p className="text-[#848d97] text-lg">No active sessions</p>
        <div className="text-[#848d97] text-sm max-w-xl space-y-2">
          <p>Projects appear here when a session registers itself:</p>
          <pre className="bg-[#161b22] border border-[#30363d] rounded-md p-3 text-left text-xs overflow-x-auto text-[#c9d1d9]">
            {`curl -s -X POST http://127.0.0.1:${window.location.port}/api/projects/register \\
  -H 'Content-Type: application/json' \\
  -d "{\\"cwd\\": \\"$PWD\\"}"`}
          </pre>
          <p>Add it to your harness's session-start hook (see README).</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto pt-6" data-testid="project-list">
      <h1 className="text-[#c9d1d9] text-lg font-semibold mb-4">Projects</h1>
      <div className="space-y-3">
        {projects.map((p: ProjectSummary) => (
          <div
            key={p.id}
            className={`border border-[#30363d] rounded-lg px-4 py-3 cursor-pointer hover:border-[#58a6ff]/60 hover:bg-[#161b22] transition-colors ${
              p.status === "inactive" ? "opacity-60" : ""
            }`}
            onClick={() => onSelectProject(p.id)}
          >
            <div className="flex items-center gap-3">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  p.status === "active" ? "bg-[#3fb950]" : "bg-[#848d97]"
                }`}
                title={p.status === "active" ? "Active session" : "Session ended"}
              />
              <span className="text-[#c9d1d9] font-medium">{p.name}</span>
              <span className="text-[#58a6ff] font-mono text-xs truncate">{p.branch}</span>
              <div className="flex-1" />
              {p.filesChanged > 0 && (
                <span className="text-xs font-mono shrink-0">
                  <span className="text-[#848d97]">{p.filesChanged} files </span>
                  <span className="text-[#3fb950]">+{p.additions}</span>{" "}
                  <span className="text-[#f85149]">−{p.deletions}</span>
                </span>
              )}
              {p.pr && (
                <a
                  href={p.pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className={`text-xs border rounded-full px-2 py-0.5 shrink-0 hover:underline ${prStateColor(p.pr.state)}`}
                  title={p.pr.title}
                >
                  PR #{p.pr.number} · {p.pr.state.toLowerCase()}
                </a>
              )}
              <button
                className="text-[#848d97] hover:text-[#f85149] text-sm px-1 shrink-0"
                onClick={(e) => handleDismiss(e, p.id)}
                title="Remove from list"
              >
                ✕
              </button>
            </div>
            <div className="flex items-center gap-3 mt-1 pl-5">
              <span className="text-[#848d97] text-xs font-mono truncate">{p.cwd}</span>
              <span className="text-[#848d97] text-xs shrink-0">
                {p.status === "active" ? "active" : `last seen ${relativeTime(p.lastSeenAt)}`}
              </span>
              {p.harness && <span className="text-[#848d97] text-xs shrink-0">{p.harness}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
