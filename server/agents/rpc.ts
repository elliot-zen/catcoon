import { EventEmitter } from "node:events";
/** IDs are direction-specific: server requests never resolve a client call. */
export class Rpc extends EventEmitter {
  sequence = 0;
  pending = new Map<
    string | number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  send: (message: any) => void;
  constructor(send: (message: any) => void) {
    super();
    this.send = send;
  }
  call(method: string, params: any = {}) {
    const id = `relay-${++this.sequence}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC response unknown: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  receive(message: any) {
    if (message.method || (message.type && message.type !== "response")) {
      this.emit("message", message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error || message.success === false)
      entry.reject(
        new Error(message.error?.message || message.error || "RPC rejected"),
      );
    else entry.resolve(message.result ?? message.data);
  }
  disconnect(reason: string) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    this.emit("disconnect", reason);
  }
}
export function agentEnv() {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  return env;
}
