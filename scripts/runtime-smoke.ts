import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { codex } from "../server/runtime/codex.js";
import { pi } from "../server/runtime/pi.js";
import type { Binding } from "../server/types.js";
const dir = mkdtempSync(join(tmpdir(), "catcoon-live-"));
for (const [name, factory] of [
  ["codex", codex],
  ["pi", pi],
] as const) {
  let handle: ReturnType<typeof factory> | undefined;
  let result = "";
  let failure: Error | undefined;
  console.log(
    `Testing installed ${name} runtime (one read-only response, no tools)…`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void handle?.stop();
        reject(new Error("Live runtime timeout"));
      }, 90000);
      const binding: Binding = {
        id: randomUUID(),
        issueId: "smoke",
        name,
        runtime: name,
        approvalLevel: name === "pi" ? "strict" : "on-request",
        role: "Read-only smoke test",
        cwd: dir,
        model: "",
        sessionId: name === "pi" ? join(dir, "pi-session.jsonl") : null,
      };
      handle = factory(
        binding,
        "Reply exactly CATCOON_RUNTIME_OK. Do not call tools, read files, or modify anything.",
        {
          spawned: () => {},
          session: () => {},
          message: () => {},
          request: () => {
            failure = new Error(
              "Unexpected approval during read-only smoke test",
            );
            void handle?.stop();
          },
          complete: (output) => {
            result = output;
          },
          error: (e) => {
            failure = e;
          },
          closed: () => {
            clearTimeout(timer);
            failure ? reject(failure) : resolve();
          },
        },
      );
    });
    if (!result.includes("CATCOON_RUNTIME_OK"))
      throw new Error("Unexpected runtime response");
    console.log(`${name}: real authenticated turn completed.`);
  } catch (e) {
    console.error(`${name}: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    handle?.dispose();
  }
}
rmSync(dir, { recursive: true, force: true });
