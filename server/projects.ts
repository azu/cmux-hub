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
  /** When the project became inactive — anchor for the linger window */
  inactiveSince?: number;
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

/**
 * Active projects whose session never unregistered (crashed pane, hub down
 * at session end) are demoted to inactive after this long without a
 * register/heartbeat signal, so watchers and GitHub polling don't leak
 * forever. Long-lived sessions can refresh via POST /api/projects/heartbeat.
 */
const ACTIVE_TTL_MS = 24 * 60 * 60 * 1000;

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
  /**
   * Allow `type: "shell"` actions from project-local config files. Off by
   * default: a cloned repo's own .cmux-hub/actions.json must not be able to
   * run arbitrary commands on the hub server. Hub-level --actions (explicitly
   * user-provided) may always contain shell actions.
   */
  allowProjectShellActions?: boolean;
  /** Called when a project's working tree / refs change */
  onDiffChanged?: (projectId: string, event: ChangeEvent) => void;
  /** Called when the project list itself changes (register/unregister/dismiss) */
  onProjectsChanged?: () => void;
};

/** Drop shell-type actions from repo-provided config (they run on the server) */
function stripShellActions(items: MenuItem[], source: string): MenuItem[] {
  let stripped = 0;
  const result: MenuItem[] = [];
  for (const item of items) {
    if ("submenu" in item) {
      const submenu = item.submenu.filter((sub) => {
        if (sub.type === "shell") {
          stripped++;
          return false;
        }
        return true;
      });
      if (submenu.length > 0) result.push({ ...item, submenu });
    } else if (item.type === "shell") {
      stripped++;
    } else {
      result.push(item);
    }
  }
  if (stripped > 0) {
    logger.info(
      `Ignored ${stripped} shell action(s) from ${source} — project-local shell actions are disabled (start the hub with --allow-project-shell-actions to permit them)`,
    );
  }
  return result;
}

async function loadProjectActions(
  cwd: string,
  hubActions: MenuItem[] | undefined,
  allowShell: boolean,
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
        const actions = validateActions(JSON.parse(await file.text()));
        return allowShell ? actions : stripShellActions(actions, candidate);
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
      actions: await loadProjectActions(
        info.cwd,
        deps.hubActions,
        deps.allowProjectShellActions ?? false,
      ),
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

  // In-flight register() calls, keyed by project id
  const registerLocks = new Map<string, Promise<ProjectEntry>>();

  async function doRegister(
    id: string,
    cwd: string,
    input: { name?: string; harness?: string; surfaceId?: string },
  ): Promise<ProjectEntry> {
    if (!(await isGitRepo(cwd))) throw new Error("Not a git repository: " + cwd);
    const now = Date.now();
    let entry = entries.get(id);
    if (entry) {
      entry.info.status = "active";
      entry.info.lastSeenAt = now;
      entry.info.inactiveSince = undefined;
      if (input.name) entry.info.name = input.name;
      if (input.harness) entry.info.harness = input.harness;
      // Re-registration always overwrites the surface — a new session may
      // run in a different terminal (or none at all)
      entry.info.surfaceId = input.surfaceId;
      // Reload actions so config edits are picked up on new sessions
      entry.actions = await loadProjectActions(
        cwd,
        deps.hubActions,
        deps.allowProjectShellActions ?? false,
      );
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
  }

  /**
   * Drop entries whose directory no longer exists — e.g. a session ran in a
   * git worktree that was cleaned up on exit, before its SessionEnd hook
   * could unregister. There is nothing left to diff, so remove immediately.
   */
  function sweepMissingDirs(): boolean {
    let removed = false;
    for (const [id, entry] of entries) {
      if (existsSync(entry.info.cwd)) continue;
      stopWatcher(entry);
      entries.delete(id);
      removed = true;
      logger.info("registry: removed project with missing directory:", entry.info.cwd);
    }
    if (removed) persist();
    return removed;
  }

  function prune(now = Date.now()) {
    let changed = sweepMissingDirs();
    for (const [id, entry] of entries) {
      // Demote crash-orphaned actives (no unregister/heartbeat ever arrived)
      // so their watchers and GitHub polling don't leak forever
      if (entry.info.status === "active" && now - entry.info.lastSeenAt > ACTIVE_TTL_MS) {
        entry.info.status = "inactive";
        entry.info.inactiveSince = now;
        stopWatcher(entry);
        changed = true;
        logger.debug("registry: demoted stale active project", entry.info.cwd);
      }
      if (
        entry.info.status === "inactive" &&
        now - (entry.info.inactiveSince ?? entry.info.lastSeenAt) > LINGER_MS
      ) {
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

      // Serialize registrations per project: concurrent register calls for
      // the same cwd (e.g. hooks firing from two panes) would otherwise both
      // pass the entries.get() check and leak an unreachable watcher.
      const id = projectIdForCwd(cwd);
      const previous = registerLocks.get(id);
      const task = (async () => {
        if (previous) await previous.catch(() => {});
        return doRegister(id, cwd, input);
      })();
      registerLocks.set(id, task);
      try {
        return await task;
      } finally {
        if (registerLocks.get(id) === task) registerLocks.delete(id);
      }
    },

    unregister(idOrCwd: string): boolean {
      const entry = this.resolve(idOrCwd);
      if (!entry) return false;
      entry.info.status = "inactive";
      entry.info.lastSeenAt = Date.now();
      entry.info.inactiveSince = entry.info.lastSeenAt;
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
      // Self-heal on view: deleted worktrees/dirs disappear from the list
      // immediately instead of waiting for the hourly prune. No
      // onProjectsChanged broadcast — the response already reflects it, and
      // broadcasting from the read path would trigger a refetch loop.
      sweepMissingDirs();
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

    /** Demote stale actives and drop expired inactives. Exposed for tests. */
    prune,

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
