import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { Store } from "./store.js";
import { Orchestrator } from "./orchestrator.js";
import { createApp } from "./app.js";
if (existsSync(".env")) process.loadEnvFile(".env");
const data = resolve(process.env.DATA_DIR || ".data");
mkdirSync(data, { recursive: true });
const lock = resolve(data, "server.lock");
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {}
  if (alive) throw new Error("Another Catcoon process owns this database.");
  unlinkSync(lock);
}
const fd = openSync(lock, "wx");
closeSync(fd);
writeFileSync(lock, String(process.pid));
const store = new Store(resolve(data, "catcoon.sqlite"));
const engine = new Orchestrator(store);
engine.recover();
const app = createApp(engine);
const server = createHttpServer(app);
let vite: import("vite").ViteDevServer | undefined;
if (process.argv.includes("--production")) {
  if (!existsSync("dist/index.html"))
    throw new Error("Run npm run build before npm start.");
  const express = (await import("express")).default;
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true, ws: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 3000);
server.listen(port, "127.0.0.1", () =>
  console.log(`Catcoon is running at http://localhost:${port}`),
);
let shutting = false;
async function shutdown() {
  if (shutting) return;
  shutting = true;
  await engine.shutdown();
  await vite?.close();
  server.close();
  server.closeAllConnections();
  store.close();
  try {
    unlinkSync(lock);
  } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("error", (e) => {
  console.error(e);
  void shutdown();
});
