import React, { useState, useRef, useEffect } from "react";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { api } from "../lib/api.ts";
import { handleDelivery } from "../lib/delivery.ts";
import type { MenuItem, ActionItem } from "../../server/actions.ts";
import { isSubmenu, isActionWithInput } from "../../server/actions.ts";
import { useReviewQueue } from "../hooks/useReviewQueue.tsx";
import { useToast } from "./Toast.tsx";

type Props = {
  branch: string;
  projectName?: string | null;
  projectStatus?: "active" | "inactive" | null;
  hasTerminal: boolean;
  actions: MenuItem[];
  prUrl?: string | null;
  prState?: string | null;
  onShowProjects?: () => void;
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
  const { showToast } = useToast();
  const handleExecute = async () => {
    onSending(true);
    try {
      const result = await api.executeAction(id);
      await handleDelivery(result, showToast);
    } catch (e) {
      console.error("Action failed:", e);
      showToast(e instanceof Error ? e.message : "Action failed");
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
  const { showToast } = useToast();

  const handleExecute = async () => {
    if (!value.trim() || !action.input) return;
    onSending(true);
    try {
      const result = await api.executeAction(id, { [action.input.variable]: value });
      await handleDelivery(result, showToast);
      setValue("");
      onClose();
    } catch (e) {
      console.error("Action failed:", e);
      showToast(e instanceof Error ? e.message : "Action failed");
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

function prStateColor(state: string): string {
  if (state === "MERGED") return "text-[#a371f7] border-[#a371f7]/40";
  if (state === "CLOSED") return "text-[#f85149] border-[#f85149]/40";
  return "text-[#3fb950] border-[#3fb950]/40";
}

export function Toolbar({
  branch,
  projectName,
  projectStatus,
  hasTerminal,
  actions,
  prUrl,
  prState,
  onShowProjects,
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
          {onShowProjects && (
            <>
              <button
                className="text-[#848d97] hover:text-[#c9d1d9] text-sm leading-none"
                onClick={onShowProjects}
                title="Back to project list"
              >
                ‹ Projects
              </button>
              <span className="text-[#30363d]">/</span>
            </>
          )}
          {projectName && (
            <span className="text-[#c9d1d9] text-sm font-medium leading-none flex items-center gap-1.5">
              {projectStatus && (
                <span
                  className={`w-1.5 h-1.5 rounded-full inline-block ${
                    projectStatus === "active" ? "bg-[#3fb950]" : "bg-[#848d97]"
                  }`}
                  title={projectStatus === "active" ? "Active session" : "Session ended"}
                />
              )}
              {projectName}
              <span className="text-[#30363d]">/</span>
            </span>
          )}
          <button
            className="text-[#58a6ff] hover:text-[#79c0ff] text-sm font-mono leading-none"
            onClick={onShowDiff}
          >
            {branch}
          </button>
          {prUrl && prState && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-xs border rounded-full px-2 py-0.5 ml-1 hover:underline ${prStateColor(prState)}`}
              title="Open pull request on GitHub"
            >
              PR · {prState.toLowerCase()}
            </a>
          )}
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
        {pending.length > 0 && (
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
        {actions.map((item, i) => {
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
        {!hasTerminal && actions.length > 0 && (
          <span
            className="text-[#848d97] text-xs"
            title="No terminal connected — actions and comments are copied to the clipboard"
          >
            📋
          </span>
        )}
      </div>

      {actions.map((item, i) => {
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
