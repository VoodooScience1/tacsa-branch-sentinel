# TacSA Branch Sentinel

A small VS Code extension that makes it **immediately obvious which Git branch you are on**, helping prevent accidental changes on production branches.

Built to solve a real, recurring problem when working across multiple repositories and environments.

---

## What it does

- Shows the **active repository and branch** in the status bar
- Uses **clear visual indicators**:
  - 🛡️ / red status bar for production branches (`main`, `master`)
  - 🛠️ / green status bar for development branches (`dev`)
  - Neutral styling for everything else
- Works across **multi-repo workspaces**
- Applies **workspace-scoped** settings only (no global pollution)

---

## Why it exists

When juggling multiple repos, environments, and deployment paths, it’s easy to:

- forget which repo is active
- forget which branch you’re on
- make a “small change” on a production branch by accident

This extension makes that state **unmissable**, without getting in your way.

---

## Default behaviour

Out of the box:

| Branch        | Mode    |
| ------------- | ------- |
| `main`        | PROD    |
| `master`      | PROD    |
| `dev`         | DEV     |
| anything else | Neutral |

No configuration required.

---

## Repo-specific overrides (optional)

You can override branch classification per repository (including wildcards):

```json
{
	"tacsaBranchSentinel.repoRules": {
		"my-repo-name": {
			"prod": ["main", "release/*"],
			"dev": ["dev", "feature/*"]
		}
	}
}
```

These rules are workspace-local and opt-in.

---

## Commands

Available via Cmd + Shift + P:

- TacSA: Mark Current Branch as PROD
- TacSA: Mark Current Branch as DEV
- TacSA: Mark Current Branch as NEUTRAL
- TacSA: Pick Branch Icons
- TacSA: Enable / Disable Status Bar Tint

## Scope & philosophy

- No Git hooks
- No write-blocking
- No automation of commits or merges
- No telemetry

This tool is purely visual and advisory — designed to reduce human error, not replace judgement.

---

## Status

Built for personal use, shared as-is.

If it helps you avoid one bad commit, it’s done its job (for now)
