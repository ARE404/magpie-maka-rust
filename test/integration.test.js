import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { session, reconcile, desired } from "../sync.js";
import { connect } from "../maka-rust.agent.js";

test("only local gateways and an enabled default model are accepted", () => {
	const args = {
		gateway: { v1: "http://localhost:5555/v1", key: "fixture" },
		model: { id: "one" },
		models: [{ id: "one" }, { id: "two" }],
	};
	const value = connect(args);
	assert.deepEqual(desired(value).models, ["one", "two"]);
	assert.throws(() => desired({ ...value, model: "unknown" }));
	assert.throws(() =>
		desired({ ...value, baseUrl: "http://localhost.example.org/v1" }),
	);
	assert.equal(desired({}), null);
});

test("real Magpie switches a running isolated Rust Host and restores its original default", {
	skip: !process.env.MAGPIE_TEST_BIN || !process.env.MAKA_EMPTY_TEST_ROOT,
}, async () => {
	const home = await mkdtemp(join(tmpdir(), "magpie-rust-test-"));
	const dir = join(home, ".magpie-maka-rust");
	const cfg = join(home, ".config/magpie");
	const plugin = resolve(import.meta.dirname, "..");
	const env = {
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local/share"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PATH: process.env.PATH,
		MAGPIE_PLUGIN_MARKET: "off",
		MAGPIE_ADDR: "127.0.0.1:48763",
	};
	const run = (...args) =>
		execFileSync(process.env.MAGPIE_TEST_BIN, args, {
			env,
			stdio: "pipe",
			timeout: 30000,
		});
	try {
		await mkdir(join(home, ".maka"), { recursive: true });
		await mkdir(cfg, { recursive: true });
		await mkdir(dir, { mode: 0o700 });
		await writeFile(
			join(cfg, "plugins.json"),
			JSON.stringify({ plugins: [{ spec: plugin }] }),
		);
		await writeFile(
			join(cfg, "providers.json"),
			JSON.stringify({
				providers: [
					{
						id: "fixture",
						name: "Fixture",
						chat: "http://127.0.0.1:1/v1",
						key: "fixture-only",
						models: ["one", "two"],
					},
				],
			}),
		);
		assert.match(run("ls").toString(), /Maka \(Rust\)/);
		await session(process.env.MAKA_EMPTY_TEST_ROOT, dir, async (call, id) => {
			const page = () => call("connections", { kind: "start" });
			const baseline = await page();
			assert.equal(
				baseline.connections.length,
				0,
				"integration test requires a disposable empty Host",
			);
			let state = null;
			const persist = (s) => {
				state = structuredClone(s);
			};
			for (const model of ["one", "two"]) {
				run("maka-rust", "fixture/" + model);
				const want = desired(
					JSON.parse(await readFile(join(dir, "desired.json"))),
				);
				assert.equal(
					await reconcile(call, id, want, state, persist),
					"current",
				);
				assert.equal((await page()).defaultTarget.modelId, "fixture/" + model);
				assert.equal(
					await reconcile(call, id, want, state, persist),
					"current",
				);
			}
			run("maka-rust", "default");
			const restored = await readFile(join(dir, "desired.json"), "utf8").catch(
				(e) => {
					if (e.code === "ENOENT") return "{}";
					throw e;
				},
			);
			assert.equal(desired(JSON.parse(restored)), null);
			assert.equal(await reconcile(call, id, null, state, persist), "restored");
			assert.deepEqual((await page()).defaultTarget, baseline.defaultTarget);
			assert.equal((await page()).connections.length, 0);
		});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
