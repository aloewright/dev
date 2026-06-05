# Hindsight server setup (fly-dev agent memory)

Self-hosted Hindsight on a small GCE VM. Embeddings run **locally** (bundled BGE); chat
(retain/reflect) routes through the Cloudflare AI Gateway. Reachable only via a cloudflared
tunnel behind Cloudflare Access — no public ingress.

## What you need first
- A GCP project + `gcloud` CLI logged in (`gcloud auth login`).
- Cloudflare account with the `fly.pm` zone + AI Gateway (`CF_ACCOUNT_ID`, gateway id `x`, `CF_AIG_TOKEN`).
- Two secrets you generate: a Hindsight tenant API key and a Postgres password.

## Steps

**1. Provision the VM** (from your laptop)
```sh
export PROJECT=your-gcp-project ZONE=us-central1-a
bash infra/hindsight/provision-gcp.sh
gcloud compute ssh hindsight --zone=$ZONE --tunnel-through-iap
```

**2. Install Docker + cloudflared + mount disk** (on the VM)
```sh
# copy setup-vm.sh up, or paste its contents
bash setup-vm.sh
```

**3. Drop config on the VM**
- Copy `docker-compose.yml` → `/opt/hindsight/docker-compose.yml`
- Copy `.env.example` → `/opt/hindsight/.env`, fill in every value, `chmod 600 /opt/hindsight/.env`

**4. Create the tunnel + DNS** (on the VM)
```sh
cloudflared tunnel login
cloudflared tunnel create hindsight              # note the <UUID> it prints
cloudflared tunnel route dns hindsight hindsight.fly.pm
# copy cloudflared-config.yml -> /etc/cloudflared/config.yml, replace <UUID> (x2)
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

**5. Lock it down with Cloudflare Access** (Zero Trust dashboard)
- Access → Applications → Add → Self-hosted, domain `hindsight.fly.pm`.
- Service Auth → Service Tokens → Generate → save **Client ID** + **Client Secret**.
- Add a policy: Action = **Service Auth**, Include = that service token.

**6. Bring up the stack** (on the VM)
```sh
# copy hindsight.service -> /etc/systemd/system/, then:
sudo systemctl daemon-reload && sudo systemctl enable --now hindsight.service
docker compose -f /opt/hindsight/docker-compose.yml logs -f hindsight   # watch migrations apply
```

**7. Smoke test** (from your laptop — needs the Access token + tenant key)
```sh
export H=https://hindsight.fly.pm
auth=(-H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" \
      -H "Authorization: Bearer <HINDSIGHT_API_TENANT_API_KEY>" -H "Content-Type: application/json")
curl -sS "${auth[@]}" "$H/health"                                                   # 200
curl -sS "${auth[@]}" -X POST "$H/v1/default/banks/smoke/memories" \
  -d '{"items":[{"content":"PR #42 fixed the auth gate; tests passed."}],"async":false}'
curl -sS "${auth[@]}" -X POST "$H/v1/default/banks/smoke/memories/recall" \
  -d '{"query":"what happened with the auth gate?","trace":true}'                   # should return the memory
curl -sS "${auth[@]}" -X POST "$H/v1/default/banks/smoke/reflect" \
  -d '{"query":"summarize recent auth work","budget":"low"}'                        # non-empty text
```
If retain (chat) works but recall returns nothing, check `docker compose logs hindsight` for the
local embedding model loading. If health returns a Cloudflare login page, the Access service token
isn't being sent.

**8. Wire the Worker** (later, in the fly-dev repo)
```sh
wrangler secret put HINDSIGHT_API_KEY                 # = HINDSIGHT_API_TENANT_API_KEY
wrangler secret put HINDSIGHT_CF_ACCESS_CLIENT_ID
wrangler secret put HINDSIGHT_CF_ACCESS_CLIENT_SECRET
```
Then build Part B from the plan (`MemoryProvider`, retain/recall/reflect wiring) behind `MEMORY_ENABLED`.

## Backups
- Nightly `pg_dump -Fc` to GCS (cron) + daily disk snapshots of `hindsight-data`.
## Upgrades
- Pin `HINDSIGHT_VERSION`, `pg_dump` first, `docker compose pull hindsight && up -d hindsight`.
