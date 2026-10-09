import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ApprovalLevel } from "../types.js";

function insideWorkspace(path: unknown, cwd: string): boolean {
  if (typeof path !== "string" || !path.trim()) return false;
  // Pi expands these forms before executing write/edit. Ask rather than
  // accidentally checking a different, unexpanded workspace-relative path.
  if (/^[@~]|^file:|[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(path + cwd))
    return false;
  if (
    process.platform === "win32" &&
    /^\/(?:mnt\/|cygdrive\/)?[a-z](?:\/|$)/i.test(path)
  )
    return false;
  try {
    const root = realpathSync(cwd);
    let target = resolve(cwd, path);
    // Resolve existing ancestors too: a new file through an outside symlink
    // must require approval just like an existing file outside the workspace.
    for (;;) {
      try {
        target = realpathSync(target);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        try {
          if (lstatSync(target).isSymbolicLink()) return false;
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code !== "ENOENT")
            return false;
        }
        const parent = dirname(target);
        if (parent === target) return false;
        target = parent;
      }
    }
    const pathFromRoot = relative(root, target);
    return (
      !isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`)
    );
  } catch {
    return false;
  }
}

function simpleReadCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  // This is an allowlist, not a shell risk classifier. Compound commands,
  // substitutions, redirects, escapes and unknown executables always ask.
  if (/[;&|<>$`\n\r\\(){}!]/.test(command)) return false;
  return /^[ \t]*(pwd|ls|cat|head|tail|wc)([ \t]|$)/.test(command);
}

export function piNeedsApproval(
  level: ApprovalLevel,
  event: { toolName: string; input: Record<string, unknown> },
  cwd: string,
): boolean {
  if (level === "automatic") return false;
  if (["read", "grep", "find", "ls"].includes(event.toolName)) return false;
  if (level === "on-request") {
    if (["write", "edit"].includes(event.toolName))
      return !insideWorkspace(event.input.path, cwd);
    if (event.toolName === "bash")
      return !simpleReadCommand(event.input.command);
  }
  return true;
}
