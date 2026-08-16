# dsh-hot-reload

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

This plugin is **optimistic**, not verified. It attempts the reload and only
falls back to "restart needed" on a **thrown** error. It does **not** detect
*silent* leaks:

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
- The reload path relies on cordis/loader internals
  (`loader.internal.loadCache`, `registry.plugin`/`delete`, `fiber.entry`) — the
  same ones `cordis-plugin-hmr` uses. If those internals are unavailable (no
  `--expose-internals` and no `node-addon-require-builtin` addon), the plugin
  degrades to reporting "restart needed" for every change instead of reloading.

Scope note: this handles **upgrades of already-loaded plugins**. Installing a
*brand-new* plugin is a separate concern (adding its row to `cordis.patch.yml`,
which dsh already hot-applies).

## License

[MIT](LICENSE) © Stuart Hu
