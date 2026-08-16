// dsh-hot-reload — live-reload upgraded dsh plugins without restarting dsh.
//
// It watches the profile's pnpm-lock.yaml; when an already-loaded plugin
// package's version changes, it invalidates that module's caches, re-imports
// the new code, and swaps the running plugin fiber in place — the same
// technique cordis-plugin-hmr uses, but reaching into node_modules (which HMR
// deliberately ignores).
//
// It is OPTIMISTIC: it attempts the reload and, if anything throws, rolls the
// plugin back to the old version and logs that a manual `dsh` restart is needed
// to pick up the new code. It does NOT detect silent leaks — a plugin that
// acquires a raw resource (a bare setInterval, socket, or fs.watch) without a
// ctx.effect disposer can reload without error yet leave that resource dangling.
// A plugin can opt out of reload entirely with `dsh.hotReload: false` in its
// package.json, which forces the restart-needed path without a reload attempt.
//
// NOTE: the reload path uses cordis/loader internals (loader.internal.loadCache,
// registry.plugin/delete, fiber.entry) — the same ones HMR uses. If a future
// cordis changes them, reloads will fail closed to "restart needed", never
// crash dsh.

import { watch } from "chokidar";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const name = "dsh-hot-reload";

const getOuterStack = () => [];
const cjsRequire = createRequire(import.meta.url);

export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console;
  const loader = ctx.loader;
  const internal = loader?.internal;
  const debounceMs = Number(config.debounce ?? 300);

  if (!loader || typeof loader.entries !== "function") {
    log.warn?.("dsh-hot-reload: no loader on context; plugin inactive");
    return;
  }
  if (!internal) {
    // Without loader.internal we cannot invalidate the module cache, so every
    // change degrades to a restart-needed notice rather than a reload attempt.
    log.warn?.(
      "dsh-hot-reload: loader.internal unavailable — upgrades will be reported as 'restart needed' (no live reload)"
    );
  }

  const profileDir = resolveProfileDir(ctx, config);
  if (!profileDir) {
    log.warn?.("dsh-hot-reload: could not locate profile dir (set config.profileDir); plugin inactive");
    return;
  }
  const lockfile = join(profileDir, "pnpm-lock.yaml");
  const nodeModules = join(profileDir, "node_modules");

  // ---- package <-> loader-entry helpers ----

  /** Package name backing a loader entry's module specifier, or null for local/builtin. */
  function pkgOf(specifier) {
    if (typeof specifier !== "string" || !specifier || specifier.startsWith(".") || specifier.startsWith("cordis:")) {
      return null;
    }
    if (specifier.startsWith("@")) {
      const [scope, pkg] = specifier.split("/");
      return scope && pkg ? `${scope}/${pkg}` : null;
    }
    return specifier.split("/")[0];
  }

  function readPkgJson(pkg) {
    try {
      return JSON.parse(readFileSync(join(nodeModules, pkg, "package.json"), "utf8"));
    } catch {
      return null;
    }
  }

  function versionOf(pkg) {
    return readPkgJson(pkg)?.version ?? null;
  }

  function optedOut(pkg) {
    return readPkgJson(pkg)?.dsh?.hotReload === false;
  }

  function entries() {
    try {
      return [...loader.entries()];
    } catch {
      return [];
    }
  }

  function entriesForPkg(pkg) {
    return entries().filter((e) => pkgOf(e?.options?.name) === pkg);
  }

  /** pkg -> installed version, across every package that backs a loaded entry. */
  function snapshotVersions() {
    const map = Object.create(null);
    for (const e of entries()) {
      const pkg = pkgOf(e?.options?.name);
      if (!pkg || pkg in map) continue;
      const v = versionOf(pkg);
      if (v) map[pkg] = v;
    }
    return map;
  }

  // ---- reload primitives (mirroring cordis-plugin-hmr) ----

  async function resolveUrl(specifier, parentURL) {
    const attrs = {};
    let res;
    switch (internal.version) {
      case "v1":
        res = await internal.resolve(specifier, parentURL, attrs);
        break;
      case "v2":
        res = internal.resolveSync(parentURL, { specifier, attributes: attrs });
        break;
      default:
        if (typeof internal.resolve === "function") res = await internal.resolve(specifier, parentURL, attrs);
        else if (typeof internal.resolveSync === "function") res = internal.resolveSync(parentURL, { specifier, attributes: attrs });
        else throw new Error("loader.internal exposes no resolver");
    }
    return typeof res === "string" ? res : res?.url;
  }

  function invalidate(url) {
    // ESM: Map.prototype.delete for full removal across Node 22/24 loadCache shapes.
    try {
      Map.prototype.delete.call(internal.loadCache, url);
    } catch {}
    // CJS: modules imported via import() also land in the require cache on Node 24.
    try {
      const fp = fileURLToPath(url);
      if (cjsRequire.cache[fp]) delete cjsRequire.cache[fp];
    } catch {}
  }

  /** Reload one loaded entry's module in place. Throws (after rollback) on failure. */
  async function reloadEntry(entry) {
    const specifier = entry?.options?.name;
    const parentURL = entry?.parent?.tree?.ctx?.baseUrl ?? ctx.baseUrl;
    const oldFiber = entry.fiber;
    const runtime = oldFiber?.runtime;
    const oldPlugin = runtime?.callback;
    if (!oldPlugin || !runtime) throw new Error(`no live fiber for ${specifier}`);

    const url = await resolveUrl(specifier, parentURL);
    if (!url) throw new Error(`could not resolve ${specifier}`);

    invalidate(url); // matters for in-place edits; harmless no-op for a version bump (new realpath)

    const newPlugin = loader.unwrapExports(await loader.import(url, getOuterStack));
    if (!newPlugin) throw new Error(`fresh import produced no plugin for ${specifier}`);

    // Snapshot fibers before disposal, then swap: dispose old (runs ctx disposers),
    // re-instantiate the new plugin against each old fiber's entry + config.
    const fibers = [...runtime.fibers];
    ctx.registry.delete(oldPlugin);
    try {
      const fresh = fibers.map((of) => reattach(newPlugin, of));
      // fiber.await() settles activation and RETHROWS a startup error — this is
      // how an async apply() throw is surfaced into this try/catch (a plain
      // reattach would let it escape asynchronously and leave the plugin dead).
      await Promise.all(fresh.map((f) => f?.await?.()));
    } catch (err) {
      // Rollback to the old plugin so a failed reload never leaves it dead.
      try {
        ctx.registry.delete(newPlugin);
      } catch {}
      const restored = [];
      for (const of of fibers) {
        try {
          restored.push(reattach(oldPlugin, of));
        } catch {}
      }
      try {
        await Promise.all(restored.map((f) => f?.await?.()));
      } catch {}
      throw err;
    }
  }

  function reattach(plugin, oldFiber) {
    const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber._config, getOuterStack);
    fiber.entry = oldFiber.entry;
    if (fiber.entry) fiber.entry.fiber = fiber;
    return fiber;
  }

  // ---- change handling ----

  async function handlePackage(pkg) {
    const affected = entriesForPkg(pkg);
    if (!affected.length) return; // not a loaded plugin (e.g. a fresh install) — out of scope
    const version = versionOf(pkg) ?? "?";

    if (optedOut(pkg)) {
      log.info?.(`dsh-hot-reload: ${pkg}@${version} sets dsh.hotReload:false — restart dsh to load the new version`);
      return;
    }
    if (!internal) {
      log.info?.(`dsh-hot-reload: ${pkg}@${version} changed — restart dsh to load the new version`);
      return;
    }

    try {
      for (const entry of affected) await reloadEntry(entry);
      log.info?.(`dsh-hot-reload: hot-reloaded ${pkg}@${version} (${affected.length} plugin row(s))`);
    } catch (err) {
      log.warn?.(`dsh-hot-reload: could not hot-reload ${pkg}@${version} — restart dsh to load the new version`);
      log.warn?.(err);
    }
  }

  // ---- watcher ----

  let versions = snapshotVersions();
  let timer = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const next = snapshotVersions();
      const changed = [];
      for (const pkg in next) {
        if (versions[pkg] !== next[pkg]) changed.push(pkg);
      }
      versions = next;
      for (const pkg of changed) await handlePackage(pkg);
    }, debounceMs);
  };

  const watcher = watch(lockfile, { ignoreInitial: true });
  watcher.on("change", trigger);
  watcher.on("add", trigger);
  watcher.on("error", (e) => log.warn?.("dsh-hot-reload: watcher error", e));

  ctx.effect(() => () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  });

  log.info?.(
    `dsh-hot-reload: watching ${lockfile} (${Object.keys(versions).length} plugin package(s) tracked)`
  );
}

/** Best-effort profile-dir resolution: explicit config, then the loader base URL. */
function resolveProfileDir(ctx, config) {
  if (config.profileDir) return config.profileDir;
  try {
    if (ctx.baseUrl) {
      const p = fileURLToPath(new URL(".", ctx.baseUrl));
      return p.replace(/\/$/, "");
    }
  } catch {}
  return null;
}
