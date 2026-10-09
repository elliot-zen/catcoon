import express from "express";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { HttpError, Orchestrator } from "./orchestrator.js";
import { approvalLevels } from "./approval.js";
const text = z.string().trim().min(1).max(20000);
const issueSchema = z.object({ title: text.max(240), description: text });
const bindingSchema = z.object({
  name: text.max(80),
  runtime: z.enum(["codex", "pi"]),
  approvalLevel: z.enum(approvalLevels).optional(),
  role: text,
  cwd: text,
  model: z.string().trim().max(200).default(""),
});
export function createApp(engine: Orchestrator) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", (req, res, next) => {
    const host = req.hostname;
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
      res
        .status(403)
        .json({ error: "This workspace accepts localhost requests only." });
      return;
    }
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
      res.status(403).json({ error: "Cross-origin requests are not allowed." });
      return;
    }
    next();
  });
  app.get("/api/config", (_req, res) =>
    res.json({
      workspace: process.env.AGENT_WORKSPACE || process.cwd(),
      jevConfigured: !!process.env.TYPESAFE_API_KEY,
      runtimes: ["codex", "pi"],
      runtimeAvailable: Object.fromEntries(
        ["codex", "pi"].map((r) => [
          r,
          spawnSync(process.env[r.toUpperCase() + "_BIN"] || r, ["--version"], {
            timeout: 5000,
          }).status === 0,
        ]),
      ),
    }),
  );
  app.get("/api/issues", (_req, res) =>
    res.json(
      engine.store.list().map((i) => ({
        ...i,
        bindings: engine.store.bindings(i.id),
        runningAgent:
          engine.store
            .bindings(i.id)
            .find(
              (b) =>
                b.id ===
                engine.store.turns(i.id).find((t) => t.id === i.currentTurnId)
                  ?.bindingId,
            )?.name || null,
      })),
    ),
  );
  app.post("/api/issues", (req, res) => {
    const d = issueSchema.parse(req.body);
    res.status(201).json(engine.createIssue(d.title, d.description));
  });
  app.get("/api/issues/:id", (req, res) =>
    res.json(engine.require(req.params.id)),
  );
  app.patch("/api/issues/:id", (req, res) => {
    const d = issueSchema.parse(req.body);
    engine.edit(req.params.id, d.title, d.description);
    res.json(engine.require(req.params.id));
  });
  app.post("/api/issues/:id/bindings", (req, res) => {
    engine.bind(req.params.id, bindingSchema.parse(req.body));
    res.status(201).json(engine.require(req.params.id));
  });
  app.patch("/api/issues/:id/bindings/:binding", (req, res) => {
    engine.bind(
      req.params.id,
      bindingSchema.parse(req.body),
      req.params.binding,
    );
    res.json(engine.require(req.params.id));
  });
  app.delete("/api/issues/:id/bindings/:binding", (req, res) => {
    engine.unbind(req.params.id, req.params.binding);
    res.json(engine.require(req.params.id));
  });
  app.post("/api/issues/:id/start", (req, res) =>
    res.json(engine.start(req.params.id)),
  );
  app.post("/api/issues/:id/bindings/:binding/messages", async (req, res) => {
    const { message, turnId } = z
      .object({ message: text, turnId: z.string().nullable() })
      .parse(req.body);
    await engine.message(req.params.id, req.params.binding, message, turnId);
    res.status(201).json(engine.require(req.params.id));
  });
  app.post("/api/issues/:id/stop", (req, res) =>
    res.json(engine.stop(req.params.id)),
  );
  app.post("/api/issues/:id/requests/:request", (req, res) => {
    const d = z
      .object({
        answer: z.string().max(20000).default(""),
        approved: z.boolean().default(false),
      })
      .parse(req.body);
    engine.respond(req.params.id, req.params.request, d.answer, d.approved);
    res.json(engine.require(req.params.id));
  });
  app.get("/api/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    res.write("data: connected\n\n");
    let timer: NodeJS.Timeout | undefined;
    const changed = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        res.write("data: changed\n\n");
      }, 150);
    };
    engine.on("change", changed);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => {
      engine.off("change", changed);
      clearInterval(heartbeat);
      clearTimeout(timer);
    });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API endpoint not found." }),
  );
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof z.ZodError)
        res.status(400).json({
          error: err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
      else if (err instanceof HttpError)
        res.status(err.status).json({ error: err.message });
      else {
        console.error(err);
        res.status(err.status === 400 ? 400 : 500).json({
          error:
            err.status === 400
              ? "Invalid JSON request."
              : "An unexpected server error occurred.",
        });
      }
    },
  );
  return app;
}
