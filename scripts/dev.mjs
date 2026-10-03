import { spawn } from "node:child_process";
const children = [
  spawn(process.execPath, ["--watch", "server/index.ts"], { stdio: "inherit" }),
  spawn("node", ["node_modules/vite/bin/vite.js"], { stdio: "inherit" }),
];
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const c of children) c.kill(signal);
  });
for (const c of children)
  c.on("exit", () => {
    for (const other of children) if (other !== c) other.kill();
  });
