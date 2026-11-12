# NEAR hosting (deployment instructions, not a deployment)

## Relay on Fly

Install and authenticate flyctl. From the repo root, choose an available app name and region;
replace the app and ALLOWED_ORIGINS placeholders in relay-near/fly.toml first.

```sh
cd relay-near
fly apps create styx-relay-near
fly volumes create relay_data --region bom --size 1 --app styx-relay-near
python3 -c 'import getpass; print("RELAY_TOKEN=" + getpass.getpass("Relay token: "))' | fly secrets import --app styx-relay-near
fly deploy --ha=false --app styx-relay-near
fly ssh console --app styx-relay-near --user root -C 'mkdir -p /data/relay'
fly ssh console --app styx-relay-near --user root -C 'chown node:node /data/relay'
fly ssh console --app styx-relay-near --user root -C 'chmod 700 /data/relay'
curl --fail https://styx-relay-near.fly.dev/health
```

The Python prompt sends the token to `fly secrets import` through stdin; keep it out of shell history and git.
The volume directory must be writable by the node user **before creating requests**. The app
runs non-root. The two-stage Docker build bundles the relay and dependencies; its runtime image
needs no npm installation. The build context is relay-near, with no dependency on another folder.

Env: RELAY_TOKEN (required secret), HOST=0.0.0.0, PORT=8788 (must match internal_port),
RELAY_STATE_FILE=/data/relay/requests.json, ALLOWED_ORIGINS (comma-separated exact origins,
no trailing slash). Empty ALLOWED_ORIGINS denies browser origins; originless CLI calls work.
CORS is not authentication. Request creation and signature fetching still require the bearer token.
Run one machine/process per volume; this file store does not support concurrent writers.
Do not enable HA replicas or autoscale. Back up the volume if retained approvals matter.

Local build/run:

```sh
cd relay-near
npm ci
npm run build
RELAY_TOKEN=local-only ALLOWED_ORIGINS=http://127.0.0.1:5173 npm start
```

Use `npm run dev` for TypeScript development. GET /health returns {"ok":true}; it checks HTTP
liveness, not disk durability, chain availability or payment settlement.

## Approval page on Vercel

From the repo root, using an authenticated Vercel CLI:

```sh
cd approval-page-near
npm ci
vercel link
vercel env add VITE_DEFAULT_RELAY production
vercel --prod
```

At the environment prompt enter `https://styx-relay-near.fly.dev`. For Git-based deployment,
select approval-page-near as the project root. vercel.json builds with npm run build and serves
dist. VITE_DEFAULT_RELAY is public build-time configuration, never a secret. Redeploy after it
changes. `?relay=https://...` overrides the default. The `request` query parameter is required.
Add the final Vercel origin to the relay's ALLOWED_ORIGINS and redeploy the relay config. Local
previews need their exact origins listed too. No RELAY_TOKEN belongs in the browser or VITE env.

## Validation

Local tests cover configured/denied CORS origins, preflight and health, alongside signature tests.
The bundled relay, TypeScript checks and static approval build are checked locally. No Fly or
Vercel deployment, remote volume permission setup, TLS check or production wallet round trip
was performed. Docker image execution was not tested: the local Docker daemon is unavailable.
