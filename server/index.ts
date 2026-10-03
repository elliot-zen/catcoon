import { createServer } from "node:http";
import { resolve, extname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Store, AppError, hash, text, find, fail, now } from "./store.ts";
import { Domain } from "./domain.ts";
import { Runtime } from "./runtime.ts";
import { evaluate } from "./jev.ts";
import { readSpec, saveSpec, directories } from "./files.ts";
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
            readSpec(
              find(store.read().worktrees, url.searchParams.get("worktreeId")),
              url.searchParams.get("document"),
            ),
          );
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
      let body;
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
          const cached = store.cached(key, fp);
          if (cached !== undefined) result = cached;
          else {
            const w = find(store.read().worktrees, body.worktreeId);
            result = saveSpec(w, body.document, body.content, body.version);
            store.change(() => result, key, fp);
          }
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
                    { ok: "Connection check" },
                    undefined,
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
      return send({ result, revision: store.read().revision });
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
      await new Promise<void>((r) => server.close(() => r()));
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
