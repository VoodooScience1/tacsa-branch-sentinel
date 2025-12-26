import * as vscode from "vscode";

type RepoInfo = {
	name: string;
	branch: string | null;
	path: string;
	hasRemote: boolean;
};

type RepoRule = { prod?: string[]; dev?: string[]; neutral?: string[] };
type RepoRules = Record<string, RepoRule>;

// Visual modes (tint + icon)
type Mode = "prod" | "dev" | "neutral" | "unknown" | "local";

// Modes that are valid for repoRules
type RuleMode = "prod" | "dev" | "neutral";

const CFG_KEY_TINT_ENABLED = "tacsaBranchSentinel.enableStatusBarTint";
const CFG_PINNED = "tacsaBranchSentinel.pinnedRepos";

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

function getPinnedRepos(): string[] {
	const arr = cfg().get<string[]>(CFG_PINNED, []);
	return Array.isArray(arr) ? arr.filter(Boolean) : [];
}

function truncateName(name: string, max = 10): string {
	if (name.length <= max) return name;
	return name.slice(0, max) + "…";
}

// ---------- Pattern matching for repoRules ----------

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

// ---------- Branch / repo → mode / icon ----------

function modeFor(repo: RepoInfo): Mode {
	// Local-only repo? Give it its own visual identity.
	if (!repo.hasRemote) return "local";

	const b = (repo.branch ?? "").toLowerCase();
	const rules = getRepoRules()[repo.name];

	// Repo overrides first
	if (rules && repo.branch) {
		if (listMatches(repo.branch, rules.prod)) return "prod";
		if (listMatches(repo.branch, rules.dev)) return "dev";
		if (listMatches(repo.branch, rules.neutral)) return "neutral";
	}

	// Defaults
	if (b === "master" || b === "main") return "prod";
	if (b === "dev") return "dev";

	// Not recognised & not rule-mapped
	return "unknown";
}

function iconForMode(mode: Mode): string {
	if (mode === "prod") return codicon(getIconSetting("iconProd", "shield"));
	if (mode === "dev") return codicon(getIconSetting("iconDev", "tools"));
	if (mode === "unknown") return codicon("question");
	if (mode === "local") return codicon("lock");
	return codicon(getIconSetting("iconNeutral", "git-branch"));
}

// ---------- Status bar tint ----------

async function setStatusBarTheme(mode: Mode) {
	// Workspace-scoped: writes to .vscode/settings.json
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
	} else if (mode === "unknown") {
		next["statusBar.background"] = "#b36b00"; // orange
		next["statusBar.foreground"] = "#ffffff";
		next["statusBar.debuggingBackground"] = "#b36b00";
	} else if (mode === "local") {
		next["statusBar.background"] = "#5b2b82"; // purple
		next["statusBar.foreground"] = "#ffffff";
		next["statusBar.debuggingBackground"] = "#5b2b82";
	} else {
		// Neutral => return to theme defaults
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

	// Ensure the Git extension is activated before reading exports
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
		const hasRemote =
			Array.isArray(repo.state.remotes) && repo.state.remotes.length > 0;

		return { name, branch, path, hasRemote };
	});
}

function chooseActiveRepo(infos: RepoInfo[]): RepoInfo {
	const activeDoc = vscode.window.activeTextEditor?.document?.uri;
	const activePath = activeDoc?.fsPath ?? "";
	return infos.find((r) => activePath.startsWith(r.path)) ?? infos[0];
}

// ---------- Repo rules mutation ----------

async function upsertRule(mode: RuleMode, repoName: string, branch: string) {
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

	// Remove from all buckets first
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

	const active = chooseActiveRepo(infos);
	const branch = active.branch ?? "";

	if (!branch) {
		vscode.window.showWarningMessage(
			"TacSA: No branch detected (detached HEAD?).",
		);
		return null;
	}

	return { repo: active, branch };
}

// ---------- Commands (icons / rules / pinned) ----------

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
		"lock",
		"question",
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

	const active = chooseActiveRepo(infos);

	const rulesAll = getRepoRules();
	const existing: RepoRule = rulesAll[active.name] ?? {
		prod: [],
		dev: [],
		neutral: [],
	};

	const ask = async (label: string, current: string[]) =>
		vscode.window.showInputBox({
			title: `Repo rules for ${active.name}`,
			prompt: `${label} branches (comma-separated, supports * wildcards)`,
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

async function pickPinnedRepos() {
	const infos = await getRepoInfos();
	if (infos.length === 0) {
		vscode.window.showInformationMessage("No Git repositories detected.");
		return;
	}

	const current = new Set(getPinnedRepos());

	const picks = await vscode.window.showQuickPick(
		infos.map((r) => ({
			label: r.name,
			description: r.branch ?? "DETACHED",
			picked: current.has(r.name),
		})),
		{
			canPickMany: true,
			placeHolder: "Select repos to pin in the Branch Sentinel display",
		},
	);

	if (!picks) return;

	const selected = picks.map((p) => p.label);
	await cfg().update(
		CFG_PINNED,
		selected,
		vscode.ConfigurationTarget.Workspace,
	);

	vscode.window.showInformationMessage(
		`TacSA: pinned ${selected.length} repo(s) (workspace).`,
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

	let lastTintMode: Mode | null = null;
	let lastWarnedKey: string | null = null;

	const update = async () => {
		const infos = await getRepoInfos();

		if (infos.length === 0) {
			status.text = "⎇ No Git repo";
			status.tooltip = "TacSA Branch Sentinel: No Git repositories detected.";
			return;
		}

		const active = chooseActiveRepo(infos);
		const activeMode = modeFor(active);

		// Tint (workspace) follows ACTIVE repo
		if (isTintEnabled()) {
			if (activeMode !== lastTintMode) {
				lastTintMode = activeMode;
				await setStatusBarTheme(activeMode);
			}
		} else {
			if (lastTintMode !== "neutral") {
				lastTintMode = "neutral";
				await setStatusBarTheme("neutral");
			}
		}

		// One-time prod warning (ACTIVE repo only)
		const warnKey = `${active.name}:${active.branch ?? "DETACHED"}`;
		if (activeMode === "prod" && lastWarnedKey !== warnKey) {
			lastWarnedKey = warnKey;
			vscode.window.showWarningMessage(
				`You are on ${active.name} → ${active.branch}. Be careful.`,
				"OK",
			);
		}

		// Pinned display (optional)
		const pinned = getPinnedRepos();
		const pinnedInfos = pinned
			.map((name) => infos.find((r) => r.name === name))
			.filter(Boolean) as RepoInfo[];

		const activeBranchLabel = active.branch ?? "DETACHED";
		const activeSuffix =
			ruleSource(active.name, active.branch) === "repo-rule" ? " (rule)" : "";
		const activeIcon = iconForMode(activeMode);

		// Active repo always shown first. Then either:
		// - if pinned selection exists: show a compact "+ ..." for pinned group
		// - else: show "+N" count of other repos in workspace
		let rightPart = "";
		if (pinnedInfos.length > 0) {
			const first = pinnedInfos[0];
			const extra = pinnedInfos.length > 1 ? ` +${pinnedInfos.length - 1}` : "";
			const label =
				pinnedInfos.length > 1 ? truncateName(first.name) : first.name;
			const firstIcon = iconForMode(modeFor(first));
			const firstBranch = first.branch ?? "DETACHED";
			rightPart = ` | + ${firstIcon} ${label} • ${firstBranch}${extra}`;
		} else {
			const others = infos.length - 1;
			rightPart = others > 0 ? ` | +${others}` : "";
		}

		status.text = `${activeIcon} ${active.name} • ${activeBranchLabel}${activeSuffix}${rightPart}`;

		// Tooltip: list all repos + state + rule source + local flag
		status.tooltip = infos
			.map((r) => {
				const m = modeFor(r);
				const src =
					ruleSource(r.name, r.branch) === "repo-rule" ? "rule" : "default";
				const remoteTag = r.hasRemote ? "remote" : "local-only";
				return `${iconForMode(m)} ${r.name}: ${r.branch ?? "DETACHED"} [${src}, ${remoteTag}]`;
			})
			.join("\n");
	};

	// Commands
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
				lastTintMode = null;
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
				lastTintMode = null;
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
			"tacsa-branch-sentinel.pickPinnedRepos",
			pickPinnedRepos,
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

	// Update triggers
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
