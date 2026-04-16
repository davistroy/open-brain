#!/usr/bin/env python3
"""
Utility Pipeline for Open Brain.

Ingests water (Cobb County), gas (Gas South), and power usage data.
Stores in SQLite, calculates consumption deltas, and posts monthly
comparison captures to the Open Brain API. Runs via cron on open-brain-vm.

Usage:
    python utility-pipeline.py --water              # fetch water meter readings
    python utility-pipeline.py --gas                # fetch gas billing + parse PDFs
    python utility-pipeline.py --power-summary      # aggregate power CSV data (stub)
    python utility-pipeline.py --monthly-comparison  # unified utility synthesis
    python utility-pipeline.py --status             # pipeline stats

Cron (2nd of month, 5 AM):
    0 5 2 * * cd ~/open-brain && venv/bin/python scripts/utility-pipeline.py --water --gas >> ~/logs/utility-pipeline.log 2>&1
    0 8 2 * * cd ~/open-brain && venv/bin/python scripts/utility-pipeline.py --monthly-comparison >> ~/logs/utility-pipeline.log 2>&1
"""

import argparse, json, logging, os, re, sqlite3, subprocess, sys, tempfile, time
from collections import defaultdict
from datetime import datetime, date, timedelta, timezone
from pathlib import Path
from typing import Optional

import requests, yaml

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("utility-pipeline")

# --- Paths & constants ---
PIPE_DIR = Path.home() / ".utility-pipeline"
DB_PATH = PIPE_DIR / "utility.db"
CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "utility" / "utility-config.yaml"


# ── Config ───────────────────────────────────────────────────────────────────

def load_config() -> dict:
    """Load utility-config.yaml."""
    if not CONFIG_PATH.exists():
        sys.exit(f"Config not found: {CONFIG_PATH}")
    return yaml.safe_load(CONFIG_PATH.read_text())


# ── Secrets ──────────────────────────────────────────────────────────────────

_bws_secrets_cache: Optional[list] = None


def _load_bws_secrets() -> list:
    """Load all secrets from Bitwarden Secrets Manager (cached)."""
    global _bws_secrets_cache
    if _bws_secrets_cache is not None:
        return _bws_secrets_cache
    try:
        result = subprocess.run(
            ["bws", "secret", "list"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            log.error(f"bws failed: {result.stderr.strip()}")
            sys.exit(1)
        _bws_secrets_cache = json.loads(result.stdout)
        return _bws_secrets_cache
    except FileNotFoundError:
        log.error("bws CLI not found. Install it or check PATH.")
        sys.exit(1)
    except subprocess.TimeoutExpired:
        log.error("bws timed out — is BWS_ACCESS_TOKEN set?")
        sys.exit(1)


def get_bws_secret(secret_name: str) -> str:
    """Retrieve a secret value from Bitwarden Secrets Manager via bws CLI."""
    secrets = _load_bws_secrets()
    for s in secrets:
        if s.get("key") == secret_name:
            return s["value"]
    log.error(f"Secret '{secret_name}' not found in Bitwarden Secrets Manager")
    sys.exit(1)


# ── Database ─────────────────────────────────────────────────────────────────

def init_db() -> sqlite3.Connection:
    """Initialize SQLite with utility tables."""
    PIPE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS water_readings (
            date TEXT PRIMARY KEY,
            quantity_tgal REAL,
            meter_serial TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS gas_readings (
            date TEXT PRIMARY KEY,
            bill_amount REAL,
            ccfs REAL,
            therm_factor REAL,
            therms REAL,
            rate_per_therm REAL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS power_readings (
            date TEXT PRIMARY KEY,
            kwh REAL,
            cost_estimate REAL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_water_date ON water_readings(date);
        CREATE INDEX IF NOT EXISTS idx_gas_date ON gas_readings(date);
        CREATE INDEX IF NOT EXISTS idx_power_date ON power_readings(date);
    """)
    conn.commit()
    return conn


# ── Capture posting helper ───────────────────────────────────────────────────

def post_capture(cfg: dict, content: str, source_metadata: dict) -> bool:
    """POST a capture to the Open Brain API. Returns True on success."""
    cap_cfg = cfg.get("capture_api", {})
    url = cap_cfg.get("url", "https://brain.troy-davis.com/api/v1/captures")
    caller = cap_cfg.get("caller_header", "utility-pipeline")

    try:
        resp = requests.post(
            url,
            json={
                "content": content,
                "source": "api",
                "source_metadata": source_metadata,
            },
            headers={
                "Content-Type": "application/json",
                "X-Open-Brain-Caller": caller,
            },
            timeout=30,
        )
        if resp.status_code in (200, 201):
            log.info(f"Capture posted successfully")
            return True
        else:
            log.warning(f"Brain POST {resp.status_code}: {resp.text[:200]}")
            return False
    except requests.exceptions.RequestException as e:
        log.warning(f"Brain unreachable: {e}")
        return False


# ── Water (Cobb County) ─────────────────────────────────────────────────────

def cmd_water(cfg: dict, conn: sqlite3.Connection):
    """--water: Fetch water meter readings from Cobb County Water REST API.

    API requires no authentication (confirmed via HAR analysis).
    Stores readings in SQLite, calculates monthly consumption deltas.
    """
    log.info("=== Water Readings (Cobb County) ===")

    water_cfg = cfg.get("water", {})
    api_url = water_cfg.get("api_url", "https://ccw-csswebapi.cobbcounty.org/api")
    account_id = water_cfg.get("account_id", "<COBB_ACCOUNT_ID>")
    service_id = water_cfg.get("service_id", "<SERVICE_ID>")

    url = f"{api_url}/account/getMeterReadings?accountId={account_id}&serviceId={service_id}"
    log.info(f"Fetching readings: accountId={account_id}, serviceId={service_id}")

    try:
        resp = requests.get(url, timeout=30, headers={
            "Accept": "application/json",
            "User-Agent": "OpenBrain-UtilityPipeline/1.0",
        })
    except requests.exceptions.RequestException as e:
        log.error(f"Water API request failed: {e}")
        return

    if resp.status_code == 401:
        log.error("Water API returned 401 — authentication may now be required. "
                   "Implement session cookie from https://ccw-css.cobbcounty.org/ portal login.")
        return
    if resp.status_code != 200:
        log.error(f"Water API returned {resp.status_code}: {resp.text[:300]}")
        return

    try:
        readings = resp.json()
    except (json.JSONDecodeError, ValueError) as e:
        log.error(f"Water API response is not valid JSON: {e}")
        log.debug(f"Raw response: {resp.text[:500]}")
        return

    if not isinstance(readings, list):
        # Some APIs wrap in an object — try common keys
        if isinstance(readings, dict):
            for key in ("meterReadings", "readings", "data", "result"):
                if key in readings and isinstance(readings[key], list):
                    readings = readings[key]
                    break
            else:
                log.error(f"Unexpected response structure: {json.dumps(readings)[:300]}")
                return

    new_count = 0
    skip_count = 0

    for reading in readings:
        # Extract fields — adapt to actual API response shape
        read_date = reading.get("readDate") or reading.get("date") or reading.get("meterReadDate")
        quantity = reading.get("read") or reading.get("reading") or reading.get("consumption")
        meter_serial = reading.get("meterSerialNumber") or reading.get("meterSerial") or ""
        unit = reading.get("unitOfMeasureSymbol") or reading.get("uom") or "TGAL"

        if read_date is None or quantity is None:
            log.debug(f"Skipping reading with missing fields: {reading}")
            continue

        # Normalize date to ISO format (YYYY-MM-DD)
        if isinstance(read_date, str):
            # Handle /Date(...)/ .NET JSON format
            net_match = re.match(r"/Date\((\d+)\)/", read_date)
            if net_match:
                ts_ms = int(net_match.group(1))
                read_date = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            elif "T" in read_date:
                read_date = read_date[:10]  # strip time portion
            # else assume already YYYY-MM-DD or similar

        try:
            quantity = float(quantity)
        except (ValueError, TypeError):
            log.debug(f"Skipping reading with non-numeric quantity: {quantity}")
            continue

        # Convert units if needed (API reports TGAL = thousand gallons)
        # Store as-is in TGAL
        if unit and unit.upper() not in ("TGAL", "1000 GAL"):
            log.info(f"  Note: unit is '{unit}', storing raw value")

        # Skip if already stored
        existing = conn.execute(
            "SELECT 1 FROM water_readings WHERE date = ?", (read_date,)
        ).fetchone()
        if existing:
            skip_count += 1
            continue

        conn.execute(
            "INSERT INTO water_readings (date, quantity_tgal, meter_serial) VALUES (?, ?, ?)",
            (read_date, quantity, str(meter_serial)),
        )
        new_count += 1

    conn.commit()
    log.info(f"Water: {new_count} new readings stored, {skip_count} already existed")

    # Calculate and log recent consumption deltas
    recent = conn.execute(
        "SELECT date, quantity_tgal FROM water_readings ORDER BY date DESC LIMIT 6"
    ).fetchall()

    if len(recent) >= 2:
        log.info("Recent consumption (deltas):")
        for i in range(len(recent) - 1):
            curr_date, curr_qty = recent[i]
            prev_date, prev_qty = recent[i + 1]
            delta = curr_qty - prev_qty
            log.info(f"  {prev_date} -> {curr_date}: {delta:.1f} TGAL consumed")


# ── Gas South ────────────────────────────────────────────────────────────────

def _gas_south_login(cfg: dict) -> Optional[str]:
    """Login to Gas South portal and return authtoken UUID.

    Tries the known authentication endpoint. Returns None on failure.
    """
    gas_cfg = cfg.get("gas", {})
    login_url = gas_cfg.get("login_url", "https://manage.gassouth.com")
    bw_key = gas_cfg.get("bitwarden_key", "dev/open-brain/gas-south")

    # Retrieve credentials from Bitwarden
    creds_raw = get_bws_secret(bw_key)
    try:
        creds = json.loads(creds_raw)
        username = creds.get("username", "")
        password = creds.get("password", "")
    except json.JSONDecodeError:
        # If the secret is not JSON, try key=value format or single value
        log.error(f"Gas South credentials secret is not valid JSON. "
                  f"Expected: {{\"username\": \"...\", \"password\": \"...\"}}")
        return None

    if not username or not password:
        log.error("Gas South credentials missing username or password")
        return None

    # Try the authentication endpoint
    auth_url = f"{login_url}/api/authorize"
    auth_endpoints = [
        f"{login_url}/api/authorize",
        "https://manage-api.gassouth.com/oas/api/authorize",
        "https://manage-api.gassouth.com/oas/api/account/login",
    ]

    session = requests.Session()
    session.headers.update({
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Origin": "https://manage.gassouth.com",
        "Referer": "https://manage.gassouth.com/",
    })

    for endpoint in auth_endpoints:
        try:
            log.info(f"  Trying auth endpoint: {endpoint}")
            resp = session.post(
                endpoint,
                json={"username": username, "password": password},
                timeout=30,
            )

            if resp.status_code == 200:
                data = resp.json()
                # Token may be in various fields
                token = (
                    data.get("authtoken")
                    or data.get("authToken")
                    or data.get("token")
                    or data.get("access_token")
                )
                if token:
                    log.info(f"  Gas South login successful (token: {token[:8]}...)")
                    return str(token)
                # Check if the response itself is the token (UUID string)
                if isinstance(data, str) and len(data) == 36 and "-" in data:
                    log.info(f"  Gas South login successful (token: {data[:8]}...)")
                    return data
                log.debug(f"  200 response but no token found in: {json.dumps(data)[:200]}")
            elif resp.status_code == 401:
                log.debug(f"  {endpoint}: 401 Unauthorized")
            else:
                log.debug(f"  {endpoint}: {resp.status_code} — {resp.text[:200]}")
        except requests.exceptions.RequestException as e:
            log.debug(f"  {endpoint}: request failed — {e}")

    log.error("Gas South login failed — all auth endpoints returned errors. "
              "Check credentials in Bitwarden or update login URL.")
    return None


def _parse_gas_bill_pdf(pdf_content: bytes) -> dict:
    """Extract CCFs, therm factor, and therms from a Gas South bill PDF.

    Returns dict with keys: ccfs, therm_factor, therms, rate_per_therm.
    Missing values are None.
    """
    result = {"ccfs": None, "therm_factor": None, "therms": None, "rate_per_therm": None}

    try:
        import fitz  # PyMuPDF
    except ImportError:
        log.warning("PyMuPDF (fitz) not installed — cannot parse gas bill PDFs. "
                    "Install with: pip install PyMuPDF")
        return result

    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_content)
            tmp_path = tmp.name

        doc = fitz.open(tmp_path)
        full_text = ""
        for page in doc:
            full_text += page.get_text() + "\n"
        doc.close()
        os.unlink(tmp_path)
    except Exception as e:
        log.warning(f"PDF parse error: {e}")
        if "tmp_path" in locals():
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        return result

    # Extract CCFs: look for patterns like "66 CCFs" or "66 CCF"
    ccf_match = re.search(r"(\d+)\s*CCFs?\b", full_text, re.IGNORECASE)
    if ccf_match:
        result["ccfs"] = float(ccf_match.group(1))

    # Extract therm factor: "1.034" near "therm factor" or "conversion"
    factor_match = re.search(
        r"(?:therm\s*factor|conversion\s*factor)[:\s]*(\d+\.?\d*)",
        full_text, re.IGNORECASE,
    )
    if factor_match:
        result["therm_factor"] = float(factor_match.group(1))

    # Extract therms: "68.24 therms" or total therms line
    therms_match = re.search(r"(\d+\.?\d*)\s*therms?\b", full_text, re.IGNORECASE)
    if therms_match:
        result["therms"] = float(therms_match.group(1))

    # Extract rate per therm: "$0.65/therm" or "0.65 per therm"
    rate_match = re.search(
        r"\$?(\d+\.?\d*)\s*(?:/\s*therm|per\s*therm)",
        full_text, re.IGNORECASE,
    )
    if rate_match:
        result["rate_per_therm"] = float(rate_match.group(1))

    # If we have CCFs and factor but no therms, calculate
    if result["ccfs"] and result["therm_factor"] and not result["therms"]:
        result["therms"] = round(result["ccfs"] * result["therm_factor"], 2)

    log.info(f"  PDF parsed: CCFs={result['ccfs']}, factor={result['therm_factor']}, "
             f"therms={result['therms']}, rate={result['rate_per_therm']}")
    return result


def cmd_gas(cfg: dict, conn: sqlite3.Connection):
    """--gas: Fetch Gas South billing history and parse bill PDFs for therms.

    Login to portal, fetch billing activity, download bill PDFs to extract
    CCFs and therm data. Store in SQLite.
    """
    log.info("=== Gas Readings (Gas South) ===")

    gas_cfg = cfg.get("gas", {})
    api_url = gas_cfg.get("api_url", "https://manage-api.gassouth.com/oas/api")
    account_number = gas_cfg.get("account_number", "<GAS_ACCOUNT_NUMBER>")
    lookback = gas_cfg.get("lookback_months", 3)

    # Step 1: Login
    token = _gas_south_login(cfg)
    if not token:
        return

    # Step 2: Fetch billing history
    activity_url = (
        f"{api_url}/account/get-account-activity"
        f"?accountNumber={account_number}&lookBackMonths={lookback}"
    )
    log.info(f"Fetching billing history: account={account_number}, lookback={lookback}mo")

    try:
        resp = requests.get(
            activity_url,
            headers={
                "authtoken": token,
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Origin": "https://manage.gassouth.com",
                "Referer": "https://manage.gassouth.com/",
            },
            timeout=30,
        )
    except requests.exceptions.RequestException as e:
        log.error(f"Gas South billing API failed: {e}")
        return

    if resp.status_code == 401:
        log.error("Gas South billing API returned 401 — token may be expired or invalid")
        return
    if resp.status_code != 200:
        log.error(f"Gas South billing API returned {resp.status_code}: {resp.text[:300]}")
        return

    try:
        activities = resp.json()
    except (json.JSONDecodeError, ValueError) as e:
        log.error(f"Gas South response is not valid JSON: {e}")
        return

    if not isinstance(activities, list):
        if isinstance(activities, dict):
            for key in ("activities", "data", "result", "accountActivity"):
                if key in activities and isinstance(activities[key], list):
                    activities = activities[key]
                    break
            else:
                log.error(f"Unexpected response structure: {json.dumps(activities)[:300]}")
                return

    new_count = 0
    skip_count = 0

    for activity in activities:
        activity_type = activity.get("ActivityType") or activity.get("activityType") or ""
        activity_date = activity.get("ActivityDate") or activity.get("activityDate") or ""
        activity_amount = activity.get("ActivityAmount") or activity.get("activityAmount") or 0
        bill_url = activity.get("Url") or activity.get("url") or ""
        bill_segment = activity.get("BillSegmentInfo") or activity.get("billSegmentInfo")

        # Only process bill records (skip payments, adjustments)
        if "bill" not in activity_type.lower() and "statement" not in activity_type.lower():
            log.debug(f"  Skipping non-bill activity: {activity_type} on {activity_date}")
            continue

        # Normalize date
        if isinstance(activity_date, str):
            net_match = re.match(r"/Date\((\d+)\)/", activity_date)
            if net_match:
                ts_ms = int(net_match.group(1))
                activity_date = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            elif "T" in activity_date:
                activity_date = activity_date[:10]

        try:
            bill_amount = float(activity_amount)
        except (ValueError, TypeError):
            bill_amount = 0.0

        # Skip if already stored
        existing = conn.execute(
            "SELECT 1 FROM gas_readings WHERE date = ?", (activity_date,)
        ).fetchone()
        if existing:
            skip_count += 1
            continue

        # Step 3: Try to download and parse bill PDF for therms
        pdf_data = {"ccfs": None, "therm_factor": None, "therms": None, "rate_per_therm": None}

        if bill_url:
            log.info(f"  Downloading bill PDF for {activity_date}...")
            try:
                pdf_resp = requests.get(
                    bill_url,
                    headers={"authtoken": token},
                    timeout=60,
                )
                if pdf_resp.status_code == 200 and len(pdf_resp.content) > 100:
                    pdf_data = _parse_gas_bill_pdf(pdf_resp.content)
                else:
                    log.warning(f"  Bill PDF download failed: {pdf_resp.status_code} "
                                f"({len(pdf_resp.content)} bytes)")
            except requests.exceptions.RequestException as e:
                log.warning(f"  Bill PDF download error: {e}")

        # Store reading
        conn.execute(
            "INSERT INTO gas_readings (date, bill_amount, ccfs, therm_factor, therms, rate_per_therm) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (activity_date, bill_amount, pdf_data["ccfs"], pdf_data["therm_factor"],
             pdf_data["therms"], pdf_data["rate_per_therm"]),
        )
        new_count += 1
        therms_val = pdf_data["therms"]
        therms_str = f", {therms_val:.1f} therms" if therms_val else ", therms N/A"
        log.info(f"  {activity_date}: ${bill_amount:.2f}{therms_str}")

    conn.commit()
    log.info(f"Gas: {new_count} new readings stored, {skip_count} already existed")


# ── Power (Cobb EMC — stub) ─────────────────────────────────────────────────

def cmd_power_summary(cfg: dict, conn: sqlite3.Connection):
    """--power-summary: Aggregate power data from electric-usage-downloader output.

    Reads CSV data from the Go tool's output directory. Aggregates daily/monthly
    kWh totals. Full implementation pending the Go tool being configured and running.
    """
    log.info("=== Power Summary (Cobb EMC) ===")

    power_cfg = cfg.get("power", {})
    data_dir = Path(os.path.expanduser(power_cfg.get("data_dir", "~/.electric-usage")))
    rate_kwh = power_cfg.get("rate_kwh", 0.12)

    if not data_dir.exists():
        log.info("Power data directory not found — electric-usage-downloader not configured yet.")
        log.info(f"  Expected: {data_dir}")
        log.info("  Install: download electric-usage-downloader from GitHub releases")
        log.info("  Configure: create config.yaml with SmartHub credentials")
        return

    # Look for CSV files
    csv_files = sorted(data_dir.glob("*.csv"))
    if not csv_files:
        log.info(f"No CSV files in {data_dir} — power data not available yet")
        return

    log.info(f"Found {len(csv_files)} CSV files in {data_dir}")
    log.info("Power CSV parsing will be implemented when the Go tool is running.")
    # TODO: Parse CSV files, aggregate daily/monthly kWh, store in power_readings table


# ── Monthly Comparison ───────────────────────────────────────────────────────

def cmd_monthly_comparison(cfg: dict, conn: sqlite3.Connection):
    """--monthly-comparison: Unified utility comparison with T2 synthesis.

    Aggregates latest month data from water, gas, and power. Compares MoM.
    Uses claude --print for synthesis. Posts capture to Open Brain.
    """
    log.info("=== Monthly Utility Comparison ===")

    today = date.today()
    # Report on prior month (run on 2nd -> report prior month)
    first_of_current = today.replace(day=1)
    last_of_prior = first_of_current - timedelta(days=1)
    target_year = last_of_prior.year
    target_month = last_of_prior.month
    month_label = last_of_prior.strftime("%B %Y")
    month_start = f"{target_year}-{target_month:02d}-01"
    month_end = last_of_prior.isoformat()

    log.info(f"Reporting period: {month_label}")

    # ── Water data ──────────────────────────────────────────────────────
    # Water readings are cumulative meter reads — consumption = delta between reads
    water_current = conn.execute(
        "SELECT date, quantity_tgal FROM water_readings "
        "WHERE date >= ? AND date <= ? ORDER BY date DESC LIMIT 1",
        (month_start, month_end),
    ).fetchone()
    water_prior = conn.execute(
        "SELECT date, quantity_tgal FROM water_readings "
        "WHERE date < ? ORDER BY date DESC LIMIT 1",
        (month_start,),
    ).fetchone()

    water_consumption = None
    water_prior_consumption = None
    water_mom_pct = None

    if water_current and water_prior:
        water_consumption = water_current[1] - water_prior[1]
        log.info(f"Water: {water_consumption:.1f} TGAL ({water_prior[0]} -> {water_current[0]})")

        # MoM: need the reading before the prior one
        water_two_back = conn.execute(
            "SELECT date, quantity_tgal FROM water_readings "
            "WHERE date < ? ORDER BY date DESC LIMIT 1",
            (water_prior[0],),
        ).fetchone()
        if water_two_back:
            water_prior_consumption = water_prior[1] - water_two_back[1]
            if water_prior_consumption and water_prior_consumption > 0:
                water_mom_pct = ((water_consumption - water_prior_consumption) / water_prior_consumption) * 100
    elif water_current:
        log.info(f"Water: reading at {water_current[0]} ({water_current[1]} TGAL cumulative), no prior for delta")
    else:
        log.info("Water: no readings for this period")

    # ── Gas data ────────────────────────────────────────────────────────
    gas_current = conn.execute(
        "SELECT date, bill_amount, therms FROM gas_readings "
        "WHERE date >= ? AND date <= ? ORDER BY date DESC LIMIT 1",
        (month_start, month_end),
    ).fetchone()

    gas_therms = None
    gas_amount = None
    gas_prior_therms = None
    gas_mom_pct = None

    if gas_current:
        gas_amount = gas_current[1]
        gas_therms = gas_current[2]
        log.info(f"Gas: ${gas_amount:.2f}"
                 f"{f', {gas_therms:.1f} therms' if gas_therms else ''}")

        # MoM: find prior month's reading
        gas_prior = conn.execute(
            "SELECT date, bill_amount, therms FROM gas_readings "
            "WHERE date < ? ORDER BY date DESC LIMIT 1",
            (month_start,),
        ).fetchone()
        if gas_prior and gas_prior[2] and gas_therms:
            gas_prior_therms = gas_prior[2]
            if gas_prior_therms > 0:
                gas_mom_pct = ((gas_therms - gas_prior_therms) / gas_prior_therms) * 100
    else:
        log.info("Gas: no readings for this period")

    # ── Power data ──────────────────────────────────────────────────────
    power_row = conn.execute(
        "SELECT SUM(kwh), SUM(cost_estimate) FROM power_readings "
        "WHERE date >= ? AND date <= ?",
        (month_start, month_end),
    ).fetchone()

    power_kwh = None
    power_cost = None
    power_mom_pct = None

    if power_row and power_row[0]:
        power_kwh = power_row[0]
        power_cost = power_row[1]
        log.info(f"Power: {power_kwh:.1f} kWh, est ${power_cost:.2f}")

        # MoM
        if target_month == 1:
            pm_year, pm_month = target_year - 1, 12
        else:
            pm_year, pm_month = target_year, target_month - 1
        pm_start = f"{pm_year}-{pm_month:02d}-01"
        if pm_month == 12:
            pm_end = f"{pm_year}-12-31"
        else:
            pm_end_d = date(pm_year, pm_month + 1, 1) - timedelta(days=1)
            pm_end = pm_end_d.isoformat()

        prior_power = conn.execute(
            "SELECT SUM(kwh) FROM power_readings WHERE date >= ? AND date <= ?",
            (pm_start, pm_end),
        ).fetchone()
        if prior_power and prior_power[0] and prior_power[0] > 0:
            power_mom_pct = ((power_kwh - prior_power[0]) / prior_power[0]) * 100
    else:
        log.info("Power: no data for this period")

    # ── Check if we have any data at all ────────────────────────────────
    has_any = water_consumption is not None or gas_therms is not None or power_kwh is not None
    if not has_any:
        log.info("No utility data available for any source — skipping comparison")
        return

    # ── Format comparison text ──────────────────────────────────────────
    lines = [f"Utility Summary -- {month_label}", ""]

    if power_kwh is not None:
        mom_str = f" ({power_mom_pct:+.1f}% MoM)" if power_mom_pct is not None else ""
        lines.append(f"Power: {power_kwh:.1f} kWh, est ${power_cost:.2f}{mom_str}")
    else:
        lines.append("Power: data not available yet")

    if gas_therms is not None:
        mom_str = f" ({gas_mom_pct:+.1f}% MoM)" if gas_mom_pct is not None else ""
        lines.append(f"Gas: {gas_therms:.1f} therms, ${gas_amount:.2f}{mom_str}")
    elif gas_amount is not None:
        lines.append(f"Gas: ${gas_amount:.2f} (therms not parsed)")
    else:
        lines.append("Gas: no data")

    if water_consumption is not None:
        mom_str = f" ({water_mom_pct:+.1f}% MoM)" if water_mom_pct is not None else ""
        lines.append(f"Water: {water_consumption:.1f} TGAL{mom_str}")
    else:
        lines.append("Water: no data")

    comparison_text = "\n".join(lines)
    log.info(f"Comparison text:\n{comparison_text}")

    # ── T2 Synthesis via claude --print ─────────────────────────────────
    prompt_parts = [
        f"Analyze this utility usage summary for {month_label} (Cobb County, Georgia area).",
        "",
        comparison_text,
        "",
        "Provide: (1) brief analysis of each utility's usage, (2) seasonal context "
        "(Georgia climate — hot summers, mild winters), (3) any anomalies or items to watch, "
        "(4) actionable suggestions to reduce costs. Keep under 300 words.",
    ]
    prompt = "\n".join(prompt_parts)

    synthesis = None
    try:
        result = subprocess.run(
            ["claude", "--print", "-p", prompt],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode == 0 and result.stdout.strip():
            synthesis = result.stdout.strip()
            log.info(f"Claude synthesis received ({len(synthesis)} chars)")
        else:
            log.warning(f"Claude CLI returned code {result.returncode}: {result.stderr[:200]}")
    except subprocess.TimeoutExpired:
        log.warning("Claude CLI timed out (120s) — posting raw data without synthesis")
    except FileNotFoundError:
        log.warning("Claude CLI not found — posting raw data without synthesis")
    except Exception as e:
        log.warning(f"Claude CLI error: {e} — posting raw data without synthesis")

    # ── Build and POST capture ──────────────────────────────────────────
    capture_parts = [f"Utility Summary -- {month_label}", ""]
    if synthesis:
        capture_parts.append(synthesis)
        capture_parts.append("")
    capture_parts.append(comparison_text)
    capture_text = "\n".join(capture_parts)

    source_metadata = {
        "type": "utility_monthly",
        "month": f"{target_year}-{target_month:02d}",
        "month_label": month_label,
        "has_synthesis": synthesis is not None,
    }
    if power_kwh is not None:
        source_metadata["power_kwh"] = round(power_kwh, 1)
        source_metadata["power_cost_estimate"] = round(power_cost, 2) if power_cost else None
        if power_mom_pct is not None:
            source_metadata["power_mom_pct"] = round(power_mom_pct, 1)
    if gas_therms is not None:
        source_metadata["gas_therms"] = round(gas_therms, 1)
        source_metadata["gas_amount"] = round(gas_amount, 2) if gas_amount else None
        if gas_mom_pct is not None:
            source_metadata["gas_mom_pct"] = round(gas_mom_pct, 1)
    if water_consumption is not None:
        source_metadata["water_tgal"] = round(water_consumption, 1)
        if water_mom_pct is not None:
            source_metadata["water_mom_pct"] = round(water_mom_pct, 1)

    post_capture(cfg, capture_text, source_metadata)


# ── Status ───────────────────────────────────────────────────────────────────

def show_status(conn: sqlite3.Connection):
    """Print pipeline statistics."""
    print("\n=== Utility Pipeline Status ===\n")

    # Water
    water_count = conn.execute("SELECT COUNT(*) FROM water_readings").fetchone()[0]
    print(f"Water readings: {water_count}")
    if water_count > 0:
        latest = conn.execute(
            "SELECT date, quantity_tgal FROM water_readings ORDER BY date DESC LIMIT 1"
        ).fetchone()
        oldest = conn.execute(
            "SELECT date, quantity_tgal FROM water_readings ORDER BY date ASC LIMIT 1"
        ).fetchone()
        print(f"  Range: {oldest[0]} to {latest[0]}")
        print(f"  Latest: {latest[0]} — {latest[1]:.1f} TGAL (cumulative)")

        # Recent deltas
        recent = conn.execute(
            "SELECT date, quantity_tgal FROM water_readings ORDER BY date DESC LIMIT 4"
        ).fetchall()
        if len(recent) >= 2:
            print("  Recent consumption:")
            for i in range(len(recent) - 1):
                delta = recent[i][1] - recent[i + 1][1]
                print(f"    {recent[i + 1][0]} -> {recent[i][0]}: {delta:.1f} TGAL")

    # Gas
    print()
    gas_count = conn.execute("SELECT COUNT(*) FROM gas_readings").fetchone()[0]
    print(f"Gas readings: {gas_count}")
    if gas_count > 0:
        latest = conn.execute(
            "SELECT date, bill_amount, therms FROM gas_readings ORDER BY date DESC LIMIT 1"
        ).fetchone()
        oldest = conn.execute(
            "SELECT date FROM gas_readings ORDER BY date ASC LIMIT 1"
        ).fetchone()
        print(f"  Range: {oldest[0]} to {latest[0]}")
        therms_str = f"{latest[2]:.1f} therms" if latest[2] else "therms N/A"
        print(f"  Latest: {latest[0]} — ${latest[1]:.2f}, {therms_str}")

        # Parsed vs unparsed
        parsed = conn.execute(
            "SELECT COUNT(*) FROM gas_readings WHERE therms IS NOT NULL"
        ).fetchone()[0]
        print(f"  With therms data: {parsed}/{gas_count}")

    # Power
    print()
    power_count = conn.execute("SELECT COUNT(*) FROM power_readings").fetchone()[0]
    print(f"Power readings: {power_count}")
    if power_count > 0:
        total_kwh = conn.execute("SELECT SUM(kwh) FROM power_readings").fetchone()[0]
        latest = conn.execute(
            "SELECT date, kwh FROM power_readings ORDER BY date DESC LIMIT 1"
        ).fetchone()
        print(f"  Latest: {latest[0]} — {latest[1]:.1f} kWh")
        print(f"  Total stored: {total_kwh:.1f} kWh")
    else:
        print("  (electric-usage-downloader not configured yet)")

    print()


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Utility Pipeline for Open Brain")
    ap.add_argument("--water", action="store_true", help="Fetch water meter readings (Cobb County)")
    ap.add_argument("--gas", action="store_true", help="Fetch gas billing + parse PDFs (Gas South)")
    ap.add_argument("--power-summary", action="store_true", help="Aggregate power CSV data (stub)")
    ap.add_argument("--monthly-comparison", action="store_true", help="Unified utility synthesis + capture")
    ap.add_argument("--status", action="store_true", help="Show pipeline stats")
    args = ap.parse_args()

    # Require at least one action
    if not any([args.water, args.gas, args.power_summary, args.monthly_comparison, args.status]):
        ap.print_help()
        sys.exit(1)

    conn = init_db()

    if args.status:
        show_status(conn)
        conn.close()
        return

    cfg = load_config()

    if args.water:
        cmd_water(cfg, conn)
    if args.gas:
        cmd_gas(cfg, conn)
    if args.power_summary:
        cmd_power_summary(cfg, conn)
    if args.monthly_comparison:
        cmd_monthly_comparison(cfg, conn)

    conn.close()


if __name__ == "__main__":
    main()
