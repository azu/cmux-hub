import React, { useState, useCallback, useActionState, createContext, useContext } from "react";
import { api } from "../lib/api.ts";
import { handleDelivery } from "../lib/delivery.ts";
import { useToast } from "../components/Toast.tsx";

export type PendingComment = {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  comment: string;
};

type ReviewQueueContextValue = {
  pending: PendingComment[];
  addToReview: (item: Omit<PendingComment, "id">) => void;
  updatePending: (id: string, comment: string) => void;
  removePending: (id: string) => void;
  clearQueue: () => void;
  submitReview: () => void;
  submitting: boolean;
};

const ReviewQueueContext = createContext<ReviewQueueContextValue | null>(null);

function formatRange(file: string, startLine: number, endLine: number): string {
  if (startLine === 0 && endLine === 0) return file;
  const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  return `${file}:${range}`;
}

export function ReviewQueueProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingComment[]>([]);
  const { showToast } = useToast();

  const addToReview = useCallback((item: Omit<PendingComment, "id">) => {
    setPending((prev) => [...prev, { ...item, id: crypto.randomUUID() }]);
  }, []);

  const updatePending = useCallback((id: string, comment: string) => {
    setPending((prev) => prev.map((p) => (p.id === id ? { ...p, comment } : p)));
  }, []);

  const removePending = useCallback((id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const clearQueue = useCallback(() => setPending([]), []);

  const [, submitReview, submitting] = useActionState(async () => {
    const items = pending;
    if (items.length === 0) return;
    const text = items
      .map((p) => `${formatRange(p.file, p.startLine, p.endLine)} ${p.comment}`)
      .join("\n");
    const result = await api.sendToTerminal(text + "\n");
    await handleDelivery(result, showToast);
    clearQueue();
  }, undefined);

  return (
    <ReviewQueueContext.Provider
      value={{
        pending,
        addToReview,
        updatePending,
        removePending,
        clearQueue,
        submitReview,
        submitting,
      }}
    >
      {children}
    </ReviewQueueContext.Provider>
  );
}

export function useReviewQueue(): ReviewQueueContextValue {
  const ctx = useContext(ReviewQueueContext);
  if (!ctx) throw new Error("useReviewQueue must be used within ReviewQueueProvider");
  return ctx;
}
