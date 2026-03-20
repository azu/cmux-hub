import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CLAUDE_DIR = path.join(homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

function cwdToProjectKey(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

async function findJsonlsByMtime(
  projectDir: string,
  limit = 5,
): Promise<string[]> {
  const glob = new Bun.Glob("*.jsonl");
  const entries: { path: string; mtime: number }[] = [];

  for await (const entry of glob.scan({ cwd: projectDir })) {
    const fullPath = path.join(projectDir, entry);
    const stat = await Bun.file(fullPath).stat();
    entries.push({ path: fullPath, mtime: stat.mtime.getTime() });
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  return entries.slice(0, limit).map((e) => e.path);
}

/**
 * Extract plan file path from the latest session jsonl.
 * Reads from the end of file to find plan paths in trackedFileBackups,
 * falling back to slug-based path construction.
 */
async function extractPlanPath(jsonlPath: string): Promise<string | null> {
  const content = await Bun.file(jsonlPath).text();
  const lines = content.split("\n");

  // Search from the end for file-history-snapshot with plan path
  const planPathRegex = /"(\/[^"]*\/plans\/[^"]+\.md)"/;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line.includes("trackedFileBackups")) continue;
    const match = planPathRegex.exec(line);
    if (match?.[1]) return match[1];
  }

  // Fallback: extract slug and construct default path
  const slugRegex = /"slug":"([^"]+)"/;
  for (const line of lines) {
    if (!line) continue;
    const match = slugRegex.exec(line);
    if (match?.[1]) {
      const defaultPlansDir = path.join(CLAUDE_DIR, "plans");
      return path.join(defaultPlansDir, `${match[1]}.md`);
    }
  }

  return null;
}

export async function findPlanFile(cwd: string): Promise<string | null> {
  const projectKey = cwdToProjectKey(path.resolve(cwd));
  const projectDir = path.join(PROJECTS_DIR, projectKey);

  if (!existsSync(projectDir)) {
    return null;
  }

  const jsonlPaths = await findJsonlsByMtime(projectDir);
  for (const jsonlPath of jsonlPaths) {
    const planPath = await extractPlanPath(jsonlPath);
    if (planPath && (await Bun.file(planPath).exists())) {
      return planPath;
    }
  }

  return null;
}
