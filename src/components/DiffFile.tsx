import React, { useState } from "react";
import type { DiffFile as DiffFileType } from "../lib/diff-parser.ts";
import { DiffLine } from "./DiffLine.tsx";

type Props = {
  file: DiffFileType;
  onComment: (file: string, line: number, comment: string) => void;
};

export function DiffFile({ file, onComment }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const badge = file.isNew
    ? "New"
    : file.isDeleted
      ? "Deleted"
      : file.isRenamed
        ? "Renamed"
        : null;

  const badgeColor = file.isNew
    ? "bg-green-700"
    : file.isDeleted
      ? "bg-red-700"
      : "bg-yellow-700";

  return (
    <div data-testid="diff-file" className="border border-gray-700 rounded-lg overflow-hidden mb-4">
      <div
        className="flex items-center gap-2 px-4 py-2 bg-gray-800 border-b border-gray-700 cursor-pointer hover:bg-gray-750"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="text-gray-500 select-none">{collapsed ? "+" : "-"}</span>
        <span className="text-gray-200 font-mono text-sm flex-1">{file.newPath}</span>
        {badge && (
          <span className={`${badgeColor} text-white text-xs px-2 py-0.5 rounded`}>
            {badge}
          </span>
        )}
      </div>
      {!collapsed && (
        <table className="w-full border-collapse">
          <tbody>
            {file.hunks.map((hunk, hunkIdx) => (
              <React.Fragment key={hunkIdx}>
                <tr className="bg-blue-950/20">
                  <td
                    colSpan={4}
                    className="text-blue-400 text-xs font-mono px-4 py-1"
                  >
                    {hunk.header}
                  </td>
                </tr>
                {hunk.lines.map((line, lineIdx) => (
                  <DiffLine
                    key={`${hunkIdx}-${lineIdx}`}
                    line={line}
                    filePath={file.newPath}
                    onComment={onComment}
                  />
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
