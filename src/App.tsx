import React, { useState, useEffect, useCallback } from "react";
import { DiffView } from "./components/DiffView.tsx";
import { Toolbar } from "./components/Toolbar.tsx";
import { CIStatus } from "./components/CIStatus.tsx";
import { PlanView } from "./components/PlanView.tsx";
import { useDiff } from "./hooks/useDiff.ts";
import { useWebSocket } from "./hooks/useWebSocket.ts";
import { useHashRoute } from "./hooks/useHashRoute.ts";
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

type PR = {
  url?: string;
  title?: string;
  state?: string;
  number?: number;
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
  const { route, navigate } = useHashRoute();
  const [branch, setBranch] = useState("...");
  const [hasTerminal, setHasTerminal] = useState(false);
  const [actions, setActions] = useState<MenuItem[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [prComments, setPrComments] = useState<PRComment[]>([]);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prTitle, setPrTitle] = useState<string | null>(null);
  const [prState, setPrState] = useState<string | null>(null);
  const [hasPlan, setHasPlan] = useState(false);

  const fetchPR = useCallback(() => {
    api
      .getPR()
      .then((r) => {
        const pr = r.pr as PR | null;
        setPrUrl(pr?.url ?? null);
        setPrTitle(pr?.title ?? null);
        setPrState(pr?.state ?? null);
        if (pr?.number) {
          api.getCI().then((c) => {
            setChecks(c.checks ? (c.checks as Check[]) : []);
          });
          api.getPRComments().then((c) => {
            setPrComments(c.comments ? (c.comments as PRComment[]) : []);
          });
        } else {
          setChecks([]);
          setPrComments([]);
        }
      })
      .catch((e) => console.error(new Error("Failed to fetch PR", { cause: e })));
  }, []);

  useEffect(() => {
    api
      .getStatus()
      .then((s) => {
        setBranch(s.branch);
        setHasTerminal(s.terminalSurface !== null);
        if (s.actions) setActions(s.actions);
        setHasPlan(s.hasPlan);
      })
      .catch(() => {});
    fetchPR();
  }, [fetchPR]);

  const refreshAll = useCallback(() => {
    refresh();
    api
      .getStatus()
      .then((s) => setBranch(s.branch))
      .catch((e) => console.error(new Error("Failed to fetch branch status", { cause: e })));
    fetchPR();
  }, [refresh, fetchPR]);

  const handleWSMessage = useCallback(
    (msg: { type: string; data?: unknown }) => {
      if (msg.type === "diff-updated") {
        refreshAll();
      }
      if (msg.type === "pr-updated" && msg.data) {
        const data = msg.data as {
          pr?: PR;
          checks?: Check[];
          comments?: PRComment[];
        };
        if (data.pr?.url) setPrUrl(data.pr.url);
        if (data.pr?.title) setPrTitle(data.pr.title);
        if (data.pr?.state) setPrState(data.pr.state);
        if (data.checks) setChecks(data.checks);
        if (data.comments) setPrComments(data.comments);
      }
    },
    [refreshAll],
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
        onRefresh={refreshAll}
        hasTerminal={hasTerminal}
        actions={actions}
        onShowDiff={() => {
          navigate("/");
          clearCommit();
        }}
        onShowCommitList={() => navigate("/commits")}
        onShowPlan={hasPlan ? () => navigate("/plan") : undefined}
      />
      <div
        className={`flex-1 overflow-auto p-4 transition-opacity duration-200 ${refreshing ? "opacity-60" : "opacity-100"}`}
      >
        {route.page === "plan" ? (
          <PlanView onBack={() => navigate("/")} hasTerminal={hasTerminal} />
        ) : (
          <>
            {(checks.length > 0 || prUrl) && (
              <div className="mb-4">
                <CIStatus checks={checks} prTitle={prTitle} prUrl={prUrl} prState={prState} />
              </div>
            )}
            <DiffView
              diff={diff}
              loading={loading}
              error={error}
              onRefresh={refreshAll}
              hasTerminal={hasTerminal}
              selectedCommit={selectedCommit}
              showCommitList={route.page === "commits"}
              hasUncommittedChanges={hasUncommittedChanges}
              prComments={prComments.filter((c) => !c.isResolved)}
              onSelectCommit={(commit) => {
                navigate(`/commit/${commit.hash}`);
                selectCommit(commit);
              }}
              onClearCommit={() => {
                navigate("/");
                clearCommit();
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
