import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import WebSocket from "ws";
import { Rpc, agentEnv } from "./rpc.ts";
export class Codex extends Rpc {
  endpoint: string;
  child?: ChildProcess;
  socket?: WebSocket;
  connecting?: Promise<void>;
  closed = false;
  constructor(dir: string, endpoint = process.env.CODEX_APP_SERVER_ENDPOINT) {
    super((message) => {
      if (this.socket?.readyState !== WebSocket.OPEN)
        throw new Error("Codex connection unavailable");
      this.socket.send(JSON.stringify(message));
    });
    this.endpoint = endpoint || `unix://${join(resolve(dir), "codex.sock")}`;
    if (this.endpoint.startsWith("unix://")) {
      if (Buffer.byteLength(this.endpoint.slice(7)) > 103)
        throw new Error(
          "Codex socket path too long; configure a shorter DATA_DIR or endpoint",
        );
    } else {
      const u = new URL(this.endpoint);
      if (
        u.protocol !== "ws:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      )
        throw new Error(
          "Codex endpoint must be a local Unix socket or loopback ws",
        );
    }
    this.owned = !endpoint;
  }
  owned: boolean;
  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    return (this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    }));
  }
  async open() {
    if (this.closed) throw new Error("Codex adapter closed");
    if (this.owned && !this.child) {
      const path = this.endpoint.slice(7);
      mkdirSync(resolve(path, ".."), { recursive: true });
      // Do not replace a live server's socket: existing endpoint is connected first.
      if (existsSync(path)) {
        try {
          await this.attach();
          this.owned = false;
          return;
        } catch (error) {
          this.socket?.terminate();
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ECONNREFUSED" && code !== "ENOENT") throw error;
          if (existsSync(path)) unlinkSync(path);
        }
      }
      const c = (this.child = spawn(
        "codex",
        ["app-server", "--listen", this.endpoint],
        { env: agentEnv(), stdio: ["ignore", "ignore", "pipe"] },
      ));
      let error = "";
      c.on("error", (e) => {
        error = e.message;
        if (this.child === c) this.child = undefined;
      });
      c.stderr?.on("data", () => {});
      c.on("exit", () => {
        if (this.child === c) this.child = undefined;
        if (!this.closed)
          this.disconnect("Codex app-server exited; execution result unknown");
      });
      const until = Date.now() + 15000;
      while (!existsSync(path)) {
        if (error || c.exitCode !== null || Date.now() > until)
          throw new Error(error || "Codex app-server startup failed");
        await new Promise((r) => setTimeout(r, 50));
      }
      chmodSync(path, 0o600);
    }
    await this.attach();
  }
  async attach() {
    const ws = (this.socket = new WebSocket(
      this.endpoint.startsWith("unix://")
        ? `ws+unix://${this.endpoint.slice(7)}:/`
        : this.endpoint,
    ));
    ws.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("Codex connection timeout"));
      }, 15000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    ws.on("message", (raw) => {
      try {
        this.receive(JSON.parse(raw.toString()));
      } catch {
        this.disconnect("Invalid app-server protocol");
      }
    });
    ws.on("close", () => {
      if (!this.closed)
        this.disconnect("Codex connection lost; execution result unknown");
    });
    await this.call("initialize", {
      clientInfo: { name: "catcoon_relay", title: "Relay", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }
  shutdown() {
    this.closed = true;
    this.disconnect("Relay stopped");
    this.socket?.terminate();
    const c = this.child;
    if (c) {
      c.kill("SIGTERM");
      const t = setTimeout(() => c.kill("SIGKILL"), 5000);
      t.unref();
      c.once("exit", () => clearTimeout(t));
    }
  }
}
