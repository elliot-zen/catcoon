import { realpathSync, statSync, readdirSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { fail, text } from "./store.ts";
import type { Worktree, Project } from "./types.ts";
export function repository(input: unknown) {
  const p = text(input, "Directory");
  if (!isAbsolute(p))
    fail(422, "INVALID_REPOSITORY", "Use an absolute local directory");
  try {
    const path = realpathSync(p);
    if (!statSync(path).isDirectory()) throw new Error();
    const root = realpathSync(
      execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    if (path !== root)
      fail(422, "INVALID_REPOSITORY", "Select the repository / worktree root");
    const commonDir = realpathSync(
      execFileSync(
        "git",
        ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim(),
    );
    const branch = execFileSync(
      "git",
      ["-C", path, "branch", "--show-current"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const dirty = !!execFileSync("git", ["-C", path, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { path, commonDir, branch, dirty };
  } catch (e) {
    if (
      e instanceof Error &&
      "code" in e &&
      typeof e.code === "string" &&
      e.code.includes("REPOSITORY")
    )
      throw e;
    return fail(
      422,
      "INVALID_REPOSITORY",
      "Directory must be an accessible Git repository root",
    );
  }
}
export function validateWorktree(w: Worktree, p: Project) {
  const r = repository(w.path);
  if (r.commonDir !== p.commonDir)
    fail(422, "INVALID_REPOSITORY", "Worktree belongs to another repository");
  if (r.branch !== w.branch)
    fail(422, "BRANCH_MISMATCH", `Actual branch: ${r.branch || "(detached)"}`);
  return r;
}
export function directories(path: string) {
  const root = realpathSync(path || process.cwd());
  return {
    path: root,
    parent: dirname(root),
    directories: readdirSync(root, { withFileTypes: true })
      .filter((x) => x.isDirectory() && !x.name.startsWith("."))
      .map((x) => ({ name: x.name, path: join(root, x.name) })),
  };
}
