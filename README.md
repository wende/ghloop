# ghloop

A CLI tool that watches a GitHub PR for CI status changes and new comments. Designed as a polling tool for AI agents that need to react to PR activity.

## Usage

```
ghloop [--pr <number>] [--interval <seconds>] [--state-dir <path>]
```

- `--pr` — PR number (default: auto-detect from current branch)
- `--interval` — Comment poll interval in seconds (default: 15)
- `--state-dir` — State persistence directory (default: `<git-dir>/ghloop/`)

## How it works

1. On first run: saves PR state (comments + CI checks), starts watching
2. On change: prints a human-readable diff with new comment content and ready-to-use `gh` reply commands, then exits 0
3. On relaunch: compares saved state to current — if different, prints changes and exits immediately; if identical, resumes watching

CI is monitored via `gh pr checks --watch` (event-driven, no polling). Comments are polled on the configured interval.

## Install

```
npm install -g .
```

Requires `gh` (GitHub CLI) authenticated and `git`.
