import React, { useState, useRef, useEffect } from "react";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { api } from "../lib/api.ts";
import type { MenuItem, ActionItem } from "../../server/actions.ts";
import { isSubmenu, isActionWithInput } from "../../server/actions.ts";
import { useReviewQueue } from "../hooks/useReviewQueue.tsx";

type Props = {
  branch: string;
  hasTerminal: boolean;
  actions: MenuItem[];
  onShowCommitList?: () => void;
  onShowPlan?: () => void;
  onShowReview?: () => void;
  onShowDiff?: () => void;
};

function SimpleActionButton({
  id,
  action,
  disabled,
  onSending,
  className,
}: {
  id: string;
  action: ActionItem;
  disabled: boolean;
  onSending: (sending: boolean) => void;
  className?: string;
}) {
  const handleExecute = async () => {
    onSending(true);
    try {
      await api.executeAction(id);
    } catch (e) {
      console.error("Action failed:", e);
    } finally {
      onSending(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleExecute}
      disabled={disabled}
      className={className}
    >
      {action.label}
    </Button>
  );
}

function SubmenuButton({
  label,
  items,
  baseId,
  disabled,
  onSending,
}: {
  label: string;
  items: ActionItem[];
  baseId: string;
  disabled: boolean;
  onSending: (sending: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
        {label} ▾
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-[#21262d] border border-[#30363d] rounded-md shadow-lg z-50 min-w-[160px] flex flex-col">
          {items.map((item, i) => (
            <SimpleActionButton
              key={item.label}
              id={`${baseId}.${i}`}
              action={item}
              disabled={disabled}
              onSending={onSending}
              className="w-full justify-start"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InputRow({
  id,
  action,
  sending,
  onSending,
  onClose,
}: {
  id: string;
  action: ActionItem;
  sending: boolean;
  onSending: (s: boolean) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");

  const handleExecute = async () => {
    if (!value.trim() || !action.input) return;
    onSending(true);
    try {
      await api.executeAction(id, { [action.input.variable]: value });
      setValue("");
      onClose();
    } catch (e) {
      console.error("Action failed:", e);
    } finally {
      onSending(false);
    }
  };

  const canSubmit = !sending && !!value.trim();

  return (
    <div className="flex items-center gap-2 mt-2">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={action.input?.placeholder ?? ""}
        className="flex-1 bg-gray-800 border-gray-700 text-gray-200"
        onKeyDown={(e) => {
          if (e.key === "Enter") handleExecute();
          if (e.key === "Escape") onClose();
        }}
        autoFocus
      />
      <Button size="sm" onClick={handleExecute} disabled={!canSubmit}>
        Send
      </Button>
    </div>
  );
}

export function Toolbar({
  branch,
  hasTerminal,
  actions,
  onShowCommitList,
  onShowPlan,
  onShowReview,
  onShowDiff,
}: Props) {
  const [sending, setSending] = useState(false);
  const [activeInput, setActiveInput] = useState<string | null>(null);
  const { pending, submitReview, submitting: submittingReview, clearQueue } = useReviewQueue();

  return (
    <div
      data-testid="toolbar"
      className="border-b border-[#30363d] bg-[#161b22] px-4 py-2 flex-shrink-0 z-20"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <button
            className="text-[#58a6ff] hover:text-[#79c0ff] text-sm font-mono leading-none"
            onClick={onShowDiff}
          >
            {branch}
          </button>
          {onShowCommitList && (
            <>
              <span className="text-[#30363d]">/</span>
              <button
                className="text-[#848d97] hover:text-[#c9d1d9] text-sm leading-none"
                onClick={onShowCommitList}
              >
                Commits
              </button>
            </>
          )}
          {onShowPlan && (
            <>
              <span className="text-[#30363d]">/</span>
              <button
                className="text-[#848d97] hover:text-[#c9d1d9] text-sm leading-none"
                onClick={onShowPlan}
              >
                Plan
              </button>
            </>
          )}
          {onShowReview && (
            <>
              <span className="text-[#30363d]">/</span>
              <button
                className="text-[#848d97] hover:text-[#c9d1d9] text-sm leading-none"
                onClick={onShowReview}
              >
                Review
              </button>
            </>
          )}
        </div>
        <div className="flex-1" />
        {hasTerminal && pending.length > 0 && (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              disabled={submittingReview}
              onClick={submitReview}
              className="bg-[#d29922] hover:bg-[#bb8a1e] text-black"
            >
              {submittingReview ? "Sending..." : `Finish review (${pending.length})`}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearQueue}
              title="Discard all pending comments"
            >
              Discard
            </Button>
          </div>
        )}
        {hasTerminal &&
          actions.map((item, i) => {
            const id = String(i);
            if (isSubmenu(item)) {
              return (
                <SubmenuButton
                  key={item.label}
                  label={item.label}
                  items={item.submenu}
                  baseId={id}
                  disabled={sending}
                  onSending={setSending}
                />
              );
            }
            if (isActionWithInput(item)) {
              return (
                <Button
                  key={item.label}
                  variant="ghost"
                  size="sm"
                  onClick={() => setActiveInput(activeInput === id ? null : id)}
                >
                  {item.label}
                </Button>
              );
            }
            return (
              <SimpleActionButton
                key={item.label}
                id={id}
                action={item}
                disabled={sending}
                onSending={setSending}
              />
            );
          })}
      </div>

      {hasTerminal &&
        actions.map((item, i) => {
          const id = String(i);
          if (!isActionWithInput(item)) return null;
          if (activeInput !== id) return null;
          return (
            <InputRow
              key={item.label}
              id={id}
              action={item}
              sending={sending}
              onSending={setSending}
              onClose={() => setActiveInput(null)}
            />
          );
        })}
    </div>
  );
}
