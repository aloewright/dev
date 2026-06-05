#!/usr/bin/env bash
# Provision the GCE VM for Hindsight. Run from your laptop after `gcloud auth login`.
# Idempotent-ish: re-running create commands on existing resources will error (safe to skip).
set -euo pipefail

PROJECT="${PROJECT:?export PROJECT=your-gcp-project}"
ZONE="${ZONE:-us-central1-a}"
VM="${VM:-hindsight}"

gcloud config set project "$PROJECT"

# 20GB data disk for Postgres (separate from boot; snapshot/restore independently).
gcloud compute disks create hindsight-data \
  --zone="$ZONE" --size=20GB --type=pd-balanced

# e2-medium, Ubuntu 24.04, 30GB boot. No public ingress (tunnel is outbound).
gcloud compute instances create "$VM" \
  --zone="$ZONE" \
  --machine-type=e2-medium \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-balanced \
  --disk=name=hindsight-data,device-name=hindsight-data,mode=rw,boot=no \
  --scopes=storage-rw,logging-write,monitoring-write \
  --tags=hindsight \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring

# SSH only via Google IAP (no public port 22).
gcloud compute firewall-rules create allow-iap-ssh \
  --direction=INGRESS --action=ALLOW --rules=tcp:22 \
  --source-ranges=35.235.240.0/20 --target-tags=hindsight || true

echo "Done. Connect with:  gcloud compute ssh $VM --zone=$ZONE --tunnel-through-iap"
