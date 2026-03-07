import React from "react";

type Check = {
  name: string;
  status: string;
  conclusion: string;
  url: string;
};

type Props = {
  checks: Check[];
  prTitle?: string | null;
  prUrl?: string | null;
};

function statusIcon(check: Check): string {
  if (check.conclusion === "SUCCESS") return "\u2705";
  if (check.conclusion === "FAILURE") return "\u274c";
  if (check.status === "IN_PROGRESS" || check.status === "QUEUED") return "\u23f3";
  return "\u2b55";
}

function statusColor(check: Check): string {
  if (check.conclusion === "SUCCESS") return "text-green-400";
  if (check.conclusion === "FAILURE") return "text-red-400";
  return "text-yellow-400";
}

export function CIStatus({ checks, prTitle, prUrl }: Props) {
  if (checks.length === 0 && !prUrl) return null;

  return (
    <div className="border border-[#30363d] rounded-lg p-3 mb-4">
      {prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#58a6ff] hover:text-[#79c0ff] text-sm font-medium block mb-2 hover:underline truncate"
        >
          {prTitle ?? "Pull Request"}
        </a>
      )}
      {checks.length > 0 && (
        <div className="space-y-1">
          {checks.map((check) => (
            <div key={check.name} className="flex items-center gap-2 text-sm">
              <span>{statusIcon(check)}</span>
              <a
                href={check.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`${statusColor(check)} hover:underline`}
              >
                {check.name}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
