# HA Election Demo

A minimal Node.js app demonstrating how an application consumes Cycle's **high availability elections** via the internal API. Deploy 3 instances; the platform elects exactly one primary, and this app shows the full lifecycle on the app side: promotion, demotion, follower behavior, and self-fencing.

## What it demonstrates

Every instance checks in to `POST /v1/ha/election/checkin` (over the internal API unix socket) every 15 seconds and reacts to the response:

| Situation | App behavior |
| --- | --- |
| Response says *I'm* the primary | `promote()` — starts the exclusive work loop (a fake "batch processor") |
| Response says someone else is primary | Runs as a follower, logs who the primary is |
| I was primary, response says I'm not | `demote()` — stops exclusive work immediately |
| Check-ins keep failing while I'm primary | **Self-fencing** — demotes itself locally *before* the platform's `stale_primary_deadline` can elect a replacement, so two primaries never overlap |
| SIGTERM | Stops work and exits; the platform promotes a secondary after the deadline |

The self-fencing watchdog is the part production apps most often get wrong: a primary that can't reach the election service must assume it has been replaced.

## Deploy it

1. **Build and push the image** (or point an image source at this directory):

   ```bash
   docker build -t <your-registry>/ha-election-demo .
   docker push <your-registry>/ha-election-demo
   ```

2. **Create the container** with elections enabled. The relevant config:

   ```json
   {
     "deploy": {
       "instances": 3,
       "ha_elections": {
         "stale_primary_deadline": "45s"
       }
     }
   }
   ```

   The 45s deadline pairs with the app's 15s check-in interval — a primary can miss two check-ins before losing the role. If you change one, change the other (`STALE_DEADLINE_MS` in `app.js`).

3. **Watch the logs** across instances. One instance will log:

   ```text
   [primary] PROMOTED — this instance is now the primary
   [primary] processing batch #1 (only the primary does this)
   ```

   while the others log:

   ```text
   [follower] checked in — following primary 651586fca6078e98982e819d
   ```

## The failover experiment

Stop the primary instance from the portal (or let it crash). Within the `stale_primary_deadline`:

1. The stopped primary's check-ins cease.
2. The platform elects a secondary.
3. That instance's next check-in returns its own ID as `primary_instance_id`, and it logs `PROMOTED` and starts processing batches where the old primary left off.

Restart the old instance and it rejoins as a follower — the elected primary keeps the role as long as it keeps checking in.

## Troubleshooting

- **404 on check-in** — `config.deploy.ha_elections` isn't set on the container (the endpoint is hidden until it's enabled), or the host's compute service predates the feature. Note the path is `/v1/ha/election/checkin`.
- **`CYCLE_API_TOKEN is not set`** — the app is running outside a Cycle instance. The internal API only exists inside containers on Cycle.
- **Instance ID resolution** — the app prefers the `CYCLE_INSTANCE_ID` env var and falls back to matching its hostname against `GET /v1/container/instances`. Run `env | grep CYCLE_` in a container console to see what your compute version injects.

## Files

- `app.js` — the sample application (no dependencies)
- `Dockerfile` — `node:22-alpine`, copies `app.js`, runs it
