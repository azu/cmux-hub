import React from "react";
import { DiffView } from "./components/DiffView.tsx";
import { Toolbar } from "./components/Toolbar.tsx";
import { CIStatus } from "./components/CIStatus.tsx";
import { PlanView } from "./components/PlanView.tsx";
import { ReviewView } from "./components/ReviewView.tsx";
import { LauncherStatus } from "./components/LauncherStatus.tsx";
import { ProjectList } from "./components/ProjectList.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { useDiff } from "./hooks/useDiff.ts";
import { useWebSocket } from "./hooks/useWebSocket.ts";
import { useHashRoute } from "./hooks/useHashRoute.ts";
import { useStatus } from "./hooks/useStatus.ts";
import { usePRData } from "./hooks/usePRData.ts";
import { useLauncher } from "./hooks/useLauncher.ts";
import { ReviewQueueProvider } from "./hooks/useReviewQueue.tsx";
import "./index.css";

type RouteInfo = ReturnType<typeof useHashRoute>["route"];

function ProjectWorkspace({
  route,
  navigate,
  hubMode,
}: {
  route: RouteInfo;
  navigate: (path: string) => void;
  hubMode: boolean;
}) {
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
  const { branch, projectName, projectStatus, hasTerminal, actions, hasPlan, hasReview } =
    useStatus();
  const { prUrl, prTitle, prState, checks, prComments } = usePRData();
  const { hasLauncher, servers } = useLauncher();

  // Build hash paths, prefixed with the project in hub mode
  const projectPath = (sub: string) =>
    route.project ? `/p/${route.project}${sub ? `/${sub}` : ""}` : `/${sub}`;

  return (
    <ReviewQueueProvider>
      <div className="h-screen max-w-full overflow-hidden bg-[#0d1117] text-[#c9d1d9] flex flex-col">
        {refreshing && (
          <div className="fixed top-0 left-0 right-0 z-50 h-0.5 bg-[#1a1e24] overflow-hidden">
            <div className="h-full bg-[#58a6ff] animate-progress-bar" />
          </div>
        )}
        <Toolbar
          branch={branch}
          projectName={projectName}
          projectStatus={projectStatus}
          hasTerminal={hasTerminal}
          actions={actions}
          prUrl={prUrl}
          prState={prState}
          onShowProjects={hubMode ? () => navigate("/") : undefined}
          onShowDiff={() => {
            navigate(projectPath(""));
            clearCommit();
          }}
          onShowCommitList={() => navigate(projectPath("commits"))}
          onShowPlan={hasPlan ? () => navigate(projectPath("plan")) : undefined}
          onShowReview={hasReview ? () => navigate(projectPath("review")) : undefined}
        />
        {hasLauncher && servers.length > 0 && <LauncherStatus servers={servers} />}
        <div
          className={`flex-1 overflow-auto px-4 pb-4 transition-opacity duration-200 ${refreshing ? "opacity-60" : "opacity-100"}`}
        >
          {route.page === "plan" ? (
            <div className="pt-4">
              <PlanView onBack={() => navigate(projectPath(""))} hasTerminal={hasTerminal} />
            </div>
          ) : route.page === "review" ? (
            <div className="pt-4">
              <ReviewView onBack={() => navigate(projectPath(""))} hasTerminal={hasTerminal} />
            </div>
          ) : (
            <>
              {(checks.length > 0 || prUrl) && (
                <div className="mt-4 mb-4">
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
                  navigate(projectPath(`commit/${commit.hash}`));
                  selectCommit(commit);
                }}
                onClearCommit={() => {
                  navigate(projectPath(""));
                  clearCommit();
                }}
              />
            </>
          )}
        </div>
      </div>
    </ReviewQueueProvider>
  );
}

export default function App() {
  const { route, navigate } = useHashRoute();
  const { hubMode, loading } = useStatus();

  // Establish WebSocket connection (individual hooks subscribe via ws-message events)
  useWebSocket(() => {});

  // Hub mode home: project list. Single mode home: the diff workspace.
  if (route.page === "home" && (hubMode || loading)) {
    return (
      <ToastProvider>
        <div className="h-screen max-w-full overflow-auto bg-[#0d1117] text-[#c9d1d9] px-4 pb-4">
          {loading ? (
            <div className="flex items-center justify-center h-64 text-gray-500">Loading...</div>
          ) : (
            <ProjectList onSelectProject={(id) => navigate(`/p/${id}`)} />
          )}
        </div>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <ProjectWorkspace
        key={route.project ?? "single"}
        route={route}
        navigate={navigate}
        hubMode={hubMode}
      />
    </ToastProvider>
  );
}
