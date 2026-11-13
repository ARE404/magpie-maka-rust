import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { directory } from "./sync.js";

const instance = Symbol.for("magpie.maka-rust.bridge");

export default function MakaRust() {
  if (process.platform !== "darwin" || globalThis[instance]) return {};
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The persistent lock file serializes workers across host reloads. The kernel
  // releases its lock even when a worker or the Bun host exits unexpectedly.
  const args = ["-k", "-t", "50", join(directory, "sync.lock"), process.execPath,
    fileURLToPath(new URL("./sync.js", import.meta.url))];
  const options = { stdio: "ignore" };
  let active = false;
  let pending = false;
  let timer;
  function tick() {
    if (active) { pending = true; return; }
    active = true;
    const child = spawn("/usr/bin/lockf", args, options);
    child.on("error", (err) => console.error("Maka sync worker:", err.message));
    child.once("close", () => {
      active = false;
      if (pending) { pending = false; tick(); }
    });
  }
  const watcher = watch(directory, (_, name) => {
    if (name !== "desired.json") return;
    clearTimeout(timer);
    timer = setTimeout(tick, 100);
  });
  const retry = setInterval(tick, 10000);
  globalThis[instance] = true;
  process.once("exit", () => {
    clearTimeout(timer);
    clearInterval(retry);
    watcher.close();
    // Magpie may restore desired.json just before shutting down the host.
    spawnSync("/usr/bin/lockf", args, { ...options, timeout: 55000 });
  });
  tick();
  return {};
}
