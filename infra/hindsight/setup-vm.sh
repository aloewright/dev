#!/usr/bin/env bash
# Run ON the VM (after `gcloud compute ssh hindsight --tunnel-through-iap`).
# Installs Docker + cloudflared, mounts the data disk. Then see README step 4-6.
set -euo pipefail

# --- mount data disk (first boot only) ---
DEV=/dev/disk/by-id/google-hindsight-data
if ! blkid "$DEV" >/dev/null 2>&1; then
  sudo mkfs.ext4 -F -E lazy_itable_init=0,lazy_journal_init=0,discard "$DEV"
fi
sudo mkdir -p /mnt/hindsight-data
grep -q hindsight-data /etc/fstab || \
  echo "UUID=$(sudo blkid -s UUID -o value "$DEV") /mnt/hindsight-data ext4 discard,defaults 0 2" | sudo tee -a /etc/fstab
sudo mount -a
sudo mkdir -p /mnt/hindsight-data/pg

# --- Docker Engine + compose plugin ---
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# --- cloudflared ---
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

sudo mkdir -p /opt/hindsight
echo "Installed. Next: copy compose + .env to /opt/hindsight, then run the cloudflared tunnel steps (README step 4)."
