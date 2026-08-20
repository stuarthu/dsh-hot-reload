// Tests for dsh-hot-reload's self-reload: persisting committed versions to
// disk, handing the watcher off from the old instance to a new apply() that
// re-reads that state, and failing loud when the state file cannot be written.
//
// Driven with a fake ctx/loader + temp profile dir, mirroring hot-reload.test.js,
// except that the fake `ctx.effect` really captures disposers and
// `registry.delete` really runs them — self-reload is precisely the case where
// the OLD instance's disposer runs mid-swap, and the test must catch it either
// leaking the watcher or aborting the swap.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SELF = "dsh-hot-reload";
const SELF_SPECIFIER = "dsh-hot-reload";
const CREW = "dsh-crew";
const CREW_SPECIFIER = "dsh-crew/host/crew.js";
const STATE_FILE = ".dsh-hot-reload-state.json";

// A fresh, cache-busted import of the real lib/index.js — the "new" self plugin
// whose apply() a self-reload must invoke. The query string defeats the ESM
// cache so every call yields a distinct module instance (as an upgraded file on
// disk would), while chokidar/fs remain the shared real modules underneath.
let selfImportCounter = 0;
function importFreshSelf() {
  const url = new URL(`../lib/index.js?v=${++selfImportCounter}`, import.meta.url).href;
  return import(url);
}

function makeProfileDir() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-self-"));
  mkdirSync(join(dir, "node_modules", SELF, "lib"), { recursive: true });
  mkdirSync(join(dir, "node_modules", CREW, "host"), { recursive: true });
  writeSelfVersion(dir, "0.2.3");
  writeCrewVersion(dir, "0.5.0");
  touchLockfile(dir);
  return dir;
}

function writeSelfVersion(profileDir, version) {
  writeFileSync(join(profileDir, "node_modules", SELF, "package.json"), JSON.stringify({ name: SELF, version }));
}

function writeCrewVersion(profileDir, version) {
  writeFileSync(join(profileDir, "node_modules", CREW, "package.json"), JSON.stringify({ name: CREW, version }));
}

function touchLockfile(profileDir) {
  writeFileSync(join(profileDir, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\n# ${Date.now()}\n`);
}

/** Fake cordis environment: a live "dsh-hot-reload" entry (the self) plus a live
 *  "dsh-crew" entry. `ctx.effect` captures disposers and `registry.delete` runs
 *  them, so the old instance's teardown really fires during a self-reload swap. */
function makeHarness(profileDir) {
  const selfUrl = pathToFileURL(join(profileDir, "node_modules", SELF, "lib", "index.js")).href;
  const crewUrl = pathToFileURL(join(profileDir, "node_modules", CREW, "host", "crew.js")).href;

  const loadCache = new Map();
  const internal = {
    version: "v2",
    loadCache,
    resolveSync: (_parentURL, opts) => {
      const spec = opts?.specifier;
      if (spec === SELF_SPECIFIER) return selfUrl;
      if (spec === CREW_SPECIFIER) return crewUrl;
      return null;
    },
  };

  const ctxs = new Map(); // plugin function -> its ctx, so delete() can run its disposers
  const calls = { crew: 0 };
  const logLines = { info: [], warn: [] };
  let entriesProvider = () => [];
  let loader;
  let registry;

  function makeCtx() {
    const ctx = {
      disposers: [],
      logger: {
        info: (msg) => logLines.info.push(String(msg)),
        warn: (msg) => logLines.warn.push(String(msg)),
      },
      baseUrl: pathToFileURL(profileDir).href,
      loader,
      registry,
      effect(factory) {
        const disposer = factory();
        ctx.disposers.push(disposer);
        return disposer;
      },
      inject() {},
    };
    return ctx;
  }

  registry = {
    deleted: [],
    delete(plugin) {
      registry.deleted.push(plugin);
      const ctx = ctxs.get(plugin);
      if (ctx) {
        for (const d of [...ctx.disposers].reverse()) {
          try {
            d();
          } catch {}
        }
        ctx.disposers.length = 0;
      }
    },
    plugin(plugin, config) {
      const ctx = makeCtx();
      ctxs.set(plugin, ctx);
      const fiber = {
        entry: null,
        _config: config,
        parent: { registry },
        await: async () => {
          await plugin.apply(ctx, config);
        },
      };
      return fiber;
    },
  };

  loader = {
    internal,
    entries() {
      return entriesProvider();
    },
    async import(url) {
      if (url === selfUrl) {
        const mod = await importFreshSelf();
        return { name: SELF, apply: mod.apply };
      }
      return { name: CREW, apply: async () => { calls.crew += 1; } };
    },
    unwrapExports(mod) {
      return mod;
    },
  };

  /** A loader entry whose fiber runs `plugin`, instantiated with `config` (which
   *  is what reattach() hands the replacement plugin on a reload). */
  function makeEntry(specifier, plugin, config = {}) {
    const entry = {
      options: { name: specifier },
      disabled: false,
      parent: { tree: { ctx: { baseUrl: pathToFileURL(profileDir).href } }, registry },
      fiber: null,
    };
    const fiber = {
      entry,
      _config: config,
      parent: { registry },
      runtime: { callback: plugin, fibers: [] },
    };
    fiber.runtime.fibers = [fiber];
    entry.fiber = fiber;
    return entry;
  }

  return {
    selfUrl,
    crewUrl,
    loadCache,
    calls,
    logLines,
    makeCtx,
    registry,
    loader,
    setEntries(fn) {
      entriesProvider = fn;
    },
    makeEntry,
    link(plugin, ctx) {
      ctxs.set(plugin, ctx);
    },
    watchingCount() {
      return logLines.info.filter((l) => l.includes("watching")).length;
    },
  };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keep re-writing the lockfile until `predicate` is true, so a write that lands
 *  while chokidar is still establishing cannot be silently dropped. */
async function driveCycle(profileDir, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    touchLockfile(profileDir);
    const attemptEnd = Date.now() + 600;
    while (Date.now() < attemptEnd) {
      if (predicate()) return true;
      await settle(20);
    }
  }
  return predicate();
}

/** Fire several lockfile writes so at least a few cycles definitely run. */
async function pumpCycles(profileDir, ms = 1600) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    touchLockfile(profileDir);
    await settle(300);
  }
}

function captureStderr(t) {
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });
  return () => output;
}

test("self-reload: the new apply() runs and the watcher is handed off exactly once", async (t) => {
  const profileDir = makeProfileDir();
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));

  const getStderr = captureStderr(t);
  const { apply: oldApply } = await importFreshSelf();

  const h = makeHarness(profileDir);
  const oldCtx = h.makeCtx();
  h.link(oldApply, oldCtx);

  const oldCrewPlugin = { name: CREW, async apply() {} };
  h.setEntries(() => [
    h.makeEntry(SELF_SPECIFIER, oldApply, { profileDir, debounce: 50 }),
    h.makeEntry(CREW_SPECIFIER, oldCrewPlugin),
  ]);

  oldApply(oldCtx, { profileDir, debounce: 50 });

  // The fail-loud startup check persists the initial state before any change.
  const stateFile = join(profileDir, STATE_FILE);
  assert.ok(existsSync(stateFile), "apply() must persist the initial state at startup");

  await settle(400); // chokidar establishes its watch

  // Upgrade dsh-hot-reload itself.
  writeSelfVersion(profileDir, "0.2.4");

  const reloaded = await driveCycle(profileDir, () => getStderr().includes(`hot-reloaded ${SELF}@0.2.4`));
  assert.ok(reloaded, "self-reload must complete and report success");

  // The state persisted by the OLD instance must already carry the new self
  // version — this is what lets the new apply() avoid re-reloading itself.
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(state.versions[SELF], "0.2.4", "state file must commit self@0.2.4");
  assert.equal(state.versions[CREW], "0.5.0", "state file must keep crew@0.5.0");

  // One "watching" line from the old instance, exactly one more from the new:
  // the new apply() ran once, not in a loop.
  assert.equal(h.watchingCount(), 2, "the new instance must run exactly once");

  // Give the NEW instance's watcher time to establish before the next change.
  await settle(500);

  // Upgrade crew: exactly one watcher (the new one) may react. A leaked old
  // watcher would reload crew a second time; a self-reload that killed the
  // plugin would reload it zero times.
  writeCrewVersion(profileDir, "0.6.0");
  const crewReloaded = await driveCycle(profileDir, () => h.calls.crew > 0);
  assert.ok(crewReloaded, "the new instance must reload crew after self-reload");

  await settle(700);
  assert.equal(h.calls.crew, 1, "crew must be reloaded exactly once — a leaked old watcher would double it");
});

test("a fresh apply() reads persisted versions and does not re-reload an unchanged plugin", async (t) => {
  const profileDir = makeProfileDir();
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));

  const { apply } = await importFreshSelf();

  // The state a previous instance committed: dsh-crew@0.5.0 was already
  // reloaded. dsh-crew is ABSENT from this instance's boot snapshot (it loads
  // "late"), so without persistence it would look first-seen-with-a-live-fiber
  // and be spuriously reloaded.
  writeFileSync(
    join(profileDir, STATE_FILE),
    JSON.stringify({ versions: { [CREW]: "0.5.0" }, failedVersions: {}, noticedVersions: {} })
  );

  const h = makeHarness(profileDir);
  const ctx = h.makeCtx();
  h.link(apply, ctx);

  h.setEntries(() => [h.makeEntry(SELF_SPECIFIER, apply, { profileDir, debounce: 50 })]);
  apply(ctx, { profileDir, debounce: 50 });
  await settle(400);

  // crew's entry now appears with a live fiber, and the lockfile is touched.
  const oldCrewPlugin = { name: CREW, async apply() {} };
  h.setEntries(() => [
    h.makeEntry(SELF_SPECIFIER, apply, { profileDir, debounce: 50 }),
    h.makeEntry(CREW_SPECIFIER, oldCrewPlugin),
  ]);
  await pumpCycles(profileDir);

  assert.equal(h.calls.crew, 0, "a persisted, unchanged plugin must not be re-reloaded");
});

test("a degraded boot persists a null baseline, so the next instance adopts instead of re-reloading", async (t) => {
  const profileDir = makeProfileDir();
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));

  const stateFile = join(profileDir, STATE_FILE);

  // Instance 1: the loader cannot enumerate at boot (degraded), so there is no
  // baseline yet — versions is null and must round-trip as null, not {}.
  const h1 = makeHarness(profileDir);
  const { apply: apply1 } = await importFreshSelf();
  const ctx1 = h1.makeCtx();
  h1.link(apply1, ctx1);
  h1.setEntries(() => {
    throw new Error("degraded");
  });
  apply1(ctx1, { profileDir, debounce: 50 });

  assert.equal(
    JSON.parse(readFileSync(stateFile, "utf8")).versions,
    null,
    "a null baseline must persist as null, not {}"
  );

  // Instance 2 (fresh, same profile): also degraded at boot, then recovers with a
  // live dsh-crew entry. A null baseline must be ADOPTED on the first successful
  // snapshot; a {} baseline would treat crew as first-seen and reload it.
  const h2 = makeHarness(profileDir);
  const { apply: apply2 } = await importFreshSelf();
  const ctx2 = h2.makeCtx();
  h2.link(apply2, ctx2);
  h2.setEntries(() => {
    throw new Error("degraded");
  });
  apply2(ctx2, { profileDir, debounce: 50 });
  await settle(400);

  const oldCrewPlugin = { name: CREW, async apply() {} };
  h2.setEntries(() => [h2.makeEntry(CREW_SPECIFIER, oldCrewPlugin)]);
  await pumpCycles(profileDir);

  assert.equal(h2.calls.crew, 0, "a recovered degraded instance must adopt, not spurious-reload");
});

test("apply() fails loud when the state file cannot be written", (t) => {
  const profileDir = makeProfileDir();
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));

  // Occupy the state-file path with a directory: the atomic write's rename
  // (tmp -> final) then fails, which is what must stop apply().
  mkdirSync(join(profileDir, STATE_FILE));

  return importFreshSelf().then(({ apply }) => {
    const h = makeHarness(profileDir);
    const ctx = h.makeCtx();
    h.link(apply, ctx);
    h.setEntries(() => [h.makeEntry(SELF_SPECIFIER, apply)]);

    assert.throws(() => apply(ctx, { profileDir, debounce: 50 }), /cannot persist reload state/);
  });
});
