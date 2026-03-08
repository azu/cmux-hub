import { useEffect, useCallback, useActionState, useTransition, startTransition } from "react";
import { api } from "../lib/api.ts";
import { parseDiff, type ParsedDiff } from "../lib/diff-parser.ts";

export type SelectedCommit = { hash: string; message: string; relativeDate: string };

type CommitViewState = {
  diff: ParsedDiff;
  rawDiff: string;
  commit: SelectedCommit | null;
  error: string | null;
};

type AutoDiffState = {
  diff: ParsedDiff;
  rawDiff: string;
  base: string | null;
  error: string | null;
};

const initialCommitView: CommitViewState = { diff: [], rawDiff: "", commit: null, error: null };
const initialAutoDiff: AutoDiffState = { diff: [], rawDiff: "", base: null, error: null };

export function useDiff() {
  const [autoDiff, dispatchAutoDiff, isAutoLoading] = useActionState(
    async (_prev: AutoDiffState, _action: void): Promise<AutoDiffState> => {
      try {
        const result = await api.getAutoDiff();
        return {
          diff: result.files ?? parseDiff(result.diff),
          rawDiff: result.diff,
          base: result.base,
          error: null,
        };
      } catch (e) {
        return {
          ..._prev,
          error: e instanceof Error ? e.message : "Failed to fetch diff",
        };
      }
    },
    initialAutoDiff,
  );

  const [commitView, dispatchCommitView, isCommitLoading] = useActionState(
    async (_prev: CommitViewState, action: SelectedCommit | null): Promise<CommitViewState> => {
      if (!action) return initialCommitView;
      try {
        const result = await api.getCommitDiff(action.hash);
        return {
          diff: result.files ?? parseDiff(result.diff),
          rawDiff: result.diff,
          commit: action,
          error: null,
        };
      } catch (e) {
        return {
          diff: [],
          rawDiff: "",
          commit: action,
          error: e instanceof Error ? e.message : "Failed to fetch commit diff",
        };
      }
    },
    initialCommitView,
  );

  const fetchDiff = useCallback(() => {
    startTransition(() => dispatchAutoDiff());
  }, [dispatchAutoDiff]);

  const selectCommit = useCallback(
    (commit: SelectedCommit) => {
      startTransition(() => dispatchCommitView(commit));
    },
    [dispatchCommitView],
  );

  const clearCommit = useCallback(() => {
    startTransition(() => dispatchCommitView(null));
    fetchDiff();
  }, [dispatchCommitView, fetchDiff]);

  useEffect(() => {
    fetchDiff();
  }, [fetchDiff]);

  // Listen for diff-updated WebSocket events
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent).detail as { type: string };
      if (msg.type === "diff-updated") {
        fetchDiff();
      }
    };
    window.addEventListener("ws-message", handler);
    return () => window.removeEventListener("ws-message", handler);
  }, [fetchDiff]);

  // When a commit is selected, use commitView state; otherwise auto-diff state
  const isCommitSelected = commitView.commit !== null;

  return {
    diff: isCommitSelected ? commitView.diff : autoDiff.diff,
    rawDiff: isCommitSelected ? commitView.rawDiff : autoDiff.rawDiff,
    loading: isAutoLoading || isCommitLoading,
    refreshing: isAutoLoading,
    error: isCommitSelected ? commitView.error : autoDiff.error,
    base: autoDiff.base,
    selectedCommit: commitView.commit,
    hasUncommittedChanges: autoDiff.diff.length > 0,
    refresh: fetchDiff,
    selectCommit,
    clearCommit,
  };
}
