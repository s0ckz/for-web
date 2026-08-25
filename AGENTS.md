# AGENTS.md — Stoat for Web (s0ckz fork)

Working agreement for this fork. Read this before making any change.

## Where to contribute

| Change | Repo | Branch to base on and PR into |
| --- | --- | --- |
| Web client (all UI) | `s0ckz/for-web` | `feat/self-hosted-tweaks` |
| Desktop shell (Electron/native) | `s0ckz/for-desktop` | `feat/windows-per-app-audio` |

**`main` is not our trunk in either repo.** It tracks the upstream project
(`stoatchat/*`). Basing work on `main` produces a branch that is missing all of our
fork's changes — and a PR that cannot be merged cleanly.

For this repo, the trunk is **`feat/self-hosted-tweaks`**.

## Rules

### 1. Nothing lands on the trunk without a PR

Never commit directly to `feat/self-hosted-tweaks`, and never merge into it locally and
push. Every change — including docs and one-line fixes — goes through a pull request
targeting that branch, so it can be reviewed before it reaches a deploy.

### 2. Always branch from an up-to-date trunk

Fetch first, every time. A branch cut from a stale local copy silently drifts and turns
into conflicts or a wrong-base PR later.

```bash
git fetch origin
git checkout -b <type>/<short-description> origin/feat/self-hosted-tweaks
```

Use `origin/feat/self-hosted-tweaks` as the start point directly — don't check out a
local trunk branch and hope it's current.

### 3. Keep long-running branches current

If a branch has been open for more than a day, bring it up to date before pushing again:

```bash
git fetch origin
git rebase origin/feat/self-hosted-tweaks
```

### 4. Before you start, verify your base

```bash
git fetch origin
git merge-base --is-ancestor origin/feat/self-hosted-tweaks HEAD \
  && echo "base OK" || echo "STALE — rebase before continuing"
```

## Which repo does a bug belong to?

This repo is the **entire user interface**. The desktop app does not bundle it — it opens
a `BrowserWindow` pointed at a hosted build of this client. So:

- **Anything the user sees or clicks → here.** Editing `for-desktop` cannot change it.
- **`for-desktop` owns only:** window chrome and lifecycle, tray, taskbar badges, Discord
  RPC, the screen-share source picker, per-app audio capture, the virtual mic, auto-launch
  and auto-update.

Desktop-only APIs reach this client through `window.native` and `window.desktopConfig`,
consumed in a small number of places:

- `components/app/interface/desktop/Titlebar.tsx` — custom frame controls
- `components/app/interface/settings/user/Native.tsx` — desktop settings pane
- `components/rtc/index.ts` and `components/rtc/state.tsx` — screen-share picker and
  Wayland virtual mic

Guard every one of them — the same code runs in a plain browser where `window.native` is
undefined.

## Layout

pnpm workspace with three packages:

- `packages/client` — the app (Solid.js, Panda CSS, Vite, Lingui)
- `packages/stoat.js` — submodule, the API/SDK client
- `packages/solid-livekit-components` — submodule, voice/video components

Inside `packages/client`, `components/` holds the real code (`rtc/` for voice, `state/`
for persisted settings, `ui/` for the design system); `src/` is mostly routing and page
shells. `styled-system/` is Panda codegen output — never hand-edit it.

## Conventions

- **Conventional commits are required.** release-please derives versions from them:
  `fix:` → patch, `feat:` → minor, `chore:`/`docs:` → no release.
- **`solid-js` is pinned to `1.9.14`** in `pnpm-workspace.yaml`. Per the comment there,
  versions between 1.9.6 and 1.9.14 break reactivity across dependencies. Do not bump it
  casually.
- Toolchain and tasks come from **mise**. `mise build:deps` must run before `mise dev`,
  since it builds `stoat.js`.
- `packages/client/.env` decides the backend. **If the API variables are unset the client
  silently falls back to the official hosted backend** — the usual cause of "why am I
  seeing the wrong server's data".
- The `packages/client/assets` submodule points at a private host and may be
  uninitialised; a build can fail until it is resolved.
