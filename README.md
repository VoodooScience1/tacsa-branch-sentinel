# TacSA Branch Sentinel

A small VS Code extension that makes it **immediately obvious which Git branch and repository context you are in**, helping prevent accidental changes on production branches.

Built to solve a real, recurring problem when working across **multi-repo workspaces** and environments.

---

## What it does

- Shows **secondary repositories** (never the active one) in the status bar
- Uses **clear visual indicators** per repo:
  - 🛡️ / red background → PROD branches (`main`, `master`)
  - 🛠️ / green background → DEV branches (`dev`)
  - ⚠️ / amber → unknown or unclassified branches
  - 🔒 / purple → local-only repos (no remote)
- Applies **workspace-level status bar tinting** based on the _active_ repository
- Supports **multi-repo workspaces** cleanly without duplicating Git’s own branch indicator
- Shows **clipped repo names** with overflow (`+N`) for dense workspaces
- Provides **one-time warnings** when entering PROD branches
- All behaviour is **workspace-scoped** and opt-in

---

## Why it exists

When juggling multiple repositories, environments, and deployment paths, it’s easy to:

- forget which repo is active
- forget which branch you’re on
- make a “small change” on a production branch by accident

This extension makes that context **unmissable**, without blocking workflows or adding friction.

It’s a _human-factor guardrail_, not an enforcement tool.

---

## Default behaviour

Out of the box, branch classification works as follows:

| Branch        | Mode    |
| ------------- | ------- |
| `main`        | PROD    |
| `master`      | PROD    |
| `dev`         | DEV     |
| anything else | Unknown |

Local-only repositories (no Git remote) are shown as **LOCAL**.

No configuration is required.

---

## Repo-specific overrides (optional)

Branch classification can be overridden per repository, including wildcard support:

```json
{
	"tacsaBranchSentinel.repoRules": {
		"my-repo-name": {
			"prod": ["main", "release/*"],
			"dev": ["dev", "feature/*"],
			"neutral": []
		}
	}
}
```

- Rules are workspace-local
- Fully opt-in
- No effect outside the current workspace

---

## Tracking other repositories

In multi-repo workspaces, the extension **never duplicates the active repo** already shown by Git.

Instead, you explicitly choose which other repositories to track:

- Click the status bar item, or
- Run the command below

If nothing is selected, the status bar prompts you to choose.

---

## Commands

Available via Cmd + Shift + P:

- TacSA: Select Other Repositories to Track
- TacSA: Mark Current Branch as PROD
- TacSA: Mark Current Branch as DEV
- TacSA: Mark Current Branch as NEUTRAL
- TacSA: Pick Branch Icons
- TacSA: Enable Status Bar Tint
- TacSA: Disable Status Bar Tint

---

## Scope & philosophy

- No Git hooks
- No write blocking
- No commit prevention
- No automation of merges
- No telemetry

This tool is **purely visual and advisory** — designed to reduce human error under cognitive load, not replace judgement.

⸻

## Status

Built for personal use, shared as-is
