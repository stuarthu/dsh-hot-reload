# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dsh-hot-reload` is a single-file DeepSeek Harness (dsh) plugin, published to npm, that live-reloads *upgraded* plugin packages without restarting dsh. dsh's built-in `cordis-plugin-hmr` deliberately ignores `node_modules`; this plugin closes that gap. All logic lives in `lib/index.js` (ESM, Node >= 22, only dependency is `chokidar`).

There are no tests, no linter, and no build step in the repo — the published `lib/` is the source. Verify against a real dsh profile (built/tested against dsh `0.1.0-rc.6`), or drive `apply()` with a fake ctx/loader: the plugin only needs `ctx.loader.entries()`, `loader.internal`, `loader.import`, `loader.unwrapExports`, `ctx.registry.delete`, and `ctx.effect`, so a temp profile dir plus stub objects exercises the whole cycle without dsh. Note chokidar needs ~300ms to establish the watch before the first lockfile write registers.

## How it works (lib/index.js)

- **Detection**: watches the profile's `pnpm-lock.yaml` with chokidar (debounced, default 300ms). On change, `runCycle` builds one `snapshot()` — a single `loader.entries()` enumeration plus one `package.json` read per package — and diffs its versions against the tracked map. The lockfile is only the *trigger*; versions come from `node_modules/<pkg>/package.json`, because pnpm writes the lockfile before materializing `node_modules` (trusting the lockfile would import old code while committing the new version as loaded).
- **Reload** (`reloadEntry`): resolves the module URL via `loader.internal`, invalidates both the ESM `loadCache` and the CJS `require.cache`, re-imports, then swaps every fiber of the module's runtime in place (`registry.delete` old plugin, `reattach` new plugin to each old fiber's entry + config). Mirrors the technique of `cordis-plugin-hmr`.
- **Rollback**: the reload is optimistic. `fiber.await()` surfaces sync *and async* `apply()` startup errors into the try/catch; on failure the old plugin is re-instantiated, so a failed reload never leaves a dead plugin — just a logged "restart dsh" notice.
- **Fail-safe degradation** is a design invariant: missing `loader.internal`, unresolvable profile dir, opt-out (`dsh.hotReload: false` in the target plugin's package.json) — all degrade to logging "restart needed", never to crashing dsh.

Invariants worth preserving when editing:

- Reload cycles are **serialized** (the `running` promise chain) — never let two cycles run concurrently against the registry.
- **`snapshot()` is the only place that classifies rows.** It answers every "what kind of row is this" question once per cycle: group rows and disabled rows are excluded, `live` holds one entry per **runtime** (rows/aliases sharing a runtime double-apply if reloaded separately, while one specifier under two loader trees is two runtimes and both must reload), and `fiberless` counts enabled-but-unattached rows. `handlePackage` filters nothing — keep it that way rather than re-introducing a second classification site.
- **One snapshot per cycle, consumed by everything.** Never re-enumerate entries or re-read a `package.json` outside `snapshot()` — a mid-cycle loader/fs hiccup would make a real upgrade look like "not a loaded plugin" and get committed as loaded, losing it silently. The single deliberate exception is the at-import version read below.
- The committed version is **captured at import time inside `reloadEntry`**, never re-read after the reload. Re-reading can record a version that was never imported (one that landed during a slow `apply()`), which makes the next cycle see no change and skip that upgrade forever. If a package's modules import *different* versions, commit nothing and return retryable `false` — the next cycle re-snapshots and converges, which is why no version-comparison helper is needed.
- **Terminal vs retryable failure** is a real distinction: `handlePackage` returns `TERMINAL` only when a reload was *attempted and failed* (recorded in `failedVersions`, never retried — each retry tears down the working rolled-back plugin), and plain `false` when it couldn't attempt at all (teardown, or no fiber attached yet), which stays retryable.
- **Never fake success, never cry wolf.** A changed package whose enabled rows have no live fiber warns and doesn't commit; a *disabled* row is skipped silently (it isn't running, and re-enabling loads fresh code). Use the inherited `entry.disabled` getter — never `options.disabled`, which can be a `!!js` expression object and misses ancestor-inherited disabling.
- An **explicit `config.profileDir` always wins** over auto-detection, even without a lockfile (warn, don't override).
- **Tracking follows loader membership, not the filesystem**: drop a package when no loader entry is backed by it. Directory probes are wrong twice over — a dangling pnpm symlink mid-swap would evict a live plugin, and a removed plugin row whose package stays installed would be tracked forever. A degraded `snapshot()` (loader throwing) returns null and the cycle does nothing; a boot-time degraded snapshot means the first successful snapshot is simply adopted (deliberate: a first-event upgrade in that rare window is absorbed silently).
- A package whose `package.json` can't be read is tracked with a **null version**, not omitted. Omitting it makes its first readable version look like a brand-new row that gets adopted without a reload — stale code, no warning. (Presence is tested with `in` and equality against a non-empty string, so `null` needs no sentinel value.)
- **Shutdown never waits on a reload.** The disposer sets `disposed`, closes the watcher, and returns. Because nothing waits, `reloadEntry` must check `disposed` on *both* paths after activation: the failure path skips the rollback, and the success path deletes the freshly activated plugin — otherwise its timers and sockets outlive shutdown with nothing left to dispose them.
- The reload path uses cordis/loader internals (`loader.internal.loadCache`, `resolve`/`resolveSync` per `internal.version`, `registry.plugin`/`delete`, `fiber.entry`) — the same ones HMR uses. Changes there in future cordis versions must fail closed to "restart needed".

`cordis.patch.yml` is the bundle patch dsh applies at boot to mount the plugin (referenced from `package.json`'s `dsh.bundle.patch`). Only two config keys exist — `debounce` and `profileDir` — and its commented example must stay in sync with them.

## Releasing

Publishing is fully automatic via npm Trusted Publishing (OIDC, no NPM_TOKEN). `.github/workflows/publish.yml` is triggered **only by pushing a `v*` tag** — pushes to `main` do not publish. The run fails loudly if the tag disagrees with `package.json`'s version, if the version is a prerelease (**stable releases only** — this project never publishes RCs), or if the registry check fails for any reason other than a confirmed E404; an already-published version is skipped. After publishing, a step re-points the `latest` dist-tag at the highest published version, since concurrent releases would otherwise leave `latest` on whichever finished last.

To cut a release: bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, push, then push the matching `v<version>` tag. Keep `README.md` and `README.zh.md` in sync — both ship in the package.
