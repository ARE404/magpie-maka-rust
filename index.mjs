import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { directory } from "./sync.js";

const instance = Symbol.for("magpie.maka-rust.bridge");

export default function MakaRust() {
  if (!["darwin", "win32"].includes(process.platform) || globalThis[instance]) return {};
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const worker = fileURLToPath(new URL("./sync.js", import.meta.url));
  // On Windows the native helper holds the lease. On macOS lockf wraps Bun.
  const windows = process.platform === "win32";
  const command = windows ? process.execPath : "/usr/bin/lockf";
  const args = windows ? [worker] : ["-k", "-t", "50", join(directory, "sync.lock"), process.execPath, worker];
  const options = { stdio: "ignore", windowsHide: true };
  let active = false;
  let pending = false;
  let timer;
  function tick() {
    if (active) { pending = true; return; }
    active = true;
    const child = spawn(command, args, options);
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
    spawnSync(command, args, { ...options, timeout: 55000 });
  });
  tick();
  return {};
}
