/**
 * Project registry for hub mode.
 *
 * Sessions (any harness) register a project directory via the HTTP API;
 * the registry keeps one service bundle (git, github, watcher, actions)
 * per project. Entries linger as "inactive" after the session ends so the
 * diff can still be reviewed, and are pruned after LINGER_MS or on manual
 * dismiss. Metadata is persisted so a hub restart keeps the list.
 */
import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createGitService, type CommandRunner, type GitService } from "./git.ts";
import { createGitHubService, type GitHubService } from "./github.ts";
import { createFileWatcher, type FileWatcher, type WatcherFactory } from "./watcher.ts";
import type { ChangeEvent } from "./watcher.ts";
import { DEFAULT_ACTIONS, validateActions, type MenuItem } from "./actions.ts";
import { logger } from "./logger.ts";

export type ProjectStatus = "active" | "inactive";

export type ProjectInfo = {
  id: string;
  cwd: string;
  name: string;
  status: ProjectStatus;
  harness?: string;
  surfaceId?: string;
  registeredAt: number;
  lastSeenAt: number;
};

export type ProjectEntry = {
  info: ProjectInfo;
  git: GitService;
  github: GitHubService;
  watcher: FileWatcher | null;
  actions: MenuItem[];
};

export type ProjectSummary = ProjectInfo & {
  branch: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  pr: { number: number; title: string; state: string; url: string } | null;
};

export type ProjectRegistry = ReturnType<typeof createProjectRegistry>;

/** How long inactive projects stay in the list before being pruned */
const LINGER_MS = 24 * 60 * 60 * 1000;

export function defaultPersistPath(): string {
  return path.join(os.homedir(), ".config", "cmux-hub", "projects.json");
}

export function projectIdForCwd(cwd: string): string {
  return Bun.hash(cwd).toString(36);
}

type RegistryDeps = {
  runner: CommandRunner;
  watcherFactory: WatcherFactory;
  /** Hub-level fallback actions (from --actions) */
  hubActions?: MenuItem[];
  /** JSON file for persisting project metadata across hub restarts */
  persistPath?: string;
  /** Called when a project's working tree / refs change */
  onDiffChanged?: (projectId: string, event: ChangeEvent) => void;
  /** Called when the project list itself changes (register/unregister/dismiss) */
  onProjectsChanged?: () => void;
};

async function loadProjectActions(
  cwd: string,
  hubActions: MenuItem[] | undefined,
): Promise<MenuItem[]> {
  // Project-local config wins, then hub-level --actions, then defaults
  const candidates = [
    path.join(cwd, ".claude", "cmux-hub.json"),
    path.join(cwd, ".cmux-hub", "actions.json"),
  ];
  for (const candidate of candidates) {
    try {
      const file = Bun.file(candidate);
      if (await file.exists()) {
        return validateActions(JSON.parse(await file.text()));
      }
    } catch (e) {
      logger.info("Invalid actions file, ignoring:", candidate, e instanceof Error ? e.message : e);
    }
  }
  return hubActions ?? DEFAULT_ACTIONS;
}

export function createProjectRegistry(deps: RegistryDeps) {
  const entries = new Map<string, ProjectEntry>();
  const persistPath = deps.persistPath ?? defaultPersistPath();
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  function persist() {
    try {
      mkdirSync(path.dirname(persistPath), { recursive: true });
      const infos = [...entries.values()].map((e) => e.info);
      writeFileSync(persistPath, JSON.stringify(infos, null, 2) + "\n");
    } catch (e) {
      logger.info("Failed to persist projects:", e instanceof Error ? e.message : e);
    }
  }

  function startWatcher(entry: ProjectEntry) {
    if (entry.watcher) return;
    const watcher = createFileWatcher(deps.watcherFactory, entry.info.cwd);
    watcher.onChanged((event) => {
      deps.onDiffChanged?.(entry.info.id, event);
    });
    watcher.start();
    entry.watcher = watcher;
  }

  function stopWatcher(entry: ProjectEntry) {
    entry.watcher?.stop();
    entry.watcher = null;
  }

  async function createEntry(info: ProjectInfo): Promise<ProjectEntry> {
    const entry: ProjectEntry = {
      info,
      git: createGitService(deps.runner, info.cwd),
      github: createGitHubService(deps.runner, info.cwd),
      watcher: null,
      actions: await loadProjectActions(info.cwd, deps.hubActions),
    };
    entries.set(info.id, entry);
    if (info.status === "active") startWatcher(entry);
    return entry;
  }

  async function isGitRepo(cwd: string): Promise<boolean> {
    try {
      await deps.runner(["git", "rev-parse", "--is-inside-work-tree"], { cwd });
      return true;
    } catch {
      return false;
    }
  }

  function prune(now = Date.now()) {
    let changed = false;
    for (const [id, entry] of entries) {
      if (entry.info.status === "inactive" && now - entry.info.lastSeenAt > LINGER_MS) {
        stopWatcher(entry);
        entries.delete(id);
        changed = true;
        logger.debug("registry: pruned inactive project", entry.info.cwd);
      }
    }
    if (changed) {
      persist();
      deps.onProjectsChanged?.();
    }
  }

  return {
    async load() {
      try {
        if (!existsSync(persistPath)) return;
        const infos = JSON.parse(readFileSync(persistPath, "utf-8")) as ProjectInfo[];
        for (const info of infos) {
          if (!info?.cwd || !existsSync(info.cwd)) continue;
          if (!(await isGitRepo(info.cwd))) continue;
          await createEntry({ ...info, id: projectIdForCwd(info.cwd) });
        }
        logger.info("registry: loaded", entries.size, "projects from", persistPath);
      } catch (e) {
        logger.info("Failed to load projects:", e instanceof Error ? e.message : e);
      }
    },

    async register(input: {
      cwd: string;
      name?: string;
      harness?: string;
      surfaceId?: string;
    }): Promise<ProjectEntry> {
      const cwd = path.resolve(input.cwd);
      if (!existsSync(cwd)) throw new Error("Directory does not exist: " + cwd);
      if (!(await isGitRepo(cwd))) throw new Error("Not a git repository: " + cwd);

      const id = projectIdForCwd(cwd);
      const now = Date.now();
      let entry = entries.get(id);
      if (entry) {
        entry.info.status = "active";
        entry.info.lastSeenAt = now;
        if (input.name) entry.info.name = input.name;
        if (input.harness) entry.info.harness = input.harness;
        // Re-registration always overwrites the surface — a new session may
        // run in a different terminal (or none at all)
        entry.info.surfaceId = input.surfaceId;
        // Reload actions so config edits are picked up on new sessions
        entry.actions = await loadProjectActions(cwd, deps.hubActions);
        startWatcher(entry);
      } else {
        entry = await createEntry({
          id,
          cwd,
          name: input.name ?? path.basename(cwd),
          status: "active",
          harness: input.harness,
          surfaceId: input.surfaceId,
          registeredAt: now,
          lastSeenAt: now,
        });
      }
      persist();
      deps.onProjectsChanged?.();
      logger.info("registry: registered", cwd, "as", id);
      return entry;
    },

    unregister(idOrCwd: string): boolean {
      const entry = this.resolve(idOrCwd);
      if (!entry) return false;
      entry.info.status = "inactive";
      entry.info.lastSeenAt = Date.now();
      stopWatcher(entry);
      persist();
      deps.onProjectsChanged?.();
      logger.info("registry: unregistered", entry.info.cwd);
      return true;
    },

    heartbeat(idOrCwd: string): boolean {
      const entry = this.resolve(idOrCwd);
      if (!entry) return false;
      entry.info.lastSeenAt = Date.now();
      return true;
    },

    dismiss(idOrCwd: string): boolean {
      const entry = this.resolve(idOrCwd);
      if (!entry) return false;
      stopWatcher(entry);
      entries.delete(entry.info.id);
      persist();
      deps.onProjectsChanged?.();
      logger.info("registry: dismissed", entry.info.cwd);
      return true;
    },

    get(id: string): ProjectEntry | undefined {
      return entries.get(id);
    },

    /** Find an entry by project id or by (resolved) directory path */
    resolve(idOrCwd: string): ProjectEntry | undefined {
      const byId = entries.get(idOrCwd);
      if (byId) return byId;
      return entries.get(projectIdForCwd(path.resolve(idOrCwd)));
    },

    all(): ProjectEntry[] {
      return [...entries.values()];
    },

    active(): ProjectEntry[] {
      return [...entries.values()].filter((e) => e.info.status === "active");
    },

    /**
     * Build the project list with branch + diff stats. PR info is filled in
     * by the caller (app-level PR cache) to keep polling in one place.
     */
    async summaries(prLookup?: (id: string) => ProjectSummary["pr"]): Promise<ProjectSummary[]> {
      const list = await Promise.all(
        [...entries.values()].map(async (entry) => {
          let branch = "";
          let stat = { filesChanged: 0, additions: 0, deletions: 0 };
          try {
            [branch, stat] = await Promise.all([
              entry.git.getCurrentBranch(),
              entry.git.getAutoDiffStat(),
            ]);
          } catch (e) {
            logger.debug("registry: summary failed for", entry.info.cwd, e);
          }
          return {
            ...entry.info,
            branch,
            ...stat,
            pr: prLookup?.(entry.info.id) ?? null,
          };
        }),
      );
      // Active first, then most recently seen
      return list.sort((a, b) => {
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        return b.lastSeenAt - a.lastSeenAt;
      });
    },

    startPruning() {
      if (pruneTimer) return;
      prune();
      pruneTimer = setInterval(() => prune(), 60 * 60 * 1000);
    },

    stop() {
      if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = null;
      }
      for (const entry of entries.values()) {
        stopWatcher(entry);
      }
    },
  };
}
