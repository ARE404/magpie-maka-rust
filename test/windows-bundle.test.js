import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = new URL("../bin/magpie-maka-helper.exe", import.meta.url);
test("the plugin ships the Windows x64 client and its unwind runtime", async () => {
  for (const file of [helper, new URL("../bin/libunwind.dll", import.meta.url)]) {
    const binary = await readFile(file);
    const offset = binary.readUInt32LE(0x3c);
    assert.equal(binary.toString("ascii", offset, offset + 4), "PE\0\0");
    assert.equal(binary.readUInt16LE(offset + 4), 0x8664);
  }
});
test("the Windows client starts without a developer toolchain", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync(fileURLToPath(helper), [], { encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected Maka root and client journal paths/);
});
