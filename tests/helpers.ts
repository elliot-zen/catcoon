import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store, find } from "../server/store.ts";
import { Domain, makeRequest, artifact } from "../server/domain.ts";
import { Runtime } from "../server/runtime.ts";
import { saveDraft, publishVersion } from "../server/specs.ts";
import type {
  Binding,
  Issue,
  Project,
  Worktree,
  Run,
} from "../server/types.ts";
export function fixture(agentId = "pi") {
  const root = mkdtempSync(join(tmpdir(), "relay-test-")),
    repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "fixture");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Relay Test",
      "-c",
      "user.email=relay@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { stdio: "ignore" },
  );
  const store = new Store(join(root, "data")),
    domain = new Domain(store);
  store.change((s) => {
    s.agents = ["pi", "codex"].map((command) => ({
      id: command,
      name: command === "pi" ? "Pi" : "Codex",
      command,
      version: command === "pi" ? "1.0.0" : "codex-cli 0.160.0",
      status: "available",
      heartbeat: "",
      reason: "fixture",
    }));
  });
  const project = domain.action("project.create", {
    name: "Project",
    path: repo,
  }) as Project;
  const tree = domain.action("worktree.create", {
    projectId: project.id,
    name: "W1",
    path: repo,
    branch: "main",
    newSpec: { name: "Users" },
  }) as Worktree;
  const issue = domain.action("issue.create", {
    title: "Users",
    description: "Implement greeting and verify actual behavior",
  }) as Issue;
  const binding = domain.action("binding.save", {
    issueId: issue.id,
    projectId: project.id,
    worktreeId: tree.id,
    agentId,
    description: "Own Spec, implementation and verification",
  }) as Binding;
  const state = () => store.read();
  const start = () =>
    domain.action("issue.control", { issueId: issue.id, command: "start" });
  const version = () =>
    store.change((s) => {
      const spec = find(s.specs, tree.specId);
      saveDraft(s, {
        specId: spec.id,
        document: "product",
        content: "# Users\nProvide a greeting.",
        draftRevision: spec.draft.revision,
      });
      saveDraft(s, {
        specId: spec.id,
        document: "tech",
        content: "# Implementation\nUse a tested function.",
        draftRevision: spec.draft.revision,
      });
      return publishVersion(s, spec.id, spec.draft.revision);
    });
  const secondTree = () => {
    const path = join(root, "other");
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "other", path], {
      stdio: "ignore",
    });
    return domain.action("worktree.create", {
      projectId: project.id,
      name: "W2",
      path,
      branch: "other",
      specId: tree.specId,
      specVersionId: tree.specVersionId,
    }) as Worktree;
  };
  const decide = (requestId: string, decision = "approve", answer = "") =>
    domain.action("request.decide", {
      requestId,
      revision: find(state().requests, requestId).revision,
      decision,
      answer,
    });
  const approve = (mode: "implement" | "verify" | "revise" = "implement") => {
    const v = version();
    const q = store.change((s) => {
      const w = find(s.worktrees, tree.id);
      w.specVersionId = v.id;
      w.revision++;
      const a = artifact(s, {
        issueId: issue.id,
        title: "Frozen Spec",
        content: v.product + "\n" + v.tech,
        specVersionId: v.id,
      });
      return makeRequest(s, {
        issueId: issue.id,
        kind: "approval",
        title: "Approve fixed version",
        artifactIds: [a.id],
        scope: "issue",
        action: {
          type: "approve_spec",
          specVersionId: v.id,
          worktreeIds: [tree.id],
          allowedModes: ["implement", "verify", "revise"],
        },
      });
    });
    decide(q.id);
    return v;
  };
  const runtime = new Runtime(store);
  runtime.recovered = true;
  const launched: Run[] = [];
  runtime.launch = (r) => launched.push(r);
  const close = () => {
    runtime.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    repo,
    store,
    domain,
    runtime,
    launched,
    project,
    tree,
    issue,
    binding,
    state,
    start,
    version,
    secondTree,
    decide,
    approve,
    close,
  };
}
export function typed(
  state: any,
  next = "dispatch",
  mode = "spec",
  route?: string,
  goal = 0,
  item = 0,
) {
  const candidates = state.bindings.map((b: any) => b.id);
  const choice = (name: string, keys: string[]) => ({
    type: "choice",
    choice: name,
    confidence: 0.95,
    probabilities: Object.fromEntries(keys.map((k) => [k, k === name ? 1 : 0])),
  });
  const answers: any = {
    next_action: choice(next, ["dispatch", "wait", "human", "final"]),
    dispatch_mode: choice(mode, [
      "spec",
      "implement",
      "verify",
      "clarify",
      "revise",
      "inspect",
      "none",
    ]),
    route: choice(route || candidates[0] || "human", ["human", ...candidates]),
    goal_complete: { type: "noul", noul: goal },
  };
  if (state.currentWorkItem)
    answers.work_item_complete = { type: "noul", noul: item };
  return { answers, model: "fixture" };
}
export async function settle(runtime: Runtime) {
  await runtime.tick();
  for (let n = 0; n < 200 && runtime.inflight.size; n++)
    await new Promise<void>((r) => setImmediate(r));
  if (runtime.inflight.size) throw new Error("Worker did not settle");
}
