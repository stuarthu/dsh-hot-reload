# Changelog

All notable changes to `dsh-hot-reload` are documented here. This project
follows [semantic versioning](https://semver.org/).

## 0.2.3

A plugin that loads after `dsh-hot-reload` in the bundle order is now reloaded
when it is upgraded, and every reload outcome — not just successes — reaches the
terminal. Config and API unchanged.

**Fixes**

- **A plugin loaded after this one now hot-reloads when upgraded.** A first-seen
  package used to be adopted at face value whatever its version, so a plugin that
  appears later in the bundle order (for example `dsh-crew`) kept running old
  code when it had already been upgraded before this plugin's first cycle — the
  change was silently missed. A first-seen package that has a live fiber is now
  reloaded instead of adopted; a first-seen package with no live fiber is still
  adopted, because there is nothing running to replace.
- **Every outcome now reaches the terminal.** `report()` used to write its stderr
  line only for a successful reload. A failed or stale reload was then visible
  only as a transient pop-up and a log line dsh never prints, so the "restart
  dsh" instruction never reached anyone watching the terminal. stderr is now
  written for every outcome — reloaded, failed, and stale.

## 0.2.2

Reloads now re-import a plugin's whole package, not just its entry module.
Config and API unchanged.

**Fixes**

- **Multi-file plugins reload as one unit.** The reload used to invalidate only
  the entry URL and re-import it. Under a hoisted linker (`nodeLinker: hoisted`)
  a version bump rewrites the package's files in place, so the entry's relative
  imports (`./routes.js` and friends) resolved to the same URLs and hit the
  stale cache — the running plugin mixed new entry code with old dependency code,
  which for a plugin like `dshmarket` surfaced as a crash looking for a file the
  new version had deleted. The reload now invalidates every cached module under
  the package's own directory (in both the ESM `loadCache` and the CJS
  `require.cache`) before re-importing, so the entry and its in-package imports
  come back together. Shared dependencies live outside that directory and are
  left alone.

## 0.2.1

Code-review fixes to the 0.2.0 notification surfaces. No config or API changes,
and detection and reloading are untouched.

**Fixes**

- **The pop-ups come back on their own after dsh restarts.** A browser tab whose
  message channel closed for good used to stay silent until you reloaded the
  page. This was easy to hit: the web server opens its socket before this plugin
  adds its route, so a tab retrying in that gap got the web app's HTML instead of
  a message channel, which the browser treats as a permanent failure. The tab now
  opens a new channel after 1s, 2s, 4s, 8s, 16s, then every 30s, up to ten tries
  (about three minutes). If all ten fail it says so in the console and stops, so
  a profile that simply has no host half does not knock at the door forever. Each
  successful connect gives the next outage a fresh set of tries.
- **A broken `ctx.inject` can no longer stop dsh from starting.** Setting up the
  message channel now runs last and inside a `try`. Before, it ran before the
  file watcher and was the one unguarded call on that path: if a future cordis
  changed `ctx.inject`, `apply()` would throw, dsh's start-up check would refuse
  to boot, and the watcher would never have been created — losing reloading over
  a feature that only reports on it.
- **A `HEAD` request no longer hangs.** `HEAD` was answered with a never-ending
  message stream, but Node throws away a `HEAD` body, so the caller waited until
  its own timeout while its connection sat in the plugin's list of subscribers
  collecting writes nobody would read. Health checks and link pre-fetchers do
  send `HEAD`. It now gets the headers and a clean close.
- **"No running copy to swap out" is announced once per version, not forever.**
  That case is deliberately left uncommitted so a plugin that was merely still
  starting gets picked up later — which meant every later lockfile write, even
  for a completely unrelated package, showed the same pop-up again with no way to
  dismiss it. The retry is unchanged; only the repeat announcing is dropped.

**Docs**

- The README told you to watch for the "no running copy" message *repeating* as
  your sign to restart dsh. It no longer repeats, so that advice was pointing at
  a signal that never comes. Both READMEs now say what to watch instead.
- **New limitation written down: the lockfile is only a trigger.** Version
  numbers come from each package's installed `package.json`. On pnpm 11 the
  files on disk are written before the lockfile, so what this plugin reads has
  settled — but nothing checks that. A future pnpm that wrote the lockfile first
  could make an upgrade be missed silently. This was a known gap; it was only
  ever recorded in the repo's internal notes, and one of those notes had the
  write order backwards.

## 0.2.0

You can now see reload results without reading the logs. Config did not change:
`debounce` and `profileDir` are still the only keys. Detection and reloading did
not change either.

**New messages**

- **One terminal line for each reload that worked.** dsh never prints its log to
  the terminal, so until now nothing this plugin wrote showed up there. A
  successful reload now also writes one line. This works in every profile.
- **A short pop-up message in the dsh web app.** You get one when a reload works,
  and one in every case that leaves the old code running: a reload that failed
  and was rolled back, a plugin with no running copy, `dsh.hotReload: false`, and
  missing loader internals. If one upgrade reloads several plugins, the messages
  show one after another.
- The web part ships as `lib/client.js` (`exports["./client"]`, plus `dsh.client`
  with `platform: "web"`) and attaches to the `shell.overlay` slot. It is written
  by hand in the format the browser loader expects, so this package still has
  **no build step** and **no new dependencies**. `react` and
  `@deepseek-ai/dsh-client-ui-primitives` come from the web app's own modules.
- Messages travel over a `GET /dsh-hot-reload/events` route added to
  `ctx.webServer`. Nothing is saved: if no browser is connected, the message is
  gone. The log is still the lasting record.
- One `report()` call now writes the log line, the terminal line, and the browser
  message from a single message string, so those surfaces cannot disagree.

**When parts are missing**

- The route is added through `ctx.inject(["webServer"], …)`. A top-level `inject`
  would have made the whole plugin wait forever in a profile with no web server,
  because cordis treats every injected name as required — `tui` would have
  stopped reloading anything. A single `ctx.get` call would have been unreliable:
  it only returns a service once that service is fully started, and the web
  server starts later, after it opens its socket. It would also never recover if
  the web server were replaced. `ctx.inject` only makes a small child part wait,
  and it registers the route again each time the web server is replaced.
- A missing web server, a repeated route, a renamed slot, a browser module that
  no longer loads, or a dsh build without `Toast` each cost you the pop-up only.
  Reloading still works and the web app still starts.
- If the message channel cannot be reached at all, the browser half says so once
  in the console instead of staying quiet. Otherwise a dead channel looks exactly
  like "no reloads have happened yet".

## 0.1.4

Two rounds of code-review fixes (engine + CI). No config or API changes.

**Correct detection**

- **One consistent view per cycle**: each cycle now enumerates loader entries
  once and reads each `package.json` once (the sole exception being a deliberate
  re-read at import time, which is what makes the committed version truthful),
  and every decision uses that view. A
  transient loader failure mid-cycle could previously make a detected upgrade
  look like "not a loaded plugin", committing it as loaded while the old code
  kept running — silently, forever.
- **De-duplicate reloads by runtime, not specifier string** — aliased specifiers
  (`pkg` vs `pkg/index.js`) resolving to one runtime no longer double-apply, and
  one specifier mounted under two loader trees (two runtimes) now reloads both.
- **Commit the version actually imported** — captured at import time inside the
  reload, never re-read afterwards. A version that lands while a slow `apply()`
  is still activating is therefore *not* recorded as loaded; it stays visible as
  a change and is picked up on the next cycle, so the running code converges on
  the newest version instead of silently stalling on an older one.
- **Track by loader membership, not filesystem probes**: a package is dropped
  when no loader entry is backed by it, not when a directory check fails. A
  dangling pnpm symlink mid-swap can no longer evict a live plugin, and a
  removed plugin row no longer stays tracked forever. A momentarily unreadable
  `package.json` leaves the package tracked at its old version.
- **Newly loaded rows are adopted, not reloaded** — dsh already loaded them.
  A package whose `package.json` was unreadable at boot is tracked as
  version-unknown rather than untracked, so its first readable version is
  loaded instead of being mistaken for a fresh row and adopted silently.
- **Disabled plugin rows are ignored**, using cordis's inherited `entry.disabled`
  getter (an ancestor entry can disable a row, and the raw option may be a
  `!!js` expression). Upgrading a disabled plugin no longer produces a spurious
  "restart dsh" warning for something that isn't running. Group rows are skipped
  too — they are containers, not plugin packages.
- Degraded snapshots (`loader.entries()` throwing) leave state untouched; the
  next event retries. If the loader is degraded at boot, the first successful
  snapshot is simply adopted as the tracked state.

**Honest reporting**

- **A failed reload is never retried automatically.** Each attempt tears down
  the working rolled-back plugin, and unrelated lockfile writes used to
  re-trigger it indefinitely. One clear message says what to do (install a
  different version, or restart dsh); later cycles stay quiet.
- **No more false successes**: a changed package with no live fiber to reload
  now warns and is *not* committed, instead of logging "hot-reloaded (0
  module(s))". A package with a mix of live and fiberless entries reloads the
  live ones and reports how many were skipped. An enabled row that simply has
  no fiber *yet* (still importing) stays retryable — only a reload that was
  attempted and failed is terminal.
- **Explicit `profileDir` config always wins** — it is no longer silently
  overridden by the auto-detected dir when its lockfile is missing.

**Shutdown**

- The disposer **never waits** on an in-flight reload, so dsh's shutdown can't
  hang on an arbitrary plugin's `apply()`. A reload caught mid-activation by
  teardown skips its rollback rather than re-registering fibers into a context
  that is already tearing down — and if that activation *succeeds* after
  teardown, the new plugin is dropped rather than left running (with its timers
  and sockets live) past shutdown.
- Lockfile churn during a long reload queues at most **one** follow-up cycle
  instead of one per debounce window.

**Docs**

- `cordis.patch.yml` no longer advertises a **`reloadable` config key that was
  never implemented** — a leftover from an abandoned opt-in design. The only
  config keys are `debounce` and `profileDir`.
- Corrected the "safe plugins are reloaded, unsafe ones are flagged" framing in
  the package description and bundle patch: nothing judges a plugin's safety.
  Every upgrade is attempted optimistically, a throw rolls back, and
  `dsh.hotReload: false` is the only opt-out.
- Both READMEs now document the disabled-row and not-yet-attached cases, and
  list **every** cordis/loader internal the reload path depends on (previously
  only three of six), which is what the Compatibility section is for.

**CI**

- Releases are now cut **only by pushing a `v*` tag**; pushes to `main` no
  longer publish. One tag = one run = one version, which removes the E403 race
  between the push- and tag-triggered runs of the same version.
- The run **fails loudly** if the tag disagrees with `package.json`'s version,
  if the version is a **prerelease** (this project publishes stable versions
  only — an unflagged prerelease would land on the `latest` dist-tag), or if
  `npm view` fails for a non-404 reason (previously a green run that silently
  skipped the release). E404 is detected structurally via `--json` rather than
  by grepping npm's error prose.
- Concurrency is keyed per tag, so distinct releases never share a queue slot
  (a shared group could silently cancel a pending release's run). Two releases
  cut within a couple of minutes can therefore publish concurrently, leaving
  the `latest` dist-tag on whichever finished last; releases are cut one at a
  time and the repair is a single `npm dist-tag add`, so this is accepted
  rather than automated.

## 0.1.3

Code-review fixes (engine + CI):

- Reload each changed package **once per module**, not once per plugin row —
  rows sharing a specifier share a runtime, so per-row reloading double-applied
  and leaked a module instance.
- **Serialize reload cycles** so a change arriving mid-reload can't run a second
  cycle concurrently against the registry.
- Commit the tracked version **only after a successful reload/skip**, so a failed
  reload can be retried by re-installing the same version.
- **Validate the profile dir** (warn if no `pnpm-lock.yaml`), and prefer a
  candidate dir that actually contains the lockfile.
- Disposer now awaits `watcher.close()` and guards against in-flight reloads via
  a `disposed` flag.
- CI: add a `concurrency` group so a commit+tag push can't race to publish
  (E403); publish only on a confirmed `E404` (not on transient `npm view`
  failures).

## 0.1.2

- Docs: add a **Compatibility** section (built/tested against dsh `0.1.0-rc.6`;
  relies on cordis/loader internals, fails safe if they're absent).
- Docs: note that the plugin works in **any profile**, not just `web`.
- CI: publish workflow now also triggers on `v*` **tags** (in addition to pushes
  to `main`), so releases can be cut either way.

## 0.1.1

- Add Chinese README (`README.zh.md`) and ship it in the published package.

## 0.1.0

- Initial release. Watches the profile's `pnpm-lock.yaml` and live-reloads an
  upgraded plugin's module in place (invalidate + re-import + fiber swap,
  mirroring `cordis-plugin-hmr` into `node_modules`).
- Optimistic with rollback: a failed reload (load error, or a sync/async `apply`
  throw) keeps the old version live and logs that a manual restart is needed.
- `dsh.hotReload: false` opt-out; degrades to "restart needed" when loader
  internals are unavailable.
