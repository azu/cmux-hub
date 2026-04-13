import React, { useState } from "react";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/textarea.tsx";

type PendingCommentProps = {
  comment: string;
  onUpdate: (comment: string) => void;
  onDelete: () => void;
};

export function PendingComment({ comment, onUpdate, onDelete }: PendingCommentProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment);

  const handleSave = () => {
    if (draft.trim()) {
      onUpdate(draft.trim());
      setEditing(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleSave();
    }
    if (event.key === "Escape") {
      setDraft(comment);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <div className="space-y-1">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          className="min-h-[40px] bg-gray-800 border-gray-700 text-gray-200 text-sm"
          rows={2}
          autoFocus
        />
        <div className="flex gap-1 justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(comment);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!draft.trim()}>
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 py-1 text-sm">
      <span className="text-[#d29922] text-xs font-medium flex-shrink-0">Pending</span>
      <div className="flex-1 min-w-0 text-[#adbac7] whitespace-pre-wrap">{comment}</div>
      <div className="flex gap-1 flex-shrink-0">
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-[#848d97] hover:text-[#adbac7] px-1"
        >
          Edit
        </button>
        <button onClick={onDelete} className="text-xs text-[#848d97] hover:text-[#f85149] px-1">
          Delete
        </button>
      </div>
    </div>
  );
}
