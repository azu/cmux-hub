import React, { useState } from "react";
import { Button } from "./ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { api } from "../lib/api.ts";
import type { LauncherServer } from "../hooks/useLauncher.ts";

type Props = {
  servers: LauncherServer[];
};

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-500",
  starting: "bg-yellow-500 animate-pulse",
  error: "bg-red-500",
  stopped: "bg-gray-500",
};

export function LauncherStatus({ servers }: Props) {
  const [selectedName, setSelectedName] = useState<string>(servers[0]?.name ?? "");
  const [busy, setBusy] = useState(false);

  const selected = servers.find((s) => s.name === selectedName) ?? servers[0];
  if (!selected) return null;

  async function handleAction(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      console.error("Launcher action failed:", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-[#161b22] border-b border-[#30363d]">
      <span className="text-xs text-[#8b949e] mr-1">Preview</span>

      {servers.length > 1 ? (
        <Select value={selectedName} onValueChange={setSelectedName}>
          <SelectTrigger size="sm" className="h-6 text-xs min-w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s) => (
              <SelectItem key={s.name} value={s.name}>
                <span className="flex items-center gap-1.5">
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full ${STATUS_COLORS[s.status] ?? STATUS_COLORS.stopped}`}
                  />
                  {s.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="flex items-center gap-1.5 text-xs">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${STATUS_COLORS[selected.status] ?? STATUS_COLORS.stopped}`}
          />
          {selected.name}
        </span>
      )}

      <span className="text-xs text-[#8b949e]">:{selected.port}</span>

      {selected.status === "running" && (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={busy}
            onClick={() => handleAction(() => api.launcherPreview(selected.name))}
          >
            Preview
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={busy}
            onClick={() => handleAction(() => api.launcherRestart(selected.name))}
          >
            Restart
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={busy}
            onClick={() => handleAction(() => api.launcherStop(selected.name))}
          >
            Stop
          </Button>
        </>
      )}

      {(selected.status === "stopped" || selected.status === "error") && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={busy}
          onClick={() => handleAction(() => api.launcherStart(selected.name))}
        >
          Start
        </Button>
      )}

      {selected.status === "error" && selected.error && (
        <span className="text-xs text-red-400 truncate max-w-[200px]" title={selected.error}>
          {selected.error}
        </span>
      )}

      {selected.status === "starting" && (
        <span className="text-xs text-yellow-400">Starting...</span>
      )}
    </div>
  );
}
