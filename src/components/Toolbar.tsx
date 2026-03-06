import React, { useState } from "react";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { api } from "../lib/api.ts";

type Props = {
  branch: string;
  onRefresh: () => void;
};

export function Toolbar({ branch, onRefresh }: Props) {
  const [commitMsg, setCommitMsg] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [showCommit, setShowCommit] = useState(false);
  const [showPR, setShowPR] = useState(false);
  const [sending, setSending] = useState(false);

  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    setSending(true);
    try {
      await api.commit(commitMsg);
      setCommitMsg("");
      setShowCommit(false);
    } catch (e) {
      console.error("Failed to commit:", e);
    } finally {
      setSending(false);
    }
  };

  const handleCreatePR = async () => {
    if (!prTitle.trim()) return;
    setSending(true);
    try {
      await api.createPR(prTitle);
      setPrTitle("");
      setShowPR(false);
    } catch (e) {
      console.error("Failed to create PR:", e);
    } finally {
      setSending(false);
    }
  };

  const handleReview = async () => {
    setSending(true);
    try {
      await api.startReview();
    } catch (e) {
      console.error("Failed to start review:", e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-testid="toolbar" className="border-b border-gray-700 bg-gray-900 px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="text-gray-400 text-sm font-mono">{branch}</span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setShowCommit(!showCommit); setShowPR(false); }}
        >
          Commit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setShowPR(!showPR); setShowCommit(false); }}
        >
          Create PR
        </Button>
        <Button variant="ghost" size="sm" onClick={handleReview} disabled={sending}>
          AI Review
        </Button>
      </div>

      {showCommit && (
        <div className="flex items-center gap-2 mt-2">
          <Input
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Commit message..."
            className="flex-1 bg-gray-800 border-gray-700 text-gray-200"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCommit();
              if (e.key === "Escape") setShowCommit(false);
            }}
          />
          <Button size="sm" onClick={handleCommit} disabled={sending || !commitMsg.trim()}>
            Send
          </Button>
        </div>
      )}

      {showPR && (
        <div className="flex items-center gap-2 mt-2">
          <Input
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            placeholder="PR title..."
            className="flex-1 bg-gray-800 border-gray-700 text-gray-200"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreatePR();
              if (e.key === "Escape") setShowPR(false);
            }}
          />
          <Button size="sm" onClick={handleCreatePR} disabled={sending || !prTitle.trim()}>
            Create
          </Button>
        </div>
      )}
    </div>
  );
}
