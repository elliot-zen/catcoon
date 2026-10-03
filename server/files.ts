import {
  realpathSync,
  statSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { resolve, relative, dirname, join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { fail, hash, id, text } from "./store.ts";
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
function inside(root: string, target: string) {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    fail(
      422,
      "PATH_OUTSIDE_WORKTREE",
      "Spec path must stay inside this worktree",
    );
}
export function specPath(w: Worktree, document: unknown) {
  if (document !== "product" && document !== "tech")
    fail(400, "INVALID_INPUT", "document must be product or tech");
  const root = realpathSync(w.path);
  if (isAbsolute(w.specDir) || w.specDir.split(/[\\/]/).includes(".."))
    fail(
      422,
      "PATH_OUTSIDE_WORKTREE",
      "Use a relative Spec directory without ..",
    );
  const target = resolve(
    root,
    w.specDir,
    document === "product" ? "PRODUCT.md" : "TECH.md",
  );
  inside(root, target);
  let check = target;
  while (!existsSync(check)) check = dirname(check);
  inside(root, realpathSync(check));
  return target;
}
export function readSpec(w: Worktree, document: unknown) {
  const path = specPath(w, document);
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  return { path, content, version: hash(content) };
}
export function saveSpec(
  w: Worktree,
  document: unknown,
  content: unknown,
  version: unknown,
) {
  if (typeof content !== "string" || content.length > 1000000)
    fail(400, "INVALID_INPUT", "Spec content must be text, maximum 1MB");
  const old = readSpec(w, document);
  if (old.version === hash(content as string)) return old;
  if (old.version !== version)
    fail(
      409,
      "SPEC_CONFLICT",
      "File changed externally; compare before saving",
      old,
    );
  mkdirSync(dirname(old.path), { recursive: true });
  specPath(w, document);
  const tmp = old.path + "." + id() + ".tmp";
  writeFileSync(tmp, content as string);
  renameSync(tmp, old.path);
  return readSpec(w, document);
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
