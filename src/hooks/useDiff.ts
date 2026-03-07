import { useState, useEffect, useCallback, useActionState, startTransition } from "react";
import { api } from "../lib/api.ts";
import { parseDiff, type ParsedDiff } from "../lib/diff-parser.ts";

export type SelectedCommit = { hash: string; message: string };

type CommitViewState = {
  diff: ParsedDiff;
  rawDiff: string;
  commit: SelectedCommit | null;
  error: string | null;
};

const initialCommitView: CommitViewState = { diff: [], rawDiff: "", commit: null, error: null };

export function useDiff() {
  const [diff, setDiff] = useState<ParsedDiff>([]);
  const [rawDiff, setRawDiff] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const hasFetched = useState(false);

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

  const fetchDiff = useCallback(async () => {
    try {
      if (hasFetched[0]) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      startTransition(() => dispatchCommitView(null));
      const result = await api.getAutoDiff();
      setRawDiff(result.diff);
      setDiff(result.files ?? parseDiff(result.diff));
      setBase(result.base);
      hasFetched[0] = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch diff");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dispatchCommitView]);

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

  // When a commit is selected, use commitView state; otherwise auto-diff state
  const isCommitSelected = commitView.commit !== null;

  return {
    diff: isCommitSelected ? commitView.diff : diff,
    rawDiff: isCommitSelected ? commitView.rawDiff : rawDiff,
    loading: loading || isCommitLoading,
    refreshing,
    error: isCommitSelected ? commitView.error : error,
    base,
    selectedCommit: commitView.commit,
    refresh: fetchDiff,
    selectCommit,
    clearCommit,
  };
}
