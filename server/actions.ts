export type ActionItem = {
  label: string;
  command: string;
  /** "paste-and-enter" pastes to cmux terminal with Enter, "shell" executes as subshell on server, "paste" pastes without Enter */
  type: "paste-and-enter" | "shell" | "paste";
  input?: {
    placeholder: string;
    variable: string;
  };
};

export type SubmenuItem = {
  label: string;
  submenu: ActionItem[];
};

export type MenuItem = ActionItem | SubmenuItem;

export function isSubmenu(item: MenuItem): item is SubmenuItem {
  return "submenu" in item;
}

export function isActionWithInput(
  item: MenuItem,
): item is ActionItem & { input: { placeholder: string; variable: string } } {
  return !isSubmenu(item) && item.input !== undefined;
}

export const DEFAULT_ACTIONS: MenuItem[] = [
  {
    label: "Commit & Push",
    type: "paste-and-enter",
    command: "Commit the pending changes with a descriptive message and push to the remote.",
  },
  {
    label: "Create PR",
    type: "paste-and-enter",
    command: "Create a pull request for the current branch with a clear title and summary.",
  },
];

export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

const VALID_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildCommandWithEnv(command: string, variables: Record<string, string>): string {
  const envParts = Object.entries(variables)
    .filter(([key]) => VALID_VAR_NAME.test(key))
    .map(([key, value]) => `${key}=${shellEscape(value)}`)
    .join(" ");
  if (!envParts) return command;
  return `${envParts} ${command}`;
}

/**
 * Find an action by its index path.
 * "0" → top-level item 0
 * "2.1" → submenu of item 2, sub-item 1
 */
export function findAction(actions: MenuItem[], id: string): ActionItem | null {
  if (!id) return null;
  const parts = id.split(".").map(Number);
  if (parts.some((n) => isNaN(n))) return null;

  const topIndex = parts[0];
  if (topIndex === undefined || topIndex < 0 || topIndex >= actions.length) return null;

  const item = actions[topIndex];
  if (!item) return null;
  if (parts.length === 1) {
    return isSubmenu(item) ? null : item;
  }

  if (parts.length === 2 && isSubmenu(item)) {
    const subIndex = parts[1];
    if (subIndex === undefined || subIndex < 0 || subIndex >= item.submenu.length) return null;
    return item.submenu[subIndex] ?? null;
  }

  return null;
}

const VALID_TYPES = new Set(["shell", "paste-and-enter", "paste"]);

function validateActionItem(item: unknown, path: string): ActionItem {
  if (typeof item !== "object" || item === null) {
    throw new Error(`${path}: must be an object`);
  }
  const obj = item as Record<string, unknown>;
  if (typeof obj.label !== "string" || !obj.label) {
    throw new Error(`${path}: "label" is required (string)`);
  }
  if (typeof obj.command !== "string" || !obj.command) {
    throw new Error(`${path}: "command" is required (string)`);
  }
  if (!VALID_TYPES.has(obj.type as string)) {
    throw new Error(
      `${path}: "type" must be one of: shell, paste-and-enter, paste (got ${JSON.stringify(obj.type)})`,
    );
  }
  if (obj.input !== undefined) {
    if (typeof obj.input !== "object" || obj.input === null) {
      throw new Error(`${path}.input: must be an object`);
    }
    const input = obj.input as Record<string, unknown>;
    if (typeof input.placeholder !== "string") {
      throw new Error(`${path}.input: "placeholder" is required (string)`);
    }
    if (typeof input.variable !== "string" || !input.variable) {
      throw new Error(`${path}.input: "variable" is required (string)`);
    }
  }
  return item as ActionItem;
}

function validateMenuItem(item: unknown, index: number): MenuItem {
  if (typeof item !== "object" || item === null) {
    throw new Error(`actions[${index}]: must be an object`);
  }
  const obj = item as Record<string, unknown>;
  if ("submenu" in obj) {
    if (typeof obj.label !== "string" || !obj.label) {
      throw new Error(`actions[${index}]: "label" is required (string)`);
    }
    if (!Array.isArray(obj.submenu)) {
      throw new Error(`actions[${index}]: "submenu" must be an array`);
    }
    obj.submenu.forEach((sub, i) => validateActionItem(sub, `actions[${index}].submenu[${i}]`));
    return item as SubmenuItem;
  }
  return validateActionItem(item, `actions[${index}]`);
}

export function validateActions(data: unknown): MenuItem[] {
  if (!Array.isArray(data)) {
    throw new Error("actions must be an array");
  }
  return data.map((item, i) => validateMenuItem(item, i));
}

export async function loadActions(source: string): Promise<MenuItem[]> {
  let json: string;
  if (source === "-") {
    json = await new Response(Bun.stdin.stream()).text();
  } else {
    const file = Bun.file(source);
    if (!(await file.exists())) {
      throw new Error(`Actions file not found: ${source}`);
    }
    json = await file.text();
  }
  return validateActions(JSON.parse(json));
}
