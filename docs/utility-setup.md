# Utility Pipeline Setup Guide

Target machine: **open-brain-vm** (192.168.10.53)

---

## 1. Cobb EMC Power — electric-usage-downloader

### Install the Go binary

The tool is a single static binary. Download from GitHub releases:

```bash
# SSH to open-brain-vm
ssh -i ~/.ssh/id_claude_code claude@192.168.10.53

# Create bin directory if needed
mkdir -p ~/bin

# Download latest release (check https://github.com/tedpearson/electric-usage-downloader/releases for current version)
cd ~/bin
curl -LO https://github.com/tedpearson/electric-usage-downloader/releases/latest/download/electric-usage-downloader-linux-amd64
mv electric-usage-downloader-linux-amd64 electric-usage-downloader
chmod +x electric-usage-downloader

# Verify
./electric-usage-downloader --help
```

If the release naming convention differs, check the releases page for the correct asset name. The VM is x86_64 Linux.

### Configure with SmartHub credentials

```bash
# Create config directory and data directory
mkdir -p ~/.electric-usage-downloader
mkdir -p ~/.electric-usage

# Copy the template config
# (from the repo checkout, or create manually)
cp ~/open-brain/config/utility/electric-usage-downloader-config.yaml \
   ~/.electric-usage-downloader/config.yaml

# Fill in credentials from Bitwarden
# Retrieve: bws secret list | grep cobb-emc
# Then edit config.yaml — replace FILL_FROM_BITWARDEN with actual values
nano ~/.electric-usage-downloader/config.yaml
```

### Test manually

```bash
# Pull yesterday's data
~/bin/electric-usage-downloader

# Verify CSV output
ls -la ~/.electric-usage/
# Should see a CSV file with 15-minute interval kWh readings
# Each row: timestamp, kWh value
head -20 ~/.electric-usage/*.csv
```

If the tool fails with auth errors, double-check the SmartHub URL (`cobbemc.smarthub.coop`) and credentials. Cobb EMC uses the NISC SmartHub platform which this tool supports.

### Set up daily cron

```bash
# Edit crontab
crontab -e

# Add this line — daily at 4 AM, pull previous day's 15-minute data
0 4 * * * ~/bin/electric-usage-downloader >> ~/logs/electric-usage.log 2>&1
```

Create the logs directory if it does not exist:

```bash
mkdir -p ~/logs
```

### Verify data is flowing

After the first cron run (or manual test):

```bash
# Check the log
tail -20 ~/logs/electric-usage.log

# Check CSV data directory
ls -lt ~/.electric-usage/
# Should see dated CSV files growing daily

# Spot-check a file — expect 96 rows (24 hours x 4 intervals/hour)
wc -l ~/.electric-usage/*.csv
```

### Where CSV data goes

- **Raw CSV files**: `~/.electric-usage/` on open-brain-vm
- **Format**: One CSV per day, 15-minute resolution (96 data points)
- **Columns**: Timestamp, kWh usage for that interval
- **Consumed by**: `scripts/utility-pipeline.py --power-summary` which reads the CSVs, aggregates monthly totals, and posts a capture to Open Brain

---

## 2. Rate limit bypass

Add `utility-pipeline` to the `BYPASS_CALLERS` Set in `packages/core-api/src/middleware/rate-limit.ts` so the pipeline script can post captures without hitting the 20 req/min strict tier. The pipeline sends `X-Open-Brain-Caller: utility-pipeline` header on all requests.

---

## 3. Bitwarden secrets reference

| Secret Key | Contents | Used By |
|-----------|----------|---------|
| `dev/open-brain/cobb-emc` | SmartHub username + password | electric-usage-downloader config |
| `dev/open-brain/gas-south` | Gas South portal username + password | utility-pipeline.py gas login |

Store as Bitwarden Secure Notes with structured fields (username, password).

---

## 4. Cron schedule summary

| Cron | Time | Script | Purpose |
|------|------|--------|---------|
| `0 4 * * *` | Daily 4 AM | `electric-usage-downloader` | Pull 15-min power data |
| `0 5 2 * *` | 2nd of month, 5 AM | `utility-pipeline.py --water --gas` | Pull water + gas readings |
| `0 8 2 * *` | 2nd of month, 8 AM | `utility-pipeline.py --monthly-comparison` | Synthesize + post capture |
