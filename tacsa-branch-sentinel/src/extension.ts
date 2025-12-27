import * as vscode from "vscode";

type RepoInfo = {
	name: string;
	branch: string | null;
	path: string;
	hasRemote: boolean;
};

type RepoRule = { prod?: string[]; dev?: string[]; neutral?: string[] };
type RepoRules = Record<string, RepoRule>;

type Mode = "prod" | "dev" | "neutral" | "unknown" | "local";
type RuleMode = "prod" | "dev" | "neutral";

const CFG_KEY_TINT_ENABLED = "tacsaBranchSentinel.enableStatusBarTint";
const CFG_REPO_RULES = "tacsaBranchSentinel.repoRules";
const CFG_PINNED = "tacsaBranchSentinel.pinnedRepos";

function cfg() {
	return vscode.workspace.getConfiguration();
}

function codicon(name: string) {
	return `$(${name})`;
}

function truncateName(name: string, max = 10): string {
	return name.length <= max ? name : name.slice(0, max) + "…";
}

function getRepoRules(): RepoRules {
	return (cfg().get(CFG_REPO_RULES) ?? {}) as RepoRules;
}

function getPinnedRepos(): string[] {
	const arr = cfg().get<string[]>(CFG_PINNED, []);
	return Array.isArray(arr) ? arr.filter(Boolean) : [];
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

function getIconSetting(
	key: "iconProd" | "iconDev" | "iconNeutral",
	fallback: string,
) {
	return String(cfg().get(`tacsaBranchSentinel.${key}`, fallback)).trim();
}

// ---------- Pattern matching for repoRules ----------

function matchesPattern(branch: string, pattern: string): boolean {
	const b = branch.toLowerCase();
	const p = pattern.toLowerCase().trim();
	if (!p) return false;

	if (!p.includes("*")) return b === p;

	const parts = p.split("*").filter(Boolean);
	if (parts.length === 0) return true; // "*" matches anything

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

// ---------- Mode / icon ----------

function modeFor(repo: RepoInfo): Mode {
	// Local-only repo? Visual identity.
	if (!repo.hasRemote) return "local";

	const b = (repo.branch ?? "").toLowerCase();
	const rules = getRepoRules()[repo.name];

	if (rules && repo.branch) {
		if (listMatches(repo.branch, rules.prod)) return "prod";
		if (listMatches(repo.branch, rules.dev)) return "dev";
		if (listMatches(repo.branch, rules.neutral)) return "neutral";
	}

	if (b === "master" || b === "main") return "prod";
	if (b === "dev") return "dev";
	return "unknown";
}

function iconForMode(mode: Mode): string {
	if (mode === "prod") return codicon(getIconSetting("iconProd", "shield"));
	if (mode === "dev") return codicon(getIconSetting("iconDev", "tools"));
	if (mode === "neutral")
		return codicon(getIconSetting("iconNeutral", "git-branch"));
	if (mode === "local") return codicon("lock");
	return codicon("question");
}

// Backgrounds for the *secondary* item (theme colors only)
function backgroundForMode(mode: Mode): vscode.ThemeColor | undefined {
	if (mode === "prod")
		return new vscode.ThemeColor("statusBarItem.errorBackground");
	if (mode === "unknown")
		return new vscode.ThemeColor("statusBarItem.warningBackground");
	// Optional: dev highlight (you can remove this if you want dev to be “default”)
	if (mode === "dev")
		return new vscode.ThemeColor("statusBarItem.prominentBackground");
	return undefined;
}

// ---------- Global status bar tint (workspace) ----------

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
	} else if (mode === "unknown") {
		next["statusBar.background"] = "#b36b00";
		next["statusBar.foreground"] = "#ffffff";
		next["statusBar.debuggingBackground"] = "#b36b00";
	} else if (mode === "local") {
		next["statusBar.background"] = "#5b2b82";
		next["statusBar.foreground"] = "#ffffff";
		next["statusBar.debuggingBackground"] = "#5b2b82";
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

function uniq(arr: string[]) {
	return Array.from(new Set(arr));
}

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

	next.prod = (next.prod ?? []).filter(
		(x) => x.toLowerCase() !== b.toLowerCase(),
	);
	next.dev = (next.dev ?? []).filter(
		(x) => x.toLowerCase() !== b.toLowerCase(),
	);
	next.neutral = (next.neutral ?? []).filter(
		(x) => x.toLowerCase() !== b.toLowerCase(),
	);

	if (mode === "prod") next.prod = uniq([...(next.prod ?? []), b]);
	else if (mode === "dev") next.dev = uniq([...(next.dev ?? []), b]);
	else next.neutral = uniq([...(next.neutral ?? []), b]);

	rulesAll[repoName] = next;

	await cfg().update(
		CFG_REPO_RULES,
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

// ---------- Commands ----------

/**
 * FIX: Allow selecting ANY repo (including the active one).
 * We still *hide* the active repo from the status bar display later,
 * but we do not block selecting it, because that creates UX traps.
 */
async function pickPinnedReposAnyRepo() {
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
			detail: !r.hasRemote ? "local-only (no remote)" : undefined,
			picked: current.has(r.name),
		})),
		{
			canPickMany: true,
			placeHolder:
				"Select repos to track (active repo is hidden from this display automatically)",
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
		`TacSA: tracking ${selected.length} repo(s).`,
	);
}

async function pickIcons() {
	const choices = [
		"shield",
		"tools",
		"git-branch",
		"beaker",
		"rocket",
		"bug",
		"warning",
		"check",
		"circle-large-outline",
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
		CFG_REPO_RULES,
		rulesAll,
		vscode.ConfigurationTarget.Workspace,
	);

	vscode.window.showInformationMessage(
		`TacSA: Repo rules saved for ${active.name} (workspace).`,
	);
}

// ---------- Extension entry ----------

export function activate(context: vscode.ExtensionContext) {
	// Item A: shows *tracked repos* (never the active one)
	const trackedItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		998,
	);
	trackedItem.name = "TacSA Branch Sentinel (Tracked repos)";
	trackedItem.command = "tacsa-branch-sentinel.pickPinnedRepos";
	trackedItem.show();

	let lastTintMode: Mode | null = null;
	let lastWarnedKey: string | null = null;

	const update = async () => {
		const infos = await getRepoInfos();

		if (infos.length === 0) {
			trackedItem.text = "⎇ No Git repo";
			trackedItem.tooltip =
				"TacSA Branch Sentinel: No Git repositories detected.";
			trackedItem.backgroundColor = undefined;
			return;
		}

		const active = chooseActiveRepo(infos);
		const activeMode = modeFor(active);

		// --- Global tint follows ACTIVE repo only
		if (isTintEnabled()) {
			if (activeMode !== lastTintMode) {
				lastTintMode = activeMode;
				await setStatusBarTheme(activeMode);
			}
		} else if (lastTintMode !== "neutral") {
			lastTintMode = "neutral";
			await setStatusBarTheme("neutral");
		}

		// One-time prod warning for ACTIVE repo only
		const warnKey = `${active.name}:${active.branch ?? "DETACHED"}`;
		if (activeMode === "prod" && lastWarnedKey !== warnKey) {
			lastWarnedKey = warnKey;
			vscode.window.showWarningMessage(
				`You are on ${active.name} → ${active.branch}. Be careful.`,
				"OK",
			);
		}

		// --- Only show the tracker item when this is truly a multi-repo workspace
		const othersExist = infos.some((r) => r.name !== active.name);
		if (!othersExist) {
			trackedItem.hide();
			return;
		}
		trackedItem.show();

		// Pinned = user’s persistent selection (can include the active repo).
		// IMPORTANT: we never mutate it in update(), only in the picker command.
		const pinnedAll = getPinnedRepos();

		// Always compute “display list” as pinned minus active
		const pinnedToDisplay = pinnedAll.filter((n) => n !== active.name);

		// UX FIX:
		// - If nothing pinned at all -> show "select repos"
		// - If something is pinned, but right now it all collapses to active/missing -> ALSO show "select repos"
		//   (so you don’t lose the clickable status bar entry)
		if (pinnedAll.length === 0) {
			trackedItem.text = `${codicon("list-selection")} select repos`;
			trackedItem.tooltip =
				"TacSA Branch Sentinel:\nClick to select repos to track.\n(Active repo is hidden from this display automatically.)";
			trackedItem.backgroundColor = undefined;
			return;
		}

		// Map pinned-to-display into actual repos present in this workspace
		const selectedInfos = pinnedToDisplay
			.map((name) => infos.find((r) => r.name === name))
			.filter(Boolean) as RepoInfo[];

		// If nothing to show (because the only pinned repo is now active, or pinned repos aren’t present):
		// keep the item visible with a “select repos” prompt.
		if (selectedInfos.length === 0) {
			trackedItem.text = `${codicon("list-selection")} select repos`;
			trackedItem.tooltip =
				"TacSA Branch Sentinel:\nNothing to display (your tracked repo is currently active, or not in this workspace).\nClick to update selection.";
			trackedItem.backgroundColor = undefined;
			return;
		}

		// Build a clipped list (show first N, then +remaining)
		const maxShown = 2;
		const shown = selectedInfos.slice(0, maxShown);
		const remaining = selectedInfos.length - shown.length;

		const parts = shown.map((r) => {
			const m = modeFor(r);
			const icon = iconForMode(m);
			const nm = truncateName(r.name, 10);
			const br = r.branch ?? "DETACHED";
			return `${icon} ${nm}•${br}`;
		});

		const suffix = remaining > 0 ? ` +${remaining}` : "";
		trackedItem.text = `+ ${parts.join(" | ")}${suffix}`;

		// Colour based on the “worst” mode among what we’re currently showing.
		// If you have one repo on main (prod) and one on dev -> prod wins -> red.
		const severityRank: Record<Mode, number> = {
			prod: 5,
			unknown: 4,
			dev: 3,
			local: 2,
			neutral: 1,
		};

		const worst = shown
			.map(modeFor)
			.sort((a, b) => severityRank[b] - severityRank[a])[0];

		trackedItem.backgroundColor = backgroundForMode(worst);

		// Tooltip includes ALL displayed pinned (not clipped)
		trackedItem.tooltip = selectedInfos
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
			"tacsa-branch-sentinel.pickPinnedRepos",
			async () => {
				// FIX: allow selecting ANY repo from anywhere (including the active one).
				// Active is hidden only in the display logic.
				await pickPinnedReposAnyRepo();
				await update();
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
			"tacsa-branch-sentinel.markProd",
			async () => {
				const ctx = await getActiveRepoAndBranch();
				if (!ctx) return;
				await upsertRule("prod", ctx.repo.name, ctx.branch);
				await update();
			},
		),
		vscode.commands.registerCommand(
			"tacsa-branch-sentinel.markDev",
			async () => {
				const ctx = await getActiveRepoAndBranch();
				if (!ctx) return;
				await upsertRule("dev", ctx.repo.name, ctx.branch);
				await update();
			},
		),
		vscode.commands.registerCommand(
			"tacsa-branch-sentinel.markNeutral",
			async () => {
				const ctx = await getActiveRepoAndBranch();
				if (!ctx) return;
				await upsertRule("neutral", ctx.repo.name, ctx.branch);
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
