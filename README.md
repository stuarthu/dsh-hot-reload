# dsh-hot-reload

English | [中文](README.zh.md)

Live-reload upgraded [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugins **without restarting dsh**.

dsh's built-in hot-reload (`cordis-plugin-hmr`) deliberately ignores
`node_modules`, so upgrading an installed plugin (`dsh plugin add pkg@x`)
normally requires a full `dsh` restart to take effect. This plugin closes that
gap: it watches your profile's `pnpm-lock.yaml`, and when an already-loaded
plugin package's version changes, it swaps the running plugin in place.

## Behavior

On a plugin package upgrade, for each affected plugin:

- **Reload it live** — invalidate the module caches, re-import the new code, and
  re-instantiate the plugin fiber in place. dsh, your sessions, and every other
  plugin keep running.
- **If the reload fails** — you're left with the **working old version**, never a
  dead plugin, plus a logged note that a **manual `dsh` restart** is needed to
  pick up the new code. Two cases, both handled:
  - a failure while *loading* the new code (bad import, syntax error) is caught
    *before* the running plugin is touched — the old plugin is never disturbed;
  - a failure while *initializing* it (the new `apply` throws, sync **or** async)
    is rolled back — the old version is re-instantiated in place.

  A version that failed is **not retried automatically** — retrying would tear
  down the working plugin again on every later lockfile write. Install a
  different version, or restart dsh, to pick the new code up.

Two cases produce no reload, by design:

- **Disabled plugin rows are skipped silently.** A disabled plugin isn't
  running, so there is nothing to swap — and re-enabling it makes dsh load the
  new code anyway.
- **A plugin that has no live fiber *yet*** (still importing, or it failed to
  load earlier) is reported as `no live fiber to reload right now` and left
  alone. Nothing was torn down, so this one *is* re-examined on the next
  lockfile change — if it keeps repeating, restart dsh.

It **never restarts dsh for you** — restarting is left to you (and your
supervisor, if any).

## Install

```sh
dsh plugin --profile web add dsh-hot-reload
```

Then restart dsh once (bundle patch layers load at boot). After that, upgrades
apply live:

```sh
dsh plugin --profile web add some-plugin@newer   # reloaded automatically
```

Works in **any profile** — swap `web` for whichever profile you use; it watches
the profile it's loaded into.

## Compatibility

Built and tested against **dsh `0.1.0-rc.6`** (Node 22 / 24). It reaches into
cordis/loader internals — mostly the same ones `cordis-plugin-hmr` uses — so a
future dsh that changes any of them may require an update:

| Internal | Used for |
|---|---|
| `loader.internal.loadCache` | invalidating the ESM module cache |
| `loader.internal.resolve` / `resolveSync` | resolving a specifier to a URL (dispatched on `internal.version`) |
| `registry.plugin` / `registry.delete` | swapping the plugin instance |
| `fiber.entry`, `fiber.runtime` | re-attaching the new plugin to the running rows |
| `entry.disabled` | skipping disabled rows (inherited getter) |
| `entry.options.group` | skipping group container rows |

It fails safe: if the internals it needs are missing, it degrades to reporting
"restart needed" rather than breaking dsh.

## Opting out

A plugin that knows it isn't safe to hot-reload can force the restart-needed
path (no reload attempt) by declaring, in its own `package.json`:

```json
{ "dsh": { "hotReload": false } }
```

## Configuration

Set on the `hot-reload` row in your profile's `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `debounce` | `300` | ms to wait after a lockfile change before acting |
| `profileDir` | auto | absolute path to the profile dir to watch (auto-detected from the loader base URL if omitted) |

## Limitations — read this

This plugin is **optimistic**, not verified. It attempts the reload and falls
back to "restart needed" only when something **throws** (or when there is no
live fiber to swap). It does **not** detect *silent* leaks:

- A plugin that acquires a **raw resource outside cordis** — a bare
  `setInterval`, a `net`/`http` server, a `WebSocketServer`, an `fs.watch`,
  a `child_process` — **without a `ctx.effect` disposer** can reload without
  throwing yet leave that resource dangling (a stray timer, a duplicate
  listener, an orphaned watcher). These accumulate across upgrades and are
  cleared only by an eventual restart.
- Cordis auto-unwinds everything a plugin registers **through `ctx`**
  (`ctx.effect`, `ctx.on`, `ctx.provide`, tool schemas, adapters), so
  well-behaved plugins reload cleanly. The risk is limited to plugins that
  bypass `ctx`. If in doubt, have such a plugin set `dsh.hotReload: false`.
- Reloading a plugin that holds **live connections** (e.g. a WebSocket bridge)
  drops and re-establishes them; clients must reconnect. That's expected, not an
  error.
- The reload path relies on the cordis/loader internals listed under
  [Compatibility](#compatibility). If they are unavailable (no
  `--expose-internals` and no `node-addon-require-builtin` addon), the plugin
  degrades to reporting "restart needed" for every change instead of reloading.

Scope note: this handles **upgrades of already-loaded plugins**. Installing a
*brand-new* plugin is a separate concern (adding its row to `cordis.patch.yml`,
which dsh already hot-applies).

## License

[MIT](LICENSE) © Stuart Hu
