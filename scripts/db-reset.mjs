import { rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { Store } from "../server/store.ts";
import { Streams } from "../server/streams.ts";
export function resetDatabase(dir) {
  const root = resolve(dir);
  for (const name of ["relay.sqlite", "relay.sqlite-wal", "relay.sqlite-shm"])
    rmSync(join(root, name), { force: true });
  const store = new Store(root);
  new Streams(store);
  store.close();
  return root;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  try {
    const running = await fetch(
      "http://127.0.0.1:" + (process.env.API_PORT || 4310) + "/api/health",
      { signal: AbortSignal.timeout(1000) },
    )
      .then((r) => r.ok)
      .catch(() => false);
    if (running)
      throw new Error("Stop Relay before clearing its SQLite database.");
    console.log(
      "Empty application database initialized: " +
        resetDatabase(process.env.DATA_DIR || "data"),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
