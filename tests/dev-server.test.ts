import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code, signal] = await closed;
    assert.equal(code, 0, `Development server failed to shut down: ${signal}`);
  } finally {
    clearTimeout(force);
  }
}

test(
  "two development instances share their HTTP port with HMR and shut down cleanly",
  { timeout: 30000 },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "catcoon-dev-server-"));
    const instances: {
      child: ChildProcess;
      port: number;
      output: () => string;
    }[] = [];
    const sockets: WebSocket[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const port = await freePort();
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "server/index.ts"],
          {
            cwd: resolve("."),
            env: {
              ...process.env,
              PORT: String(port),
              DATA_DIR: join(temp, String(index)),
              TYPESAFE_API_KEY: "test",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout!.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr!.on("data", (chunk) => {
          output += chunk;
        });
        instances.push({ child, port, output: () => output });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              finish(new Error(`Development server did not start: ${output}`)),
            10000,
          );
          const check = () => {
            if (
              output.includes(`Catcoon is running at http://localhost:${port}`)
            )
              finish();
          };
          const failed = () =>
            finish(
              new Error(`Development server exited during startup: ${output}`),
            );
          function finish(error?: Error) {
            clearTimeout(timer);
            child.stdout!.off("data", check);
            child.off("exit", failed);
            error ? reject(error) : resolve();
          }
          child.stdout!.on("data", check);
          child.once("exit", failed);
          check();
        });
      }
      for (const { port, output } of instances) {
        const base = `http://127.0.0.1:${port}`;
        assert.deepEqual(await (await fetch(`${base}/api/issues`)).json(), []);
        const client = await (await fetch(`${base}/@vite/client`)).text();
        assert.match(
          client,
          /const hmrPort = null;/,
          "Browser HMR must use the page's port",
        );
        const socket = new WebSocket(`ws://127.0.0.1:${port}/`, "vite-hmr");
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("HMR connection timed out")),
            5000,
          );
          socket.addEventListener(
            "message",
            (event) => {
              try {
                assert.equal(JSON.parse(String(event.data)).type, "connected");
                resolve();
              } catch (error) {
                reject(error);
              } finally {
                clearTimeout(timer);
              }
            },
            { once: true },
          );
          socket.addEventListener(
            "error",
            () => {
              clearTimeout(timer);
              reject(new Error(`HMR failed on application port ${port}`));
            },
            { once: true },
          );
        });
        assert.doesNotMatch(
          output(),
          /WebSocket server error|Port 24678 is already in use/,
        );
      }
      // Keep HMR sockets open while stopping, so shutdown must close them too.
    } finally {
      try {
        await Promise.all(instances.map(({ child }) => stop(child)));
      } finally {
        for (const socket of sockets) socket.close();
        await rm(temp, { recursive: true, force: true });
      }
    }
  },
);
