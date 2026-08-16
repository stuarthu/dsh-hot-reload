// dsh-hot-reload — web half: raise a transient banner when the host half
// reloads (or fails to reload) a plugin package.
//
// This file is hand-written in the shape a built client bundle takes, because
// the package deliberately has no build step: a classic script that REGISTERS a
// factory with the browser module loader, whose body runs at materialization
// rather than at script execution. Consequences for editing it:
//
//   - no JSX (React.createElement instead) and no import/export syntax — the
//     factory takes a synchronous `require` and RETURNS its exports;
//   - only the platform seed modules may be required, under their exact keys:
//     react, react/jsx-runtime, react-dom, react-dom/client,
//     @deepseek-ai/cordis, and the @deepseek-ai/dsh-client-{ui-slots,
//     web-react, ui-primitives, ui-attachment, schema-form} set. They come from
//     the web shell's own build, so this half needs no other plugin bundle;
//   - `id` must be the package name: the loader resolves "<id>/client" and the
//     bare id to these same exports.
//
// The host half only serves this to browsers (package.json's dsh.client pins
// platform "web"), and nothing here is required for reloading to work. Every
// failure path below degrades to "no banner" — but note the shell fails its
// boot if a plugin entry never activates, so a throw at factory scope would
// cost the page: that is why the requires are guarded rather than bare.

window.__ModuleLoader__.load({
  id: "dsh-hot-reload",
  factory: (require) => {
    // Guarded because a throw here escapes the factory, leaves this entry
    // without a fiber, and the web shell's boot-time sweep turns any entry that
    // did not reach ACTIVE into a thrown boot failure — i.e. an unguarded
    // require miss costs the whole page, not just the banner. Degrade to a
    // no-op plugin instead, so the entry still activates.
    let React = null;
    let primitives = null;
    let seedError = null;
    try {
      React = require("react");
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      seedError = error;
    }

    /** Must match EVENTS_ENDPOINT in lib/index.js. The two halves ship as
     *  separate bundles with no module in common, so this constant is duplicated
     *  rather than shared — change one, change the other. */
    const EVENTS_ENDPOINT = "/dsh-hot-reload/events";

    /** Root-scoped list slot that the shell frame renders over the whole app,
     *  and dsh's documented home for a plugin's own floating surface. Root scope
     *  matters here: reloads are triggered from a terminal, so a notice must be
     *  able to appear with no conversation open. (The `root` slot itself is
     *  single-occupancy — registering there would shadow the entire app frame.) */
    const SLOT = "shell.overlay";

    /** Waits before each attempt to re-open a channel that closed for good, in
     *  ms. The list is the whole retry policy: its values are the schedule and
     *  its LENGTH is the budget — run off the end and the tab gives up, so a
     *  host half that is simply not there costs ten requests, not a request
     *  every few seconds forever. 16s of fast retries covers a dsh restart;
     *  the 30s tail covers a slow one. */
    const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000];

    /** Cordis plugin name. */
    const name = "dsh-hot-reload";
    /** Required services: the slot registry this half contributes its banner to. */
    const inject = ["slots"];

    /** Leading glyphs, built once: `primitives` is fixed for the life of the
     *  factory, so rebuilding these per render would only churn element identity
     *  and force the icon span to reconcile. Undefined when this dsh build no
     *  longer ships the icon — the banner reads fine without one. */
    const icon = (Icon) => (typeof Icon === "function" ? React.createElement(Icon) : undefined);
    const ICONS = seedError !== null ? {} : {
      reloaded: icon(primitives.IconRefreshOutline16),
      other: icon(primitives.IconWarningOutline16),
    };

    /**
     * The shell.overlay entry: subscribes to the host's notice channel and shows
     * one banner at a time, oldest first.
     *
     * Notices queue rather than replace: one lockfile write can reload several
     * packages, and showing only the newest would silently drop the rest.
     *
     * @param props.warn - reports a dead channel; supplied by apply() through the
     * wrapper it registers, so nothing about this component is factory-global and
     * a second plugin row cannot repoint the first row's logger.
     */
    function ReloadNotices({ warn }) {
      const [queue, setQueue] = React.useState([]);
      // Stable identity is load-bearing: Toast restarts its hold-and-fade timer
      // whenever `onDone` changes, so a fresh arrow per render would let a burst
      // of arrivals keep resetting the banner already on screen instead of
      // letting it finish and hand over to the next one.
      const shift = React.useCallback(() => setQueue((q) => q.slice(1)), []);

      React.useEffect(() => {
        let seq = 0;
        let source = null;
        let timer = null;
        let retries = 0;
        let stopped = false;

        const connect = () => {
          const es = new EventSource(EVENTS_ENDPOINT);
          source = es;
          // A successful connect gives the next outage a full retry budget
          // again, so the bound below is per outage rather than per tab. It
          // still bounds a host half that is simply absent: with nothing ever
          // answering there is no open event, so the budget never refills.
          es.addEventListener("open", () => {
            retries = 0;
          });
          es.addEventListener("message", (event) => {
            let frame;
            try {
              frame = JSON.parse(event.data);
            } catch {
              return;
            }
            if (frame === null || typeof frame !== "object") return;
            if (frame.type !== "notice" || typeof frame.text !== "string") return;
            seq += 1;
            setQueue((q) => q.concat({ seq, kind: frame.kind, text: frame.text }));
          });
          es.addEventListener("error", () => {
            // A transient drop leaves readyState CONNECTING and EventSource
            // retries it on its own — nothing to do. CLOSED is the fatal case
            // and the one that needs us: with no route registered the request
            // falls through to the SPA fallback and answers 200 text/html,
            // which EventSource treats as a permanent failure. That happens on
            // every dsh restart, because the web server binds its socket before
            // this plugin's route is registered — so without re-arming here, one
            // ill-timed retry would cost the banner for the life of the tab.
            if (stopped || es.readyState !== 2 /* CLOSED */) return;
            es.close();
            const delay = RETRY_DELAYS_MS[retries];
            if (delay === undefined) {
              warn(
                `dsh-hot-reload: notice channel ${EVENTS_ENDPOINT} still unavailable after ` +
                  `${RETRY_DELAYS_MS.length} retries — no reload banners until this page is reloaded`
              );
              return;
            }
            // Say it once per outage, so "the feature is off" stays
            // distinguishable from "broken", without a warning per retry.
            if (retries === 0) {
              warn(`dsh-hot-reload: notice channel ${EVENTS_ENDPOINT} is unavailable — retrying`);
            }
            retries += 1;
            timer = setTimeout(connect, delay);
          });
        };

        connect();
        // The host holds no per-tab state, so a reconnect costs nothing and
        // misses only the notices raised while it was down.
        return () => {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          if (source !== null) source.close();
        };
      }, []);

      const head = queue[0];
      if (head === undefined) return null;
      // Keyed by arrival sequence so two identical texts in a row remount and
      // replay the slide/hold/fade, instead of reusing an already-faded banner.
      return React.createElement(primitives.Toast, {
        key: head.seq,
        text: `dsh-hot-reload: ${head.text}`,
        icon: head.kind === "reloaded" ? ICONS.reloaded : ICONS.other,
        onDone: shift,
      });
    }

    /**
     * Client plugin body: mount the banner into the shell overlay.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      if (seedError !== null) {
        ctx.logger?.warn?.("dsh-hot-reload: a platform module is unavailable — reload notices disabled");
        ctx.logger?.warn?.(seedError);
        return;
      }
      if (typeof primitives.Toast !== "function") {
        ctx.logger?.warn?.("dsh-hot-reload: this dsh build ships no Toast primitive — reload notices disabled");
        return;
      }
      const warn = (message) => ctx.logger?.warn?.(message);
      // slots.inject waits for the slot to be declared and disposes with this
      // fiber, so an unknown slot name parks quietly instead of throwing.
      ctx.slots.inject(SLOT, () => {
        try {
          return ctx.slots.register({ name: SLOT, id: "dsh-hot-reload.notices", order: 100 }, () =>
            React.createElement(ReloadNotices, { warn })
          );
        } catch (error) {
          // A changed registration contract, or a duplicate id from a second
          // dsh-hot-reload row: lose the notices, never the page.
          ctx.logger?.warn?.("dsh-hot-reload: could not mount reload notices");
          ctx.logger?.warn?.(error);
          return () => {};
        }
      });
    }

    // The loader takes the factory's return value AS the module exports, so the
    // CJS `module.exports` preamble a built bundle carries is not needed here.
    return { apply, inject, name };
  },
});
