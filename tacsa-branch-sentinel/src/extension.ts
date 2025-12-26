import * as vscode from "vscode";

type RepoInfo = { name: string; branch: string | null; path: string };

type RepoRule = { prod?: string[]; dev?: string[]; neutral?: string[] };
type RepoRules = Record<string, RepoRule>;

type Mode = "prod" | "dev" | "neutral";

const CFG_KEY_TINT_ENABLED = "tacsaBranchSentinel.enableStatusBarTint";

// ---------- Config helpers ----------

function cfg() {
	return vscode.workspace.getConfiguration();
}

function isTintEnabled(): boolean {
	return cfg().get<boolean>(CFG_KEY_TINT_ENABLED, true);
}

async function setTintEnabled(enabled: boolean) {
	await cfg().update(
		CFG_KEY_TINT_ENABLED,
		enabled,
		vscode.ConfigurationTarget.Workspace,
	);
}

function getRepoRules(): RepoRules {
	return (cfg().get("tacsaBranchSentinel.repoRules") ?? {}) as RepoRules;
}

function getIconSetting(
	key: "iconProd" | "iconDev" | "iconNeutral",
	fallback: string,
) {
	return String(cfg().get(`tacsaBranchSentinel.${key}`, fallback)).trim();
}

function codicon(name: string) {
	return `$(${name})`;
}

function uniq(arr: string[]) {
	return Array.from(new Set(arr));
}

async function upsertRule(mode: Mode, repoName: string, branch: string) {
	const rulesAll = getRepoRules();
	const existing: RepoRule = rulesAll[repoName] ?? {
		prod: [],
		dev: [],
		neutral: [],
	};

	const b = branch.trim();
	const next: RepoRule = {
		prod: existing.prod ?? [],
		dev: existing.dev ?? [],
		neutral: existing.neutral ?? [],
	};

	// Remove branch from all buckets first
	next.prod = (next.prod ?? []).filter(
		(x) => x.toLowerCase() !== b.toLowerCase(),
	);
	next.dev = (next.dev ?? []).filter(
		(x) => x.toLowerCase() !== b.toLowerCase(),
	);
	next.neutral = (next.neutral ?? []).filter(
		(x) => x.toLowerCase() !== b.toLowerCase(),
	);

	// Add to selected bucket
	if (mode === "prod") next.prod = uniq([...(next.prod ?? []), b]);
	else if (mode === "dev") next.dev = uniq([...(next.dev ?? []), b]);
	else next.neutral = uniq([...(next.neutral ?? []), b]);

	rulesAll[repoName] = next;

	await cfg().update(
		"tacsaBranchSentinel.repoRules",
		rulesAll,
		vscode.ConfigurationTarget.Workspace,
	);
}

async function getActiveRepoAndBranch(): Promise<{
	repo: RepoInfo;
	branch: string;
} | null> {
	const infos = await getRepoInfos();
	if (infos.length === 0) return null;

	const activeDoc = vscode.window.activeTextEditor?.document?.uri;
	const activePath = activeDoc?.fsPath ?? "";
	const active = infos.find((r) => activePath.startsWith(r.path)) ?? infos[0];

	const branch = active.branch ?? "";
	if (!branch) {
		vscode.window.showWarningMessage(
			"TacSA: No branch detected (detached HEAD?).",
		);
		return null;
	}

	return { repo: active, branch };
}

function ruleSource(
	repoName: string,
	branch: string | null,
): "repo-rule" | "default" {
	const rules = getRepoRules()[repoName];
	if (!rules || !branch) return "default";

	if (listMatches(branch, rules.prod)) return "repo-rule";
	if (listMatches(branch, rules.dev)) return "repo-rule";
	if (listMatches(branch, rules.neutral)) return "repo-rule";

	return "default";
}

function matchesPattern(branch: string, pattern: string): boolean {
	const b = branch.toLowerCase();
	const p = pattern.toLowerCase().trim();
	if (!p) return false;

	// Exact match fast-path
	if (!p.includes("*")) return b === p;

	// Simple wildcard: split on * and ensure parts appear in order
	const parts = p.split("*").filter(Boolean);
	if (parts.length === 0) return true; // pattern "*" matches anything

	let idx = 0;
	for (const part of parts) {
		const found = b.indexOf(part, idx);
		if (found === -1) return false;
		idx = found + part.length;
	}
	return true;
}

function listMatches(branch: string, patterns?: string[]): boolean {
	if (!branch || !patterns || patterns.length === 0) return false;
	return patterns.some((pat) => matchesPattern(branch, pat));
}

// ---------- Branch → mode / icon ----------

function modeFor(repoName: string, branch: string | null): Mode {
	const b = (branch ?? "").toLowerCase();
	const rules = getRepoRules()[repoName];

	// Per-repo override first (supports exact + wildcard patterns)
	if (rules && branch) {
		if (listMatches(branch, rules.prod)) return "prod";
		if (listMatches(branch, rules.dev)) return "dev";
		if (listMatches(branch, rules.neutral)) return "neutral";
	}

	// Defaults
	if (b === "master" || b === "main") return "prod";
	if (b === "dev") return "dev";
	return "neutral";
}

function iconForMode(mode: Mode): string {
	if (mode === "prod") return codicon(getIconSetting("iconProd", "shield"));
	if (mode === "dev") return codicon(getIconSetting("iconDev", "tools"));
	return codicon(getIconSetting("iconNeutral", "git-branch"));
}

// ---------- Status bar tint ----------

async function setStatusBarTheme(mode: Mode) {
	const current = (cfg().get("workbench.colorCustomizations") ?? {}) as Record<
		string,
		any
	>;
	const next = { ...current };

	if (mode === "prod") {
		next["statusBar.background"] = "#7a1111";
		next["statusBar.foreground"] = "#ffffff";
		next["statusBar.debuggingBackground"] = "#7a1111";
	} else if (mode === "dev") {
		next["statusBar.background"] = "#0f6b2f";
		next["statusBar.foreground"] = "#ffffff";
		next["statusBar.debuggingBackground"] = "#0f6b2f";
	} else {
		delete next["statusBar.background"];
		delete next["statusBar.foreground"];
		delete next["statusBar.debuggingBackground"];
	}

	if (JSON.stringify(current) === JSON.stringify(next)) return;

	await cfg().update(
		"workbench.colorCustomizations",
		next,
		vscode.ConfigurationTarget.Workspace,
	);
}

// ---------- VS Code Git API ----------

function repoNameFromUri(uri: vscode.Uri): string {
	const parts = uri.path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? "repo";
}

async function getGitApi() {
	const ext = vscode.extensions.getExtension("vscode.git");
	if (!ext) return undefined;
	await ext.activate();
	return ext.exports.getAPI(1);
}

async function getRepoInfos(): Promise<RepoInfo[]> {
	const git = await getGitApi();
	if (!git) return [];

	return git.repositories.map((repo: any) => {
		const name = repoNameFromUri(repo.rootUri);
		const branch = repo.state.HEAD?.name ?? null;
		const path = repo.rootUri.fsPath;
		return { name, branch, path };
	});
}

// ---------- Commands ----------

async function pickIcons() {
	const choices = [
		"shield",
		"warning",
		"tools",
		"rocket",
		"bug",
		"beaker",
		"flask",
		"check",
		"git-branch",
		"circle-large-outline",
		"circle-slash",
		"zap",
		"wrench",
	];

	const pick = async (label: string, current: string) =>
		vscode.window.showQuickPick(choices, {
			title: `Pick icon for ${label}`,
			placeHolder: `Current: ${current}`,
		});

	const curProd = getIconSetting("iconProd", "shield");
	const curDev = getIconSetting("iconDev", "tools");
	const curNeutral = getIconSetting("iconNeutral", "git-branch");

	const prod = await pick("PROD", curProd);
	if (!prod) return;
	const dev = await pick("DEV", curDev);
	if (!dev) return;
	const neutral = await pick("NEUTRAL", curNeutral);
	if (!neutral) return;

	await cfg().update(
		"tacsaBranchSentinel.iconProd",
		prod,
		vscode.ConfigurationTarget.Workspace,
	);
	await cfg().update(
		"tacsaBranchSentinel.iconDev",
		dev,
		vscode.ConfigurationTarget.Workspace,
	);
	await cfg().update(
		"tacsaBranchSentinel.iconNeutral",
		neutral,
		vscode.ConfigurationTarget.Workspace,
	);

	vscode.window.showInformationMessage("TacSA: Icons updated (workspace).");
}

async function editRepoRules() {
	const infos = await getRepoInfos();
	if (infos.length === 0) return;

	const activeDoc = vscode.window.activeTextEditor?.document?.uri;
	const activePath = activeDoc?.fsPath ?? "";
	const active = infos.find((r) => activePath.startsWith(r.path)) ?? infos[0];

	const rulesAll = getRepoRules();
	const existing: RepoRule = rulesAll[active.name] ?? {
		prod: [],
		dev: [],
		neutral: [],
	};

	const ask = async (label: string, current: string[]) =>
		vscode.window.showInputBox({
			title: `Repo rules for ${active.name}`,
			prompt: `${label} branches (comma-separated)`,
			value: current.join(", "),
		});

	const prod = await ask("PROD", existing.prod ?? []);
	if (prod === undefined) return;
	const dev = await ask("DEV", existing.dev ?? []);
	if (dev === undefined) return;
	const neutral = await ask("NEUTRAL", existing.neutral ?? []);
	if (neutral === undefined) return;

	const toList = (s: string) =>
		s
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean);

	rulesAll[active.name] = {
		prod: toList(prod),
		dev: toList(dev),
		neutral: toList(neutral),
	};

	await cfg().update(
		"tacsaBranchSentinel.repoRules",
		rulesAll,
		vscode.ConfigurationTarget.Workspace,
	);

	vscode.window.showInformationMessage(
		`TacSA: Repo rules saved for ${active.name} (workspace).`,
	);
}

// ---------- Extension entry ----------

export function activate(context: vscode.ExtensionContext) {
	const status = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		1000,
	);
	status.name = "TacSA Branch Sentinel";
	status.command = "tacsa-branch-sentinel.showDetails";
	status.show();

	let lastMode: Mode | null = null;
	let lastWarnedKey: string | null = null;

	const update = async () => {
		const infos = await getRepoInfos();

		if (infos.length === 0) {
			status.text = "⎇ No Git repo";
			status.tooltip = "TacSA Branch Sentinel: No Git repositories detected.";
			return;
		}

		const activeDoc = vscode.window.activeTextEditor?.document?.uri;
		const activePath = activeDoc?.fsPath ?? "";
		const active = infos.find((r) => activePath.startsWith(r.path)) ?? infos[0];

		const more = infos.length > 1 ? ` +${infos.length - 1}` : "";
		const branchLabel = active.branch ?? "DETACHED";

		const mode = modeFor(active.name, active.branch);
		const icon = iconForMode(mode);

		status.text = `${icon} ${active.name} • ${branchLabel}${more}`;
		status.tooltip = infos
			.map(
				(r) =>
					`${iconForMode(modeFor(r.name, r.branch))} ${r.name}: ${
						r.branch ?? "DETACHED"
					}`,
			)
			.join("\n");

		// Warn on prod branches, but don’t spam
		const warnKey = `${active.name}:${active.branch ?? "DETACHED"}`;
		if (mode === "prod" && lastWarnedKey !== warnKey) {
			lastWarnedKey = warnKey;
			vscode.window.showWarningMessage(
				`You are on ${active.name} → ${active.branch}. Be careful.`,
				"OK",
			);
		}

		// Status bar tint (workspace)
		if (isTintEnabled()) {
			if (mode !== lastMode) {
				lastMode = mode;
				await setStatusBarTheme(mode);
			}
		} else {
			if (lastMode !== "neutral") {
				lastMode = "neutral";
				await setStatusBarTheme("neutral");
			}
		}

		const src = ruleSource(active.name, active.branch);
		const suffix = src === "repo-rule" ? " (rule)" : "";
		status.text = `${icon} ${active.name} • ${branchLabel}${more}${suffix}`;

		status.tooltip = infos
			.map((r) => {
				const m = modeFor(r.name, r.branch);
				const s =
					ruleSource(r.name, r.branch) === "repo-rule" ? "rule" : "default";
				return `${iconForMode(m)} ${r.name}: ${r.branch ?? "DETACHED"} [${s}]`;
			})
			.join("\n");
	};

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"tacsa-branch-sentinel.showDetails",
			async () => {
				const infos = await getRepoInfos();
				if (infos.length === 0) {
					vscode.window.showInformationMessage("No Git repositories detected.");
					return;
				}
				vscode.window.showInformationMessage(
					infos.map((r) => `${r.name}: ${r.branch ?? "DETACHED"}`).join(" • "),
				);
			},
		),

		vscode.commands.registerCommand(
			"tacsa-branch-sentinel.enableTint",
			async () => {
				await setTintEnabled(true);
				lastMode = null;
				await update();
				vscode.window.showInformationMessage(
					"TacSA: Status bar tint ENABLED (workspace).",
				);
			},
		),

		vscode.commands.registerCommand(
			"tacsa-branch-sentinel.disableTint",
			async () => {
				await setTintEnabled(false);
				lastMode = null;
				await update();
				vscode.window.showInformationMessage(
					"TacSA: Status bar tint DISABLED (workspace).",
				);
			},
		),

		vscode.commands.registerCommand(
			"tacsa-branch-sentinel.pickIcons",
			pickIcons,
		),
		vscode.commands.registerCommand(
			"tacsa-branch-sentinel.editRepoRules",
			editRepoRules,
		),

		vscode.commands.registerCommand(
			"tacsa-branch-sentinel.markProd",
			async () => {
				const ctx = await getActiveRepoAndBranch();
				if (!ctx) return;
				await upsertRule("prod", ctx.repo.name, ctx.branch);
				vscode.window.showInformationMessage(
					`TacSA: ${ctx.repo.name}/${ctx.branch} marked PROD.`,
				);
				await update();
			},
		),

		vscode.commands.registerCommand(
			"tacsa-branch-sentinel.markDev",
			async () => {
				const ctx = await getActiveRepoAndBranch();
				if (!ctx) return;
				await upsertRule("dev", ctx.repo.name, ctx.branch);
				vscode.window.showInformationMessage(
					`TacSA: ${ctx.repo.name}/${ctx.branch} marked DEV.`,
				);
				await update();
			},
		),

		vscode.commands.registerCommand(
			"tacsa-branch-sentinel.markNeutral",
			async () => {
				const ctx = await getActiveRepoAndBranch();
				if (!ctx) return;
				await upsertRule("neutral", ctx.repo.name, ctx.branch);
				vscode.window.showInformationMessage(
					`TacSA: ${ctx.repo.name}/${ctx.branch} marked NEUTRAL.`,
				);
				await update();
			},
		),
	);

	const timer = setInterval(update, 2000);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });

	vscode.window.onDidChangeActiveTextEditor(
		update,
		null,
		context.subscriptions,
	);
	vscode.window.onDidChangeWindowState(update, null, context.subscriptions);

	update();
}

export function deactivate() {}
