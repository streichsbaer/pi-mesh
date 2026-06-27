import { access } from "node:fs/promises";
import {
	assert,
	cleanupRealE2E,
	ensureBuilt,
	getTranscript,
	parseJson,
	requireRealE2E,
	runCli,
	setupRealE2E,
	waitForAssistantTurn,
} from "./support.js";

if (!requireRealE2E("real CLI E2E")) process.exit(0);
ensureBuilt();

const ctx = await setupRealE2E();
console.log(`Real CLI E2E temp root: ${ctx.root}`);
console.log(`Model: ${ctx.model}`);

try {
	const models = parseJson(await runCli(ctx, ["models", "list", ctx.model.split("/").at(-1) ?? ctx.model, "--cwd", ctx.workspace, "--all", "--json"], { timeoutMs: 60_000 }));
	const selectedModel = models.models?.find((item: any) => item.ref === ctx.model);
	assert(selectedModel, `Expected ${ctx.model} in models list`);
	assert(selectedModel.available === true, `Expected ${ctx.model} to be auth-configured/available`);

	const spawnPrompt = "Reply with one short sentence containing PI_MESH_E2E_HEADLESS_OK.";
	const spawned = parseJson(await runCli(ctx, [
		"spawn",
		"--name",
		"e2e-headless",
		"--cwd",
		ctx.workspace,
		"--workspace",
		ctx.workspace,
		"--model",
		ctx.model,
		"--thinking",
		"off",
		"--prompt",
		spawnPrompt,
		"--json",
	], { timeoutMs: 240_000 }));
	assert(spawned.ok === true, "spawn JSON did not report ok=true");
	assert(spawned.session?.sessionFile, "spawn did not return a session file");
	await access(spawned.session.sessionFile);
	await waitForAssistantTurn(ctx, "e2e-headless", "PI_MESH_E2E_HEADLESS_OK", "PI_MESH_E2E_HEADLESS_OK", 90_000);

	const sendPrompt = "Reply with one short sentence containing PI_MESH_E2E_SEND_OK.";
	const sent = parseJson(await runCli(ctx, [
		"send",
		"e2e-headless",
		sendPrompt,
		"--workspace",
		ctx.workspace,
		"--json",
	], { timeoutMs: 240_000 }));
	assert(sent.ok === true, "send JSON did not report ok=true");
	assert(sent.delivery === "wake", `expected wake delivery, got ${sent.delivery}`);
	await waitForAssistantTurn(ctx, "e2e-headless", "PI_MESH_E2E_SEND_OK", "PI_MESH_E2E_SEND_OK", 90_000);

	const state = parseJson(await runCli(ctx, ["state", "e2e-headless", "--workspace", ctx.workspace, "--json"], { timeoutMs: 30_000 }));
	assert(state.ok === true, "state JSON did not report ok=true");
	assert(state.counts?.turns >= 2, `expected at least two turns, got ${state.counts?.turns}`);

	const transcript = await getTranscript(ctx, "e2e-headless", 3);
	assert(transcript.ok === true, "transcript JSON did not report ok=true");
	assert(transcript.turns?.length >= 2, "transcript did not contain the expected turns");

	console.log("Real CLI E2E passed.");
} finally {
	await cleanupRealE2E(ctx);
}
