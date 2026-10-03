import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { Rpc, agentEnv } from "./rpc.ts";
export class Pi extends Rpc {
  child: ChildProcess;
  closed = false;
  constructor(
    path: string,
    cwd: string,
    relayEnv: Record<string, string> = {},
  ) {
    super((message) => {
      if (!this.child.stdin?.writable) throw new Error("Pi RPC disconnected");
      this.child.stdin.write(
        JSON.stringify({
          id: message.id,
          type: message.method,
          ...message.params,
        }) + "\n",
      );
    });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--session",
        path,
        "--extension",
        fileURLToPath(new URL("./pi-extension.ts", import.meta.url)),
      ],
      {
        cwd,
        env: { ...agentEnv(), ...relayEnv },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    this.child.stdout?.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      let n;
      while ((n = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        if (line.trim()) {
          try {
            this.receive(JSON.parse(line));
          } catch {
            this.disconnect("Invalid Pi RPC JSONL");
          }
        }
      }
      if (buffer.length > 4 * 1024 * 1024) {
        this.disconnect("Pi RPC event exceeds limit");
        this.child.kill();
      }
    });
    this.child.stderr?.on("data", () => {});
    this.child.stdin?.on("error", () => {});
    this.child.on("error", (e) => this.disconnect(e.message));
    this.child.on("close", () => {
      if (!this.closed)
        this.disconnect("Pi RPC exited; execution result unknown");
    });
  }
  async interrupt() {
    await this.call("clear_queue");
    await this.call("abort");
  }
  shutdown() {
    this.closed = true;
    this.disconnect("Relay stopped");
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
    const t = setTimeout(() => this.child.kill("SIGKILL"), 5000);
    t.unref();
    this.child.once("exit", () => clearTimeout(t));
  }
}
