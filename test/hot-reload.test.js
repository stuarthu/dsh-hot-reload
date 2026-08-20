// Tests for dsh-hot-reload's reload engine (lib/index.js), driven through
// `apply()` with a fake ctx/loader and a temp profile dir — no real dsh needed.
//
// The plugin only needs `ctx.loader.entries()`, `loader.internal`,
// `loader.import`, `loader.unwrapExports`, `ctx.registry.delete`,
// `ctx.effect`, `ctx.inject` and `ctx.baseUrl` (see CLAUDE.md). A temp profile
// dir plus those stubs exercises the whole watch -> snapshot -> reload cycle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { apply } from "../lib/index.js";

const CREW_SPECIFIER = "dsh-crew/host/crew.js";

function makeProfileDir() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-hot-reload-"));
  mkdirSync(join(dir, "node_modules", "dsh-crew", "host"), { recursive: true });
  writeCrewVersion(dir, "0.5.0");
  touchLockfile(dir);
  return dir;
}

function writeCrewVersion(profileDir, version) {
  writeFileSync(
    join(profileDir, "node_modules", "dsh-crew", "package.json"),
    JSON.stringify({ name: "dsh-crew", version })
  );
}

function touchLockfile(profileDir) {
  writeFileSync(join(profileDir, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\n# ${Date.now()}\n`);
}

/** A fake cordis environment: one "dsh-crew" plugin package, an old (running)
 *  plugin instance and a new (to-be-imported) one. */
function makeHarness(profileDir, { newApplyThrows = false } = {}) {
  const crewUrl = pathToFileURL(
    join(profileDir, "node_modules", "dsh-crew", "host", "crew.js")
  ).href;

  const pluginCtx = {};
  const calls = { old: 0, new: 0 };

  const oldPlugin = {
    name: "dsh-crew",
    async apply() {
      calls.old += 1;
    },
  };
  const newPlugin = {
    name: "dsh-crew",
    async apply() {
      calls.new += 1;
      if (newApplyThrows) throw new Error("new apply failed");
    },
  };

  const registry = {
    deleted: [],
    delete(plugin) {
      registry.deleted.push(plugin);
    },
    plugin(plugin, config) {
      return {
        entry: null,
        _config: config,
        parent: { registry },
        await: async () => {
          await plugin.apply(pluginCtx, config);
        },
      };
    },
  };

  const loadCache = new Map([[crewUrl, { stale: true }]]);

  const internal = {
    version: "v2",
    loadCache,
    resolveSync: () => crewUrl,
  };

  let entriesProvider = () => [];

  const loader = {
    internal,
    entries() {
      return entriesProvider();
    },
    async import() {
      return { name: "dsh-crew", apply: newPlugin.apply };
    },
    unwrapExports(mod) {
      return mod;
    },
  };

  /** A loader entry for dsh-crew whose fiber runs the OLD plugin. */
  function makeEntry() {
    const entry = makeFiberlessEntry();
    const oldFiber = {
      entry,
      _config: {},
      parent: { registry },
      runtime: { callback: oldPlugin, fibers: [] },
    };
    oldFiber.runtime.fibers = [oldFiber];
    entry.fiber = oldFiber;
    return entry;
  }

  /** A loader entry for dsh-crew whose fiber is not attached yet (mid-import). */
  function makeFiberlessEntry() {
    return {
      options: { name: CREW_SPECIFIER },
      disabled: false,
      parent: { tree: { ctx: { baseUrl: pathToFileURL(profileDir).href } }, registry },
      fiber: null,
    };
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    loader,
    registry,
    baseUrl: pathToFileURL(profileDir).href,
    effect() {
      return () => {};
    },
    inject() {},
  };

  return {
    ctx,
    registry,
    loadCache,
    calls,
    crewUrl,
    setEntries(fn) {
      entriesProvider = fn;
    },
    makeEntry,
    makeFiberlessEntry,
  };
}

/** Keep re-writing the lockfile until `predicate` is true, so the first write
 *  that lands while chokidar is still establishing its watch cannot be silently
 *  dropped. Returns whether the predicate ever became true. */
async function driveCycle(profileDir, predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    touchLockfile(profileDir);
    const attemptEnd = Date.now() + 600;
    while (Date.now() < attemptEnd) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  return predicate();
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

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

test("reloads a late-loaded plugin whose version changed after the boot snapshot", async (t) => {
  const profileDir = makeProfileDir();
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));

  const getStderr = captureStderr(t);
  const h = makeHarness(profileDir);

  // At apply() time dsh-crew is still later in the bundle order, so its entry
  // is NOT in loader.entries() yet: the boot snapshot does not track it.
  h.setEntries(() => []);

  apply(h.ctx, { profileDir, debounce: 50 });

  // Let chokidar establish its watch before the first write (~300ms).
  await settle(400);

  // dsh finishes booting and loads dsh-crew 0.5.0 — a live fiber now exists.
  h.setEntries(() => [h.makeEntry()]);

  // The upgrade: node_modules carries 0.6.0 and the lockfile is rewritten.
  writeCrewVersion(profileDir, "0.6.0");

  const reloaded = await driveCycle(profileDir, () => h.calls.new > 0);

  assert.ok(reloaded, "the new plugin code's apply() should have run");
  assert.ok(h.calls.new >= 1, `expected new apply() to run, saw ${h.calls.new}`);
  assert.ok(
    getStderr().includes("hot-reloaded dsh-crew@0.6.0"),
    `expected a 'hot-reloaded dsh-crew@0.6.0' stderr line, got: ${JSON.stringify(getStderr())}`
  );
});

test("writes a failed reload to stderr and rolls back to the old plugin", async (t) => {
  const profileDir = makeProfileDir();
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));

  const getStderr = captureStderr(t);
  const h = makeHarness(profileDir, { newApplyThrows: true });

  // This time the entry is present at boot, so the plugin is tracked at 0.5.0.
  h.setEntries(() => [h.makeEntry()]);

  apply(h.ctx, { profileDir, debounce: 50 });

  await settle(400);

  writeCrewVersion(profileDir, "0.6.0");

  const reported = await driveCycle(
    profileDir,
    () => getStderr().includes("could not hot-reload dsh-crew@0.6.0")
  );

  assert.ok(reported, "the failure reason should reach stderr durably");
  assert.ok(
    getStderr().includes("restart dsh"),
    `expected the failure to say a restart is needed, got: ${JSON.stringify(getStderr())}`
  );
  assert.ok(h.calls.old >= 1, "the old plugin should have been rolled back and re-applied");
});

test("adopts (does not reload) a first-seen package that has no live fiber", async (t) => {
  const profileDir = makeProfileDir();
  t.after(() => rmSync(profileDir, { recursive: true, force: true }));

  const getStderr = captureStderr(t);
  const h = makeHarness(profileDir);

  // Absent from the boot snapshot: dsh-crew loads after dsh-hot-reload.
  h.setEntries(() => []);

  apply(h.ctx, { profileDir, debounce: 50 });

  await settle(400); // chokidar establishes the watch

  // Phase 1: the entry first appears with no fiber attached (still importing).
  // There is nothing running to be stale, so the version must be adopted, not
  // reloaded — and adoption is silent.
  h.setEntries(() => [h.makeFiberlessEntry()]);
  writeCrewVersion(profileDir, "0.6.0");
  touchLockfile(profileDir);
  await settle(300); // debounce (50ms) + snapshot; the adopt path emits nothing

  // Phase 2: same version, now with a live fiber. If phase 1 had NOT adopted
  // 0.6.0 (e.g. the first cycle never ran), this would be a first-seen LIVE
  // package and would reload — so this also guards against a vacuous pass.
  h.setEntries(() => [h.makeEntry()]);
  touchLockfile(profileDir);
  await settle(300);

  assert.equal(h.calls.new, 0, "a fiberless first-seen package must be adopted, not reloaded");
  assert.ok(
    !getStderr().includes("hot-reloaded"),
    `expected no 'hot-reloaded' stderr line, got: ${JSON.stringify(getStderr())}`
  );
});
