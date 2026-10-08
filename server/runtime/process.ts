import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
export class JsonProcess {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  seq = 0;
  exited = false;
  stderr = "";
  onMessage: (m: any) => void = () => {};
  onClose: () => void = () => {};
  onError: (e: Error) => void = () => {};
  constructor(command: string, args: string[], cwd: string) {
    this.child = spawn(command, args, {
      cwd,
      stdio: "pipe",
      detached: process.platform !== "win32",
      env: process.env,
    });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          const p = m.method ? undefined : this.pending.get(String(m.id));
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(String(m.id));
            if (m.error || m.success === false)
              p.reject(
                new Error(
                  m.error?.message || m.error || "Runtime request failed",
                ),
              );
            else p.resolve(m.result ?? m.data ?? m);
          } else this.onMessage(m);
        } catch (e) {
          if (e instanceof SyntaxError)
            this.onError(new Error("Runtime emitted malformed JSON."));
          else this.onError(e as Error);
        }
      }
      if (buffer.length > 8 * 1024 * 1024)
        this.onError(new Error("Runtime message exceeded 8 MB."));
    });
    this.child.stderr.on("data", (c) => {
      this.stderr = (this.stderr + c.toString()).slice(-8000);
    });
    this.child.on("error", (e) => this.onError(e));
    this.child.on("close", () => {
      this.exited = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Runtime process exited before responding."));
      }
      this.pending.clear();
      this.onClose();
    });
  }
  send(data: unknown) {
    if (this.exited || this.child.stdin.destroyed)
      throw new Error("Runtime is no longer connected.");
    this.child.stdin.write(JSON.stringify(data) + "\n");
  }
  request(method: string, params: any, pi = false): Promise<any> {
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Runtime timed out: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(
          pi ? { id, type: method, ...params } : { id, method, params },
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async terminate() {
    if (this.exited) return;
    await new Promise<void>((resolve) => {
      let force: NodeJS.Timeout;
      const finish = () => {
        clearTimeout(force);
        resolve();
      };
      this.child.once("close", finish);
      try {
        if (process.platform !== "win32" && this.child.pid)
          process.kill(-this.child.pid, "SIGTERM");
        else this.child.kill("SIGTERM");
      } catch {}
      force = setTimeout(() => {
        try {
          if (process.platform !== "win32" && this.child.pid)
            process.kill(-this.child.pid, "SIGKILL");
          else this.child.kill("SIGKILL");
        } catch {}
      }, 3000);
    });
  }
}
