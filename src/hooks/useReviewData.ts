import { api } from "../lib/api.ts";
import { useWSFetch } from "./useWSFetch.ts";

export function useReviewData() {
  const { data, loading, error, isPending, refetch } = useWSFetch({
    fetch: () => api.getReview(),
    wsMessageType: "review-updated",
  });

  return {
    files: data?.found ? (data.files ?? []) : [],
    reviewDirs: data?.reviewDirs ?? [],
    loading,
    error:
      !loading && data && !data.found
        ? "No review files yet. Write markdown files into the review directory."
        : error,
    isPending,
    refetch,
  };
}
