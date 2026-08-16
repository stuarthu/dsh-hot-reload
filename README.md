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

## How you see what happened

The plugin writes every result to dsh's log. But dsh does not print its log to
your terminal, so those lines are easy to miss. Two extra places show you what
happened.

**1. One line in your terminal, for each reload that worked.** You get this in
every profile:

```
dsh-hot-reload: hot-reloaded some-plugin@1.2.0 (1 module(s))
```

**2. A short pop-up message in the dsh web app.** You get one when a reload
works. You also get one in every case where the new code did *not* load, so the
old code is still running:

- the reload failed, and the old version was put back
- the plugin has no running copy to swap out
- the plugin turned off hot reload with `dsh.hotReload: false`
- dsh did not provide the internal parts the reload needs

The message slides in, stays a few seconds, then fades out. If one upgrade
reloads several plugins, the messages line up and show one after another.

The web part only loads in a profile that runs a web server. It sends the
messages over `GET /dsh-hot-reload/events`. A profile with no web server, such
as `tui`, still gets the terminal line and the log.

Messages are not saved. If no browser tab is open when a reload happens, that
message is gone. The log still has the record.

### If you want every line in your terminal

The terminal line above only covers reloads that worked. To see everything this
plugin writes to the log, including failures, add dsh's console logger to your
profile. It is a separate package:

```sh
dsh plugin --profile web add @deepseek-ai/cordis-plugin-logger-console
```

Then add a row for it in that profile's `cordis.patch.yml` and restart dsh:

```yaml
- insert:
    - id: logger-console
      name: '@deepseek-ai/cordis-plugin-logger-console'
```

This prints all dsh log lines, not only this plugin's.

> **Note for full-screen profiles.** The terminal line is written straight to the
> screen. In a profile that draws a full-screen interface, such as `tui`, the
> line can land in the middle of the drawing and make the screen look wrong. It
> looks wrong only until the screen is drawn again.

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

The pop-up message in the web app (and only that part) also uses:

| dsh part | Used for |
|---|---|
| `ctx.webServer.register` | serving the message channel |
| `window.__ModuleLoader__` | loading the browser half |
| the `shell.overlay` slot | placing the message over the app |
| `Toast` from `@deepseek-ai/dsh-client-ui-primitives` | drawing it |

The plugin fails safe. If a part it needs is missing, it reports "restart needed"
instead of breaking dsh. The pop-up behaves the same way. A missing web server,
a browser module it cannot load, an unknown slot, a repeated registration, or a
dsh build with no `Toast` each cost you the pop-up only. Reloading still works,
and the web app still starts.

One exception: the browser half asks dsh for a service named `slots`. dsh's web
app refuses to start if any plugin never becomes ready. So if some future dsh
build had no `slots` service at all, this part would wait forever and show up in
dsh's start-up error list. Every other failure listed above is caught and simply
does nothing.

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
- The message channel (`GET /dsh-hot-reload/events`) has **no password check**,
  the same as dsh's own `/plugins/events`. It sends plugin names and version
  numbers. dsh already shows those through its plugin list, so this adds no new
  secret. But if you bind dsh to `0.0.0.0`, count it as one more address that
  anyone on your network can open.

Scope note: this handles **upgrades of already-loaded plugins**. Installing a
*brand-new* plugin is a separate concern (adding its row to `cordis.patch.yml`,
which dsh already hot-applies).

## License

[MIT](LICENSE) © Stuart Hu
