#!/usr/bin/env node
/**
 * ============================================================
 *  Cycle HA Elections — Sample Application
 * ============================================================
 *
 * Demonstrates the application side of Cycle's high availability
 * elections. Run 3+ instances of this container and watch the
 * platform elect exactly one primary.
 *
 * Every instance of this container:
 *
 *   1. Checks in with the platform on an interval via the
 *      internal API (unix socket mounted in every instance).
 *   2. Learns which instance is the currently elected primary.
 *   3. Runs "exclusive work" ONLY while it holds the primary
 *      role — and stands down the moment it loses it.
 *   4. Self-fences: if check-ins stop succeeding for too long,
 *      it assumes the platform has promoted someone else and
 *      demotes itself locally. Never keep doing exclusive work
 *      when you can't prove you're still the primary.
 *
 * Requirements:
 *   - config.deploy.ha_elections must be set on the container:
 *       { "stale_primary_deadline": "45s" }
 *     (Without it, the check-in endpoint returns a 404.)
 *   - No internal API scope is needed for check-ins.
 *
 * Zero dependencies — Node.js standard library only.
 * ============================================================
 */

const http = require("http");
const os = require("os");

// ---- Configuration --------------------------------------------------------

const SOCKET_PATH = "/var/run/cycle/api/api.sock";
const API_TOKEN = process.env.CYCLE_API_TOKEN;

// How often we check in. Keep this comfortably below the
// stale_primary_deadline in the container config — with a 45s
// deadline and 15s check-ins, a primary can miss two check-ins
// before the platform elects a replacement.
const CHECKIN_INTERVAL_MS = 15_000;

// Must match config.deploy.ha_elections.stale_primary_deadline.
const STALE_DEADLINE_MS = 45_000;

// Self-fence before the platform's deadline expires, so we stop
// exclusive work BEFORE a new primary can possibly be elected.
const FENCE_AFTER_MS = Math.floor(STALE_DEADLINE_MS * 0.8);

// Higher priority = more likely to win elections.
const PRIORITY = Number(process.env.HA_PRIORITY || 10);

// How often the primary performs its exclusive work.
const WORK_INTERVAL_MS = 5_000;

// ---- State ----------------------------------------------------------------

const STATE = {
  instanceId: null,
  role: "unknown", // "unknown" | "follower" | "primary"
  primaryId: null,
  lastSuccessfulCheckin: 0,
  workTimer: null,
  batch: 0,
};

function log(message) {
  console.log(`[${new Date().toISOString()}] [${STATE.role}] ${message}`);
}

// ---- Internal API client --------------------------------------------------

/**
 * Minimal HTTP client for the internal API. All requests go over
 * the unix socket and authenticate with the X-CYCLE-TOKEN header,
 * using the CYCLE_API_TOKEN env var Cycle injects into every
 * instance.
 */
function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { "X-CYCLE-TOKEN": API_TOKEN };

    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = http.request(
      { socketPath: SOCKET_PATH, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`invalid JSON from internal API: ${err.message}`));
          }
        });
      }
    );

    req.on("error", reject);

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Figure out our own instance ID so we can compare it against
 * primary_instance_id. Prefer the injected env var; fall back to
 * listing the container's instances (self scope — always available)
 * and matching our hostname.
 */
async function resolveInstanceId() {
  if (process.env.CYCLE_INSTANCE_ID) {
    return process.env.CYCLE_INSTANCE_ID;
  }

  const response = await apiRequest("GET", "/v1/container/instances");
  const hostname = os.hostname();
  const instances = response.data || [];

  for (const instance of instances) {
    if (instance.hostname === hostname) {
      return instance.id;
    }
  }

  throw new Error(
    `could not resolve own instance ID (hostname ${hostname} not found among ${instances.length} instances)`
  );
}

// ---- Role transitions -----------------------------------------------------

/**
 * Called when a check-in tells us we've been elected. This is
 * where your app would acquire its exclusive role: start the
 * scheduler, open the writer connection, begin consuming the
 * queue, etc.
 */
function promote() {
  STATE.role = "primary";
  log("PROMOTED — this instance is now the primary");
  STATE.workTimer = setInterval(doExclusiveWork, WORK_INTERVAL_MS);
}

/**
 * Called when we learn (or must assume) we are no longer the
 * primary. Demotion must be immediate and unconditional — a
 * former primary that keeps working past its lease is how you
 * get two writers.
 */
function demote(reason) {
  const wasPrimary = STATE.role === "primary";
  STATE.role = "follower";

  if (STATE.workTimer) {
    clearInterval(STATE.workTimer);
    STATE.workTimer = null;
  }

  if (wasPrimary) {
    log(`DEMOTED — ${reason}`);
  }
}

/**
 * The "exclusive work" — the thing only one instance in the
 * container should ever be doing at a time.
 */
function doExclusiveWork() {
  STATE.batch += 1;
  log(`processing batch #${STATE.batch} (only the primary does this)`);
}

// ---- Election check-in loop -----------------------------------------------

async function checkin() {
  try {
    const response = await apiRequest("POST", "/v1/ha/election/checkin", {
      electable: true,
      priority: PRIORITY,
    });

    STATE.lastSuccessfulCheckin = Date.now();
    STATE.primaryId = response.data.primary_instance_id;

    const isPrimary = STATE.primaryId === STATE.instanceId;

    if (isPrimary && STATE.role !== "primary") {
      promote();
    } else if (!isPrimary && STATE.role === "primary") {
      demote(`instance ${STATE.primaryId} is now the primary`);
    } else if (!isPrimary) {
      STATE.role = "follower";
      if (STATE.primaryId === null) {
        log("checked in — no primary elected yet");
      } else {
        log(`checked in — following primary ${STATE.primaryId}`);
      }
    } else {
      log("checked in — still the primary");
    }
  } catch (err) {
    // Don't touch our role here — the fencing watchdog below
    // decides when missed check-ins mean we must step down.
    log(`check-in failed: ${err.message}`);
  }
}

/**
 * Fencing watchdog. The platform promotes a secondary once the
 * primary misses the stale_primary_deadline — so a primary that
 * can't reach the API must stop its exclusive work BEFORE that
 * deadline, or it may briefly overlap with the new primary.
 */
setInterval(() => {
  if (STATE.role !== "primary") {
    return;
  }

  const sinceLast = Date.now() - STATE.lastSuccessfulCheckin;

  if (sinceLast > FENCE_AFTER_MS) {
    demote(
      `no successful check-in for ${Math.round(sinceLast / 1000)}s — assuming a new primary has been elected`
    );
  }
}, 5_000);

// ---- Lifecycle ------------------------------------------------------------

process.on("SIGTERM", () => {
  demote("shutting down");
  log(
    "stopped checking in — the platform will promote a secondary after the stale_primary_deadline passes"
  );
  process.exit(0);
});

async function main() {
  if (!API_TOKEN) {
    console.error(
      "CYCLE_API_TOKEN is not set — this app must run inside a Cycle container instance."
    );
    process.exit(1);
  }

  STATE.instanceId = await resolveInstanceId();
  log(
    `starting — instance ${STATE.instanceId}, priority ${PRIORITY}, check-in every ${CHECKIN_INTERVAL_MS / 1000}s`
  );

  await checkin();
  setInterval(checkin, CHECKIN_INTERVAL_MS);
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
