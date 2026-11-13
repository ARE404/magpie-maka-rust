import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const directory = join(homedir(), ".magpie-maka-rust");
export async function json(path, fallback) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (err) {
		if (err.code === "ENOENT") return fallback;
		throw err;
	}
}
export async function save(path, value) {
	const tmp = path + "." + randomUUID();
	try {
		await writeFile(tmp, JSON.stringify(value) + "\n", {
			mode: 0o600,
			flag: "wx",
		});
		await rename(tmp, path);
	} finally {
		await rm(tmp, { force: true });
	}
}
export function desired(value) {
	if (
		value === null ||
		(typeof value === "object" &&
			!Array.isArray(value) &&
			!("version" in value) &&
			!value.apiKey &&
			!value.baseUrl &&
			!value.models)
	)
		return null;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("Invalid Magpie configuration");
	const url = new URL(value.baseUrl);
	if (
		value.version !== 1 ||
		url.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		typeof value.apiKey !== "string" ||
		!value.apiKey.trim() ||
		!Array.isArray(value.models) ||
		value.models.length > 512 ||
		!value.models.includes(value.model) ||
		value.models.some((id) => typeof id !== "string" || !id.trim())
	)
		throw Error("Invalid local Magpie configuration");
	return { ...value, baseUrl: url.toString().replace(/\/+$/, "") };
}
async function catalog(call) {
	let page = await call("connections", { kind: "start" });
	const first = page,
		rows = [];
	for (;;) {
		if (page.kind !== "ready" || page.revision !== first.revision)
			throw Error("Connection catalog changed; retry");
		rows.push(...page.connections);
		if (page.next == null) break;
		page = await call("connections", {
			kind: "continue",
			revision: first.revision,
			offset: page.next,
		});
	}
	return { ...first, row: rows.find((x) => x.slug === "magpie-rust") };
}
const check = (r, kind = "committed") => {
	if (r?.kind !== kind)
		throw Error("Maka declined the Settings change: " + (r?.kind ?? "unknown"));
	return r;
};
const basis = (d) => ({
	connectionId: d.target.connectionId,
	revision: d.target.revision,
});
async function detail(call, id) {
	return check(
		await call("connection", { connectionId: id, includeEditingFacts: true }),
		"ready",
	);
}
async function cred(call, id) {
	const locator = { scope: "connection", connectionId: id, kind: "provider" };
	const { status } = check(
		await call("credentialStatus", { locator }),
		"status",
	);
	return status.configured
		? { credentialId: status.credentialId, revision: status.revision, locator }
		: null;
}
async function provider(call) {
	let offset = 0;
	do {
		const page = await call("providers", { offset });
		const match = page.providers.find(
			(p) => p.identity.name === "openai-compatible" && p.customEndpoint,
		);
		if (match) return match.identity;
		offset = page.next;
	} while (offset != null);
	throw Error("Maka has no Chat Completions provider");
}
export async function reconcile(call, rootId, want, state, persist) {
	let cat = await catalog(call);
	if (!state) {
		if (!want) return "idle";
		if (cat.row)
			throw Error("The magpie-rust connection already exists; keeping it");
		state = {
			rootId,
			baseline: cat.defaultTarget,
			default: cat.defaultTarget,
			manageDefault: true,
		};
		await persist(state);
	}
	if (state.rootId !== rootId)
		throw Error("The configured Maka root has changed");
	let id = state.id;
	if (!id && cat.row)
		throw Error("An unclaimed connection exists; refusing takeover");
	if (!id && !want) {
		await persist(null);
		return "idle";
	}
	if (!id) {
		const created = check(
			await call("create", {
				expectedCatalogRevision: cat.revision,
				connection: {
					slug: "magpie-rust",
					name: "Magpie",
					provider: await provider(call),
					configuration: { baseUrl: want.baseUrl },
					enabled: true,
					enabledModelIds: want.models,
				},
			}),
		);
		id = created.connection.connectionId;
		Object.assign(state, {
			id,
			revision: created.connection.revision,
			credential: null,
		});
		await persist(state);
	}
	let d = await detail(call, id);
	if (
		d.target.revision !== state.revision ||
		!same(await cred(call, id), state.credential)
	)
		throw Error(
			"The Magpie connection or credential changed outside this bridge; preserving it",
		);
	if (want) {
		if (
			!same(d.editing.enabledModelIds, want.models) ||
			d.target.configuration.baseUrl.replace(/\/+$/, "") !== want.baseUrl
		) {
			const updated = check(
				await call("update", {
					expected: basis(d),
					changes: {
						configuration: { ...d.target.configuration, baseUrl: want.baseUrl },
						enabledModelIds: want.models,
					},
				}),
			);
			state.revision = updated.connection.revision;
			await persist(state);
			d = await detail(call, id);
		}
		const digest = createHash("sha256").update(want.apiKey).digest("hex");
		if (state.keyDigest !== digest) {
			check(
				await call(
					"saveCredential",
					{ expected: d.target, expectedCredential: state.credential },
					want.apiKey,
				),
				"saved",
			);
			d = await detail(call, id);
			Object.assign(state, {
				keyDigest: digest,
				revision: d.target.revision,
				credential: await cred(call, id),
			});
			await persist(state);
		}
	}
	cat = await catalog(call);
	if (
		!same(cat.defaultTarget, state.default) &&
		!same(cat.defaultTarget, state.pendingDefault)
	) {
		state.manageDefault = false;
		await persist(state);
	}
	const next = want
		? { connectionId: id, modelId: want.model }
		: state.baseline;
	if (state.manageDefault && !same(cat.defaultTarget, next)) {
		state.pendingDefault = next;
		await persist(state);
		check(
			await call("setDefault", {
				expectedCatalogRevision: cat.revision,
				target: next,
			}),
		);
	}
	if (
		state.manageDefault &&
		(!same(state.default, next) || "pendingDefault" in state)
	) {
		state.default = next;
		delete state.pendingDefault;
		await persist(state);
	}
	if (!want) {
		check(await call("remove", { expected: basis(d) }));
		await persist(null);
		return "restored";
	}
	return "current";
}
export async function session(root, dir, fn) {
	const child = spawn(
		join(here, "bin/magpie-maka-helper"),
		[root, join(dir, "client.sqlite")],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	const lines = createInterface({ input: child.stdout })[
		Symbol.asyncIterator
	]();
	const failed = new Promise((_, reject) => child.once("error", reject));
	failed.catch(() => {});
	child.stderr.resume();
	child.stdin.on("error", () => {});
	async function read() {
		const { value, done } = await Promise.race([lines.next(), failed]);
		if (done) throw Error("Maka Rust Host unreachable or helper incompatible");
		return JSON.parse(value);
	}
	const timer = setTimeout(() => child.kill(), 45000);
	try {
		const { rootId } = await read();
		return await fn(async (method, input, secret) => {
			child.stdin.write(JSON.stringify({ method, input, secret }) + "\n");
			const reply = await read();
			if (reply.error) throw Error(method + ": " + reply.error);
			return reply.ok;
		}, rootId);
	} finally {
		clearTimeout(timer);
		child.stdin.end();
	}
}
export async function run({ dir = directory } = {}) {
  const config = await json(join(dir, "bridge.json"), {});
  const root = config.root || join(homedir(), ".maka/application/host");
  const want = desired(await json(join(dir, "desired.json"), null));
  const file = join(dir, "state.json");
  const state = await json(file, null);
  if (!want && !state) return "idle";
  return await session(root, dir, (call, id) =>
    reconcile(call, id, want, state, (s) => save(file, s)),
  );
}

// Invoked by the Magpie Bun host under a kernel lock, including on normal exit.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const status = await run();
    await save(join(directory, "status.json"), { status, at: new Date().toISOString() });
  } catch (err) {
    await save(join(directory, "status.json"), { status: "error", message: err.message, at: new Date().toISOString() });
    process.exitCode = 1;
  }
}
