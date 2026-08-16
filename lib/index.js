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
// Disabled rows are skipped silently (nothing is running to swap); an enabled
// row with no fiber attached yet is reported and left for a later change.
//
// NOTE: the reload path uses cordis/loader internals (loader.internal.loadCache,
// registry.plugin/delete, fiber.entry) — the same ones HMR uses. If a future
// cordis changes them, reloads will fail closed to "restart needed", never
// crash dsh.

import { watch } from "chokidar";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const name = "dsh-hot-reload";

const getOuterStack = () => [];
const cjsRequire = createRequire(import.meta.url);

/** handlePackage outcome: a reload was attempted and failed — never retry it. */
const TERMINAL = Symbol("dsh-hot-reload:terminal");

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
  // Validate the auto-detected dir loudly: watching a wrong/nonexistent lockfile
  // would silently track 0 packages and never fire.
  if (!existsSync(lockfile)) {
    log.warn?.(
      `dsh-hot-reload: no pnpm-lock.yaml at ${lockfile} — is this the profile dir? ` +
        "set config.profileDir to fix; the plugin will watch but detect nothing until it appears."
    );
  }

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

  // Versions come from node_modules/<pkg>/package.json, never from the lockfile
  // we watch: pnpm writes the lockfile BEFORE materializing node_modules, so a
  // cycle triggered by that write can see the new version there while the old
  // code is still on disk — re-importing would load the OLD module while
  // committing the NEW version as loaded. The lockfile is the trigger; the
  // installed package.json is the truth about what an import would actually get.
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

  function entries() {
    try {
      return [...loader.entries()];
    } catch {
      return null; // degraded — callers must not confuse this with "no plugins loaded"
    }
  }

  /** One consistent per-cycle view: pkg -> { json, version, live, fiberless }
   *  for every package backing a loader entry, built from a SINGLE loader
   *  enumeration and a SINGLE package.json read per package (the whole cycle
   *  consumes this, so a loader/fs hiccup after the diff can't be misread as
   *  "not a loaded plugin"; `reloadEntry` deliberately re-reads the version at
   *  import time, and nothing else does).
   *
   *  Every question about what a row IS gets answered here, once:
   *   - group rows are containers, not plugin packages — excluded entirely;
   *   - disabled rows aren't running, so there is nothing to reload and nothing
   *     to report. `disabled` is an inherited getter (an ancestor entry can
   *     disable a row, and the raw option may be a !!js expression node), so
   *     never read options.disabled — excluded entirely;
   *   - `live` holds one entry per RUNTIME: reloadEntry swaps all of a runtime's
   *     fibers at once, so aliased specifiers ("pkg" vs "pkg/index.js") sharing
   *     a runtime must reload once, while one specifier under two loader trees
   *     is two runtimes and must reload twice;
   *   - `fiberless` counts enabled rows with nothing attached (mid-import, or
   *     failed to load) — reportable, but not reloadable.
   *
   *  Returns null when the loader can't enumerate right now — treating that as
   *  "everything uninstalled" would wipe the tracked versions and spuriously
   *  reload everything next cycle. A package whose package.json is momentarily
   *  unreadable (mid pnpm swap) still appears, with version null. */
  function snapshot() {
    const list = entries();
    if (!list) return null;
    const pkgs = Object.create(null);
    const seenRuntimes = new Map();
    for (const e of list) {
      if (e?.options?.group || e?.disabled) continue;
      const pkg = pkgOf(e?.options?.name);
      if (!pkg) continue;
      let rec = pkgs[pkg];
      if (!rec) {
        const json = readPkgJson(pkg);
        rec = pkgs[pkg] = { json, version: json?.version ?? null, live: [], fiberless: 0 };
        seenRuntimes.set(pkg, new Set());
      }
      const runtime = e?.fiber?.runtime;
      if (!runtime) {
        rec.fiberless += 1;
      } else if (!seenRuntimes.get(pkg).has(runtime)) {
        seenRuntimes.get(pkg).add(runtime);
        rec.live.push(e);
      }
    }
    return pkgs;
  }

  /** Baseline map for a snapshot. A package whose version couldn't be read is
   *  tracked with a null version rather than omitted: omitting it would make its
   *  first readable version look like a brand-new row and get adopted without a
   *  reload, silently leaving the old code running. */
  function currentVersions(snap) {
    const map = Object.create(null);
    for (const pkg in snap) map[pkg] = snap[pkg].version;
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

  /** Reload one loaded entry's module in place. Throws on failure, after rolling
   *  the old plugin back — except when teardown began mid-reload, where it drops
   *  the new plugin and does NOT roll back (the dying context disposes what is
   *  still registered). Returns the package version read at IMPORT time — a
   *  version read afterwards could record one that was never imported (a bump
   *  landing during a slow apply()), which would make the next cycle see no
   *  change and skip that upgrade forever. */
  async function reloadEntry(entry, pkg) {
    const specifier = entry?.options?.name;
    const parentURL = entry?.parent?.tree?.ctx?.baseUrl ?? ctx.baseUrl;
    const oldFiber = entry.fiber;
    const runtime = oldFiber?.runtime;
    const oldPlugin = runtime?.callback;
    if (!oldPlugin || !runtime) throw new Error(`no live fiber for ${specifier}`);

    const url = await resolveUrl(specifier, parentURL);
    if (!url) throw new Error(`could not resolve ${specifier}`);

    invalidate(url); // matters for in-place edits; harmless no-op for a version bump (new realpath)

    // Read the version as close to the import as possible: this is what the
    // fresh module actually is, and the only value safe to commit.
    const importedVersion = versionOf(pkg);
    const newPlugin = loader.unwrapExports(await loader.import(url, getOuterStack));
    if (!newPlugin) throw new Error(`fresh import produced no plugin for ${specifier}`);

    // Re-check after the (slow) import: never start the destructive swap into a
    // context that began tearing down while we were awaiting.
    if (disposed) throw new Error("dsh-hot-reload disposed mid-reload");

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
      // Activation can SUCCEED after teardown began — and the disposer no longer
      // waits for us, so nothing else would ever dispose these fibers. Throwing
      // here routes into the same drop-and-bail path the failure case uses.
      if (disposed) throw new Error("dsh-hot-reload disposed mid-reload");
    } catch (err) {
      try {
        ctx.registry.delete(newPlugin); // every path out of here drops the new plugin
      } catch {}
      // Teardown began while activation was awaiting: do NOT reattach into the
      // dying context — its own teardown disposes whatever is still registered.
      if (disposed) throw err;
      // Otherwise roll back, so a failed reload never leaves the plugin dead.
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
    return importedVersion;
  }

  function reattach(plugin, oldFiber) {
    const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber._config, getOuterStack);
    fiber.entry = oldFiber.entry;
    if (fiber.entry) fiber.entry.fiber = fiber;
    return fiber;
  }

  // ---- change handling ----

  /** Reload the live modules of a changed package, as already classified by the
   *  cycle's snapshot record. Returns the version string to commit, `false` to
   *  leave it uncommitted but RETRYABLE, or TERMINAL when a reload was attempted
   *  and failed — that version is never retried (each attempt tears down the
   *  working rolled-back plugin; recovery is a different version or a dsh
   *  restart). */
  async function handlePackage(pkg, rec) {
    const { version, live, fiberless } = rec;

    if (rec.json?.dsh?.hotReload === false) {
      log.info?.(`dsh-hot-reload: ${pkg}@${version} sets dsh.hotReload:false — restart dsh to load the new version`);
      return version;
    }
    if (!internal) {
      log.info?.(`dsh-hot-reload: ${pkg}@${version} changed — restart dsh to load the new version`);
      return version;
    }

    if (!live.length) {
      if (!fiberless) return version; // only disabled rows — nothing to do, nothing to say
      // Enabled but nothing attached: mid-import or a load failure. Say so once,
      // don't commit, and stay retryable — no reload was attempted, so a plugin
      // that was merely still activating picks this up on a later event.
      log.warn?.(
        `dsh-hot-reload: ${pkg}@${version} has no live fiber to reload right now — restart dsh if it stays on the old version`
      );
      return false;
    }
    if (fiberless) {
      log.warn?.(`dsh-hot-reload: ${pkg}@${version}: skipping ${fiberless} entry(ies) with no live fiber`);
    }

    try {
      // Only ever commit a version some module actually imported. If a bump
      // lands mid-cycle the modules can disagree about what they loaded; rather
      // than pick one, leave the package uncommitted (retryable) so the next
      // cycle re-snapshots and converges. Costs one redundant reload in a rare
      // case; the alternative risks recording a version that never loaded.
      let committed = null;
      for (const entry of live) {
        if (disposed) return false; // shutting down — don't touch the registry, don't commit
        const imported = await reloadEntry(entry, pkg);
        if (committed && imported !== committed) {
          log.info?.(`dsh-hot-reload: ${pkg} changed again mid-reload — re-checking on the next change`);
          return false;
        }
        committed ??= imported;
      }
      committed ??= version;
      log.info?.(`dsh-hot-reload: hot-reloaded ${pkg}@${committed} (${live.length} module(s))`);
      return committed;
    } catch (err) {
      if (disposed) return false; // aborted by teardown, not a real failure — stay quiet
      log.warn?.(
        `dsh-hot-reload: could not hot-reload ${pkg}@${version} — not retrying; restart dsh (or install a different version) to load it`
      );
      log.warn?.(err);
      return TERMINAL; // attempted and failed: never retried for this version
    }
  }

  // ---- watcher ----

  const boot = snapshot();
  // null when the loader couldn't enumerate at boot. By design there is no
  // retry and no warning: the first successful snapshot simply becomes the
  // tracked state. Accepted tradeoff — if the loader is degraded at boot AND
  // the very first lockfile event is a real upgrade, that upgrade is adopted
  // silently (old code keeps running, no notice). Deliberate, not an oversight.
  let versions = boot ? currentVersions(boot) : null;
  const failedVersions = Object.create(null); // pkg -> version whose reload failed (never retried)
  let timer = null;
  let pending = false; // at most ONE cycle queued behind the running one; bursts coalesce into it
  let disposed = false;
  let running = Promise.resolve(); // serializes reload cycles across debounce batches

  async function runCycle() {
    if (disposed) return;
    // ONE loader enumeration + ONE package.json read per package for the whole
    // cycle: the diff below and the reloads it drives act on the same facts, so
    // a transient loader/fs failure can never make a detected upgrade look like
    // "not a loaded plugin" and get silently committed. (The single exception is
    // the at-import version re-read in reloadEntry, which must not be cached.)
    const snap = snapshot();
    if (!snap) return; // degraded — keep current state, the next event retries
    if (!versions) {
      versions = currentVersions(snap); // adopt whatever is in the system (see `boot` above)
      return;
    }
    for (const pkg in snap) {
      if (disposed) return;
      const version = snap[pkg].version;
      if (!version) {
        // package.json unreadable right now (mid pnpm swap). Track it with a
        // null version if we've never had one, so the first readable version
        // reads as a change and reloads, instead of being adopted as a fresh row.
        if (!(pkg in versions)) versions[pkg] = null;
        continue;
      }
      if (!(pkg in versions)) {
        versions[pkg] = version; // newly loaded row: dsh just loaded it fresh, nothing to reload
        continue;
      }
      if (versions[pkg] === version) continue;
      // A version whose reload failed is never re-attempted: each attempt tears
      // down the working rolled-back plugin again. Recovery is a different
      // version or a dsh restart — the failure log said so once, stay quiet now.
      if (failedVersions[pkg] === version) continue;
      const commit = await handlePackage(pkg, snap[pkg]);
      if (commit === TERMINAL) {
        failedVersions[pkg] = version; // attempted, failed: don't try this version again
      } else if (commit) {
        versions[pkg] = commit; // the version actually imported, not the cycle-start one
        delete failedVersions[pkg];
      }
      // commit === false: not attempted (teardown, or nothing attached yet) —
      // leave it uncommitted and retryable on a later event.
    }
    // Drop a package when the LOADER no longer has an entry backed by it — not
    // when its directory is missing. A point-in-time fs probe is wrong twice
    // over: a dangling pnpm symlink mid-swap would evict a live plugin, and a
    // removed plugin row whose package stays installed would be tracked forever.
    for (const pkg of Object.keys(versions)) {
      if (!(pkg in snap)) {
        delete versions[pkg];
        delete failedVersions[pkg];
      }
    }
  }

  const trigger = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (pending) return; // a queued cycle will snapshot fresh state and see this change too
      pending = true;
      running = running
        .then(() => {
          pending = false;
          return runCycle();
        })
        .catch((e) => log.warn?.("dsh-hot-reload: reload cycle error", e));
    }, debounceMs);
  };

  const watcher = watch(lockfile, { ignoreInitial: true });
  watcher.on("change", trigger);
  watcher.on("add", trigger);
  watcher.on("error", (e) => log.warn?.("dsh-hot-reload: watcher error", e));

  ctx.effect(() => async () => {
    // Never wait on an in-flight reload: dsh's shutdown must not hang on an
    // arbitrary plugin's apply()/fiber.await(). Setting `disposed` first makes
    // any straggling cycle harmless — it stops between modules, and a reload
    // caught mid-activation skips the rollback rather than reattaching fibers
    // into a context that is already tearing down.
    disposed = true;
    if (timer) clearTimeout(timer);
    running.catch(() => {}); // keep an in-flight rejection from going unhandled
    try {
      await watcher.close();
    } catch {}
  });

  log.info?.(
    `dsh-hot-reload: watching ${lockfile} (${Object.keys(versions ?? {}).length} plugin package(s) tracked)`
  );
}

/** Profile-dir resolution: an explicit config.profileDir ALWAYS wins — it must
 *  never be silently overridden by auto-detection (a fresh profile without a
 *  lockfile yet would otherwise get the baseUrl dir, watching and hot-swapping
 *  the wrong profile; apply() warns loudly when the lockfile is missing).
 *  Auto-detection from the loader base URL applies only when config is absent. */
function resolveProfileDir(ctx, config) {
  if (config.profileDir) return config.profileDir;
  try {
    if (ctx.baseUrl) return fileURLToPath(new URL(".", ctx.baseUrl)).replace(/\/$/, "");
  } catch {}
  return null;
}
