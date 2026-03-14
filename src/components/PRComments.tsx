import React, { useCallback, useState } from "react";
import { api } from "../lib/api.ts";

type Comment = {
  id: number;
  body: string;
  bodyHtml: string;
  user: string;
  path: string;
  line: number;
  createdAt: string;
};

type Props = {
  comment: Comment;
  filePath: string;
};

export function InlinePRComment({ comment, filePath }: Props) {
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    setSending(true);
    try {
      const text = `${filePath}:${comment.line}\n${comment.body}`;
      await api.sendToTerminal(text);
    } catch (e) {
      console.error("Failed to send comment to terminal:", e);
    } finally {
      setSending(false);
    }
  }, [comment, filePath]);

  return (
    <div className="flex items-start gap-2 py-1 text-sm">
      <div className="flex-1 min-w-0">
        <span className="text-[#58a6ff] font-medium">@{comment.user}</span>
        <div
          className="text-[#848d97] ml-2 markdown-body"
          dangerouslySetInnerHTML={{ __html: comment.bodyHtml }}
        />
      </div>
      <button
        onClick={handleSend}
        disabled={sending}
        className="flex-shrink-0 text-xs text-[#58a6ff] hover:text-[#79c0ff] px-2 py-0.5 border border-[#30363d] rounded hover:border-[#58a6ff] disabled:opacity-50"
        title="Send to terminal"
      >
        {sending ? "..." : "Send"}
      </button>
    </div>
  );
}
