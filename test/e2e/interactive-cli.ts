import { access, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { IPty } from "node-pty";
import {
	assert,
	cleanupRealE2E,
	cliPath,
	ensureBuilt,
	parseJson,
	requireRealE2E,
	runCli,
	setupRealE2E,
	sleep,
	waitForAssistantTurn,
	waitForLiveManagedSession,
} from "./support.js";

async function ensureNodePtyHelperExecutable(): Promise<void> {
	// npm allow-scripts can skip node-pty's postinstall, leaving the prebuilt helper non-executable.
	if (process.platform !== "darwin") return;
	const require = createRequire(import.meta.url);
	const packageJson = require.resolve("node-pty/package.json");
	const helper = path.join(path.dirname(packageJson), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
	await chmod(helper, 0o755).catch(() => undefined);
}

if (!requireRealE2E("interactive CLI E2E")) process.exit(0);
ensureBuilt();
await ensureNodePtyHelperExecutable();
const pty = await import("node-pty");

type PtyProcess = IPty;

async function startInteractive(ctx: Awaited<ReturnType<typeof setupRealE2E>>, args: string[], label: string): Promise<{ proc: PtyProcess; output: () => string }> {
	let output = "";
	const proc = pty.spawn(process.execPath, [cliPath, ...args], {
		name: "xterm-256color",
		cols: 120,
		rows: 40,
		cwd: process.cwd(),
		env: Object.fromEntries(Object.entries(ctx.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	});
	proc.onData((data) => {
		output += data;
		if (output.length > 20_000) output = output.slice(-20_000);
	});
	proc.onExit((event) => {
		if (event.exitCode !== 0) {
			console.error(`${label} exited with ${event.exitCode}`);
			console.error(output);
		}
	});
	return { proc, output: () => output };
}

async function stopInteractive(handle: { proc: PtyProcess; output: () => string }, label: string): Promise<void> {
	let exited = false;
	const exitPromise = new Promise<void>((resolve) => {
		handle.proc.onExit(() => {
			exited = true;
			resolve();
		});
	});

	handle.proc.write("\x03");
	await sleep(80);
	handle.proc.write("\x03");
	await Promise.race([
		exitPromise,
		(async () => {
			await sleep(12_000);
			if (!exited) handle.proc.kill("SIGTERM");
			await sleep(2000);
			if (!exited) handle.proc.kill("SIGKILL");
		})(),
	]);
	if (!exited) throw new Error(`Timed out stopping ${label}\nPTY output:\n${handle.output()}`);
}

const ctx = await setupRealE2E();
console.log(`Interactive CLI E2E temp root: ${ctx.root}`);
console.log(`Model: ${ctx.model}`);

const started: Array<{ handle: { proc: PtyProcess; output: () => string }; label: string }> = [];

try {
	const live = await startInteractive(ctx, [
		"run",
		"--name",
		"e2e-live",
		"--folder",
		ctx.folder,
		"--model",
		ctx.model,
		"--thinking",
		"off",
	], "e2e-live run");
	started.push({ handle: live, label: "e2e-live run" });

	await waitForLiveManagedSession(ctx, "e2e-live", 90_000);
	const livePrompt = "Reply with one short sentence containing PI_MESH_E2E_LIVE_OK.";
	const liveSend = parseJson(await runCli(ctx, ["send", "e2e-live", livePrompt, "--json"], { timeoutMs: 240_000 }));
	assert(liveSend.ok === true, "live send did not report ok=true");
	assert(liveSend.results?.[0]?.delivery === "live", `expected live delivery, got ${liveSend.results?.[0]?.delivery}\nPTY output:\n${live.output()}`);
	await waitForAssistantTurn(ctx, "e2e-live", "PI_MESH_E2E_LIVE_OK", "PI_MESH_E2E_LIVE_OK", 90_000);
	await stopInteractive(live, "e2e-live run");
	started.pop();

	const sourcePrompt = "Reply with one short sentence containing PI_MESH_E2E_ATTACH_SOURCE_OK.";
	const source = parseJson(await runCli(ctx, [
		"spawn",
		"--name",
		"e2e-src",
		"--folder",
		ctx.folder,
		"--model",
		ctx.model,
		"--thinking",
		"off",
		"--prompt",
		sourcePrompt,
		"--json",
	], { timeoutMs: 240_000 }));
	assert(source.session?.sessionFile, "attach source spawn did not return a session file");
	await access(source.session.sessionFile);

	const attached = await startInteractive(ctx, [
		"attach",
		source.session.sessionFile,
		"--name",
		"e2e-att",
	], "e2e-att attach");
	started.push({ handle: attached, label: "e2e-att attach" });
	await waitForLiveManagedSession(ctx, "e2e-att", 90_000);

	const attachPrompt = "Reply with one short sentence containing PI_MESH_E2E_ATTACHED_OK.";
	const attachSend = parseJson(await runCli(ctx, ["send", "e2e-att", attachPrompt, "--json"], { timeoutMs: 240_000 }));
	assert(attachSend.ok === true, "attached send did not report ok=true");
	assert(attachSend.results?.[0]?.delivery === "live", `expected live delivery for attached session, got ${attachSend.results?.[0]?.delivery}\nPTY output:\n${attached.output()}`);
	await waitForAssistantTurn(ctx, "e2e-att", "PI_MESH_E2E_ATTACHED_OK", "PI_MESH_E2E_ATTACHED_OK", 90_000);
	await stopInteractive(attached, "e2e-att attach");
	started.pop();

	console.log("Interactive CLI E2E passed.");
} finally {
	while (started.length) {
		const item = started.pop()!;
		await stopInteractive(item.handle, item.label).catch((error) => console.error((error as Error).message));
	}
	await cleanupRealE2E(ctx);
}
