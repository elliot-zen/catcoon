import { createServer } from "node:http";
import { resolve, extname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Store, AppError, hash, text, find, fail, now } from "./store.ts";
import { Domain } from "./domain.ts";
import { Runtime } from "./runtime.ts";
import { evaluate } from "./jev.ts";
import { directories } from "./files.ts";
import {
  readDocument,
  saveDraft,
  createSpec,
  publishVersion,
  specReference,
  directoryIdle,
  dirty,
} from "./specs.ts";
export function createApp(
  dataDir: string,
  options: { worker?: boolean; fetcher?: typeof fetch } = {},
) {
  const store = new Store(dataDir),
    domain = new Domain(store),
    runtime = new Runtime(store, options.fetcher);
  domain.recover();
  if (options.worker !== false) runtime.refresh();
  let mutation = Promise.resolve();
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        fail(403, "ORIGIN_REJECTED", "Use a local loopback host");
      const send = (value: unknown, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "GET") {
        if (url.pathname === "/api/health") return send({ ok: true });
        if (url.pathname === "/api/state") return send(store.publicState());
        if (url.pathname === "/api/directories")
          return send(
            directories(url.searchParams.get("path") || process.cwd()),
          );
        if (url.pathname === "/api/spec")
          return send(
            readDocument(
              store.read(),
              url.searchParams.get("specId"),
              url.searchParams.get("document"),
              url.searchParams.get("versionId"),
            ),
          );
        if (url.pathname === "/api/specs")
          return send(
            store
              .read()
              .specs.filter(
                (s) => s.projectId === url.searchParams.get("projectId"),
              )
              .map((s) => ({
                id: s.id,
                projectId: s.projectId,
                name: s.name,
                latestVersionId: s.latestVersionId,
                draftRevision: s.draft.revision,
                baseVersionId: s.draft.baseVersionId,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                versions: store
                  .read()
                  .specVersions.filter((v) => v.specId === s.id)
                  .map(({ product, tech, ...v }) => v),
              })),
          );
        const itemPath = url.pathname.match(
          /^\/api\/(runs|issues)\/([^/]+)\/items$/,
        );
        if (itemPath) {
          if (itemPath[1] === "issues") {
            find(store.read().issues, itemPath[2]);
            return send(runtime.streams.snapshot(itemPath[2]));
          }
          const r = find(store.read().runs, itemPath[2]);
          const snapshot = runtime.streams.snapshot(r.issueId);
          return send({
            items: runtime.streams.items(r.id),
            lastSeq: snapshot.lastSeq,
          });
        }
        if (url.pathname === "/api/stream") {
          const issueId = text(url.searchParams.get("issueId"), "Issue");
          find(store.read().issues, issueId);
          let cursor = Number(
            req.headers["last-event-id"] || url.searchParams.get("after") || 0,
          );
          if (!Number.isSafeInteger(cursor) || cursor < 0)
            fail(400, "INVALID_INPUT", "Invalid stream cursor");
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(": connected\n\n");
          const emit = (payload: any) => {
            if (payload.issueId !== issueId || payload.seq <= cursor) return;
            cursor = payload.seq;
            if (
              !res.write(
                "id: " +
                  payload.seq +
                  "\nevent: stream\ndata: " +
                  JSON.stringify(payload) +
                  "\n\n",
              )
            )
              res.destroy();
          };
          const changed = () => {
            if (!res.write("event: state.changed\ndata: {}\n\n")) res.destroy();
          };
          runtime.streams.on("stream", emit);
          store.changes.on("change", changed);
          for (const payload of runtime.streams.replay(issueId, cursor))
            emit(payload);
          const heartbeat = setInterval(
            () => res.write(": heartbeat\n\n"),
            15000,
          );
          heartbeat.unref();
          res.on("close", () => {
            clearInterval(heartbeat);
            runtime.streams.off("stream", emit);
            store.changes.off("change", changed);
          });
          return;
        }
        if (url.pathname.startsWith("/api/attachments/")) {
          const a = find(
            store.read().attachments,
            url.pathname.split("/").at(-1),
          );
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
          });
          return res.end(Buffer.from(a.content, "base64"));
        }
        if (url.pathname.startsWith("/api/"))
          fail(404, "NOT_FOUND", "Endpoint not found");
        const root = resolve("dist");
        const file = resolve(root, "." + url.pathname);
        const selected =
          file.startsWith(root + "/") && existsSync(file) && extname(file)
            ? file
            : join(root, "index.html");
        if (!existsSync(selected))
          fail(404, "NOT_FOUND", "Run npm run dev or npm run build");
        const mime: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        };
        res.writeHead(200, {
          "Content-Type": mime[extname(selected)] || "application/octet-stream",
        });
        return res.end(readFileSync(selected));
      }
      if (!["POST", "PUT"].includes(req.method || ""))
        fail(405, "METHOD_NOT_ALLOWED", "Unsupported method");
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host)
        fail(403, "ORIGIN_REJECTED", "Use the same origin");
      if (req.headers["sec-fetch-site"] === "cross-site")
        fail(403, "ORIGIN_REJECTED", "Cross-site writes are rejected");
      if (!req.headers["content-type"]?.startsWith("application/json"))
        fail(415, "INVALID_INPUT", "Use application/json");
      const key = text(req.headers["idempotency-key"], "Idempotency-Key", 100);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          key,
        )
      )
        fail(400, "INVALID_INPUT", "Idempotency-Key must be a UUID");
      let raw = "";
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 12 * 1024 * 1024)
          fail(413, "INVALID_INPUT", "Request too large");
      }
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        fail(400, "INVALID_INPUT", "Invalid JSON");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        fail(400, "INVALID_INPUT", "Request must be a JSON object");
      let result: unknown;
      const previous = mutation;
      let release!: () => void;
      mutation = new Promise((r) => (release = r));
      await previous;
      try {
        const fp = hash(JSON.stringify({ path: url.pathname, body }));
        if (url.pathname === "/api/spec" && req.method === "PUT") {
          result = store.change((s) => saveDraft(s, body), key, fp);
        } else if (url.pathname === "/api/specs" && req.method === "POST") {
          result = store.change(
            (s) => createSpec(s, body.projectId, body.name),
            key,
            fp,
          );
        } else if (
          /^\/api\/specs\/[^/]+\/versions$/.test(url.pathname) &&
          req.method === "POST"
        ) {
          result = store.change(
            (s) => ({
              version: publishVersion(
                s,
                url.pathname.split("/")[3],
                body.draftRevision,
              ),
              revision: s.revision + 1,
            }),
            key,
            fp,
          );
        } else if (
          /^\/api\/worktrees\/[^/]+\/spec$/.test(url.pathname) &&
          req.method === "POST"
        ) {
          result = store.change(
            (s) => {
              const w = find(s.worktrees, url.pathname.split("/")[3]);
              if (w.revision !== body.revision)
                fail(409, "STALE_VERSION", "Worktree changed");
              text(body.reason, "Upgrade reason");
              specReference(s, w.projectId, body.specId, body.versionId);
              directoryIdle(store, s, w);
              w.specId = body.specId;
              w.specVersionId = body.versionId;
              w.revision++;
              const affectedIssueIds = [
                ...new Set(
                  s.bindings
                    .filter((b) => b.worktreeId === w.id && !b.removed)
                    .map((b) => b.issueId),
                ),
              ];
              for (const issueId of affectedIssueIds)
                dirty(s, issueId, "spec.upgraded");
              return {
                worktree: w,
                affectedIssueIds,
                revision: s.revision + 1,
              };
            },
            key,
            fp,
          );
        } else if (
          /^\/api\/runs\/[^/]+\/(report|tool)$/.test(url.pathname) &&
          req.method === "POST"
        ) {
          const runId = url.pathname.split("/")[3];
          if (
            !runtime.runTokens.has(runId) ||
            req.headers.authorization !==
              "Bearer " + runtime.runTokens.get(runId)
          )
            fail(403, "SCOPE_REJECTED", "Use the current Run tool credentials");
          result = url.pathname.endsWith("/tool")
            ? runtime.handleTool(
                runId,
                body.tool,
                body.args,
                text(body.callId, "Tool call ID"),
              )
            : domain.report(runId, body, key);
        } else if (url.pathname === "/api/actions" && req.method === "POST") {
          const p = body.payload || {};
          if (
            ["settings.save", "settings.test", "agents.refresh"].includes(
              body.type,
            )
          ) {
            const cached = store.cached(key, fp);
            if (cached !== undefined) result = cached;
            else {
              if (body.type === "settings.save") {
                store.saveKey(text(p.apiKey, "API key", 5000));
                result = store.change(
                  (s) => {
                    s.settings = {
                      configured: true,
                      testedAt: "",
                      connection: "not tested",
                    };
                    for (const i of s.issues)
                      dirty(s, i.id, "jev.configuration");
                    return { configured: true };
                  },
                  key,
                  fp,
                );
              } else if (body.type === "settings.test") {
                let connection = "connected";
                try {
                  await evaluate(
                    store.key(),
                    { test: "Connection check" },
                    {
                      route: {
                        type: "choice",
                        instructions: "Connection check",
                        criteria: { ok: "Connection check" },
                      },
                    },
                    options.fetcher,
                  );
                } catch (e) {
                  connection =
                    e instanceof Error ? e.message : "Connection failed";
                }
                result = store.change(
                  (s) => {
                    s.settings.connection = connection;
                    s.settings.testedAt = now();
                    for (const i of s.issues)
                      dirty(s, i.id, "jev.configuration");
                    return { connection };
                  },
                  key,
                  fp,
                );
              } else {
                runtime.refresh(true);
                result = store.change((s) => s.agents, key, fp);
              }
            }
          } else if (
            body.type === "request.decide" &&
            store.read().requests.find((q) => q.id === p.requestId)?.native
          )
            result = await runtime.decideNative(p, key);
          else result = domain.action(body.type, p, key);
        } else fail(404, "NOT_FOUND", "Endpoint not found");
      } finally {
        release();
      }
      return send(
        url.pathname === "/api/actions"
          ? { result, revision: store.read().revision }
          : result,
      );
    } catch (e) {
      const a =
        e instanceof AppError
          ? e
          : new AppError(
              500,
              "INTERNAL_ERROR",
              "Operation failed; input has been preserved",
            );
      res.writeHead(a.status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: a.code,
            message: store.redact(a.message),
            details: a.details,
          },
        }),
      );
    }
  });
  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address !== "string")
      runtime.apiEndpoint = "http://127.0.0.1:" + address.port;
  });
  const timers: ReturnType<typeof setInterval>[] = [];
  if (options.worker !== false) {
    timers.push(
      setInterval(() => void runtime.tick(), 1000),
      setInterval(() => runtime.refresh(), 30000),
    );
    for (const t of timers) t.unref();
  }
  return {
    server,
    store,
    domain,
    runtime,
    close: async () => {
      for (const t of timers) clearInterval(t);
      runtime.shutdown();
      await new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = createApp(resolve(process.env.DATA_DIR || "data"));
  const port = Number(process.env.API_PORT || 4310);
  app.server.listen(port, "127.0.0.1", () =>
    console.log(`Relay: http://127.0.0.1:${port}`),
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => {
      app.runtime.shutdown();
      app.server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 6000).unref();
    });
}
