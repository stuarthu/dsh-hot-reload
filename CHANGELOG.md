# Changelog

All notable changes to `dsh-hot-reload` are documented here. This project
follows [semantic versioning](https://semver.org/).

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
