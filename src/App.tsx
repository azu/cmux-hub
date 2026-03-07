import React, { useState, useEffect, useCallback } from "react";
import { DiffView } from "./components/DiffView.tsx";
import { Toolbar } from "./components/Toolbar.tsx";
import { CIStatus } from "./components/CIStatus.tsx";
import { useDiff } from "./hooks/useDiff.ts";
import { useWebSocket } from "./hooks/useWebSocket.ts";
import { api } from "./lib/api.ts";
import type { MenuItem } from "../server/actions.ts";
import "./index.css";

type Check = {
  name: string;
  status: string;
  conclusion: string;
  url: string;
};

type PRComment = {
  id: number;
  body: string;
  user: string;
  path: string;
  line: number;
  createdAt: string;
  isResolved: boolean;
};

export default function App() {
  const {
    diff,
    loading,
    refreshing,
    error,
    refresh,
    selectedCommit,
    hasUncommittedChanges,
    selectCommit,
    clearCommit,
  } = useDiff();
  const [branch, setBranch] = useState("...");
  const [hasTerminal, setHasTerminal] = useState(false);
  const [actions, setActions] = useState<MenuItem[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [prComments, setPrComments] = useState<PRComment[]>([]);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prTitle, setPrTitle] = useState<string | null>(null);
  const [showCommitList, setShowCommitList] = useState(false);

  useEffect(() => {
    api
      .getStatus()
      .then((s) => {
        setBranch(s.branch);
        setHasTerminal(s.terminalSurface !== null);
        if (s.actions) setActions(s.actions);
      })
      .catch(() => {});
    // Fetch PR data immediately on load
    api
      .getPR()
      .then((r) => {
        const pr = r.pr as { url?: string; title?: string; number?: number } | null;
        if (pr?.url) setPrUrl(pr.url);
        if (pr?.title) setPrTitle(pr.title);
        if (pr?.number) {
          api.getCI().then((c) => {
            if (c.checks) setChecks(c.checks as Check[]);
          });
          api.getPRComments().then((c) => {
            if (c.comments) setPrComments(c.comments as PRComment[]);
          });
        }
      })
      .catch(() => {});
  }, []);

  const handleWSMessage = useCallback(
    (msg: { type: string; data?: unknown }) => {
      if (msg.type === "diff-updated") {
        refresh();
      }
      if (msg.type === "pr-updated" && msg.data) {
        const data = msg.data as {
          pr?: { url?: string };
          checks?: Check[];
          comments?: PRComment[];
        };
        if (data.pr?.url) setPrUrl(data.pr.url);
        if ((data.pr as { title?: string })?.title) setPrTitle((data.pr as { title: string }).title);
        if (data.checks) setChecks(data.checks);
        if (data.comments) setPrComments(data.comments);
      }
    },
    [refresh],
  );

  useWebSocket(handleWSMessage);

  return (
    <div className="min-h-screen bg-[#0d1117] text-[#c9d1d9] flex flex-col">
      {refreshing && (
        <div className="fixed top-0 left-0 right-0 z-50 h-0.5 bg-[#1a1e24] overflow-hidden">
          <div className="h-full bg-[#58a6ff] animate-progress-bar" />
        </div>
      )}
      <Toolbar
        branch={branch}
        onRefresh={refresh}
        hasTerminal={hasTerminal}
        actions={actions}
        onShowCommitList={() => setShowCommitList(true)}
      />
      <div
        className={`flex-1 overflow-auto p-4 transition-opacity duration-200 ${refreshing ? "opacity-60" : "opacity-100"}`}
      >
        {(checks.length > 0 || prUrl) && (
          <div className="mb-4">
            <CIStatus checks={checks} prTitle={prTitle} prUrl={prUrl} />
          </div>
        )}
        <DiffView
          diff={diff}
          loading={loading}
          error={error}
          onRefresh={refresh}
          hasTerminal={hasTerminal}
          selectedCommit={selectedCommit}
          showCommitList={showCommitList}
          hasUncommittedChanges={hasUncommittedChanges}
          prComments={prComments.filter((c) => !c.isResolved)}
          onSelectCommit={(commit) => {
            setShowCommitList(false);
            selectCommit(commit);
          }}
          onClearCommit={() => {
            setShowCommitList(false);
            clearCommit();
          }}
        />
      </div>
    </div>
  );
}
