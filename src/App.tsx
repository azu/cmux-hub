import React, { useRef } from "react";
import { DiffView } from "./components/DiffView.tsx";
import { Toolbar } from "./components/Toolbar.tsx";
import { CIStatus } from "./components/CIStatus.tsx";
import { PlanView } from "./components/PlanView.tsx";
import { LauncherStatus } from "./components/LauncherStatus.tsx";
import { useDiff } from "./hooks/useDiff.ts";
import { useWebSocket } from "./hooks/useWebSocket.ts";
import { useHashRoute } from "./hooks/useHashRoute.ts";
import { useStatus } from "./hooks/useStatus.ts";
import { usePRData } from "./hooks/usePRData.ts";
import { useLauncher } from "./hooks/useLauncher.ts";
import "./index.css";

export const ScrollContainerContext = React.createContext<React.RefObject<HTMLDivElement | null>>({
  current: null,
});

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
  const { branch, hasTerminal, actions, hasPlan } = useStatus();
  const { prUrl, prTitle, prState, checks, prComments } = usePRData();
  const { hasLauncher, servers } = useLauncher();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Establish WebSocket connection (individual hooks subscribe via ws-message events)
  useWebSocket(() => {});

  return (
    <ScrollContainerContext.Provider value={scrollContainerRef}>
    <div className="min-h-screen max-w-full overflow-x-hidden bg-[#0d1117] text-[#c9d1d9] flex flex-col">
      {refreshing && (
        <div className="fixed top-0 left-0 right-0 z-50 h-0.5 bg-[#1a1e24] overflow-hidden">
          <div className="h-full bg-[#58a6ff] animate-progress-bar" />
        </div>
      )}
      <Toolbar
        branch={branch}
        hasTerminal={hasTerminal}
        actions={actions}
        onShowDiff={() => {
          navigate("/");
          clearCommit();
        }}
        onShowCommitList={() => navigate("/commits")}
        onShowPlan={hasPlan ? () => navigate("/plan") : undefined}
      />
      {hasLauncher && servers.length > 0 && <LauncherStatus servers={servers} />}
      <div
        ref={scrollContainerRef}
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
              onRefresh={refresh}
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
    </ScrollContainerContext.Provider>
  );
}
