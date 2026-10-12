const MARKETPLACE_IDS = [1501];
const PRICE_DROP_THRESHOLD = 0.01;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DATA_DIR = './data';
const ALERTS_DIR = `${DATA_DIR}/alerts`;
const STATE_FILE = `${DATA_DIR}/cycle_state.json`;
const CACHE_FILE = `${DATA_DIR}/cache.json`;

let cachedMarketData = {};
let lastFetchTime = 0;
let isFetching = false;

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(ALERTS_DIR)) {
    fs.mkdirSync(ALERTS_DIR, { recursive: true });
  }
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      cachedMarketData = JSON.parse(data);
      console.log('[CACHE] Loaded from file');
    }
  } catch (err) {
    console.error('[CACHE] Failed to load:', err.message);
    cachedMarketData = {};
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cachedMarketData, null, 2));
  } catch (err) {
    console.error('[CACHE] Failed to save:', err.message);
  }
}

function getCycleState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[STATE] Failed to read:', err.message);
  }
  return { state: 'idle', timestamp: null };
}

function setCycleState(state) {
  try {
    const stateData = {
      state: state,
      timestamp: new Date().toISOString(),
      expiresAt: Date.now() + 86400000
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));
  } catch (err) {
    console.error('[STATE] Failed to write:', err.message);
  }
}

function isStateExpired() {
  const stateData = getCycleState();
  if (!stateData.expiresAt) return true;
  return Date.now() > stateData.expiresAt;
}

function listAlerts() {
  try {
    if (!fs.existsSync(ALERTS_DIR)) return [];
    
    const files = fs.readdirSync(ALERTS_DIR)
      .filter(file => file.startsWith('alert_') && file.endsWith('.json'))
      .map(file => ({
        name: file.replace('.json', ''),
        path: path.join(ALERTS_DIR, file),
        mtime: fs.statSync(path.join(ALERTS_DIR, file)).mtimeMs
      }))
      .sort((a, b) => a.mtime - b.mtime);
    
    return files;
  } catch (err) {
    console.error('[QUEUE] Failed to list alerts:', err.message);
    return [];
  }
}

function readAlert(key) {
  try {
    const filePath = path.join(ALERTS_DIR, `${key}.json`);
    if (!fs.existsSync(filePath)) return null;
    
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`[QUEUE] Failed to read alert ${key}:`, err.message);
    return null;
  }
}

function writeAlert(key, data) {
  try {
    const filePath = path.join(ALERTS_DIR, `${key}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[QUEUE] Failed to write alert ${key}:`, err.message);
  }
}

function deleteAlert(key) {
  try {
    const filePath = path.join(ALERTS_DIR, `${key}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`[QUEUE] Failed to delete alert ${key}:`, err.message);
  }
}

async function runCycle() {
  if (isFetching) {
    console.log("[CYCLE] Skipped: Already running");
    return;
  }

  isFetching = true;
  const startTime = Date.now();

  try {
    const stateData = getCycleState();
    const state = stateData.state;

    if (state === "queued" && !isStateExpired()) {
      console.log("[STATE] Queued detected → processing alert");
      await processOneAlert();
      
      const currentState = getCycleState();
      if (currentState.state !== "queued") {
        setCycleState("idle");
        console.log("[STATE] Reset to idle after successful alert processing");
      } else {
        console.log("[STATE] Remaining queued due to processing failure - will retry next minute");
      }
    } else {
      console.log("[STATE] Idle detected → checking prices");
      await checkPrices();
    }

    lastFetchTime = Date.now();
    console.log(`[CYCLE] Complete in ${Date.now() - startTime}ms`);
  } catch (err) {
    console.error("[CYCLE] Error:", err.message);
  } finally {
    isFetching = false;
  }
}

async function checkPrices() {
  console.log(`[PRICE] Checking ${MARKETPLACE_IDS.length} IDs`);
  let dropDetected = false;

  const apiKeyParam = process.env.WEAV3R_API_KEY ? `&apiKey=${process.env.WEAV3R_API_KEY}` : "";

  const promises = MARKETPLACE_IDS.map(async (id) => {
    try {
      const res = await fetch(`https://weav3r.dev/api/marketplace/${id}?filler=1${apiKeyParam}`, {
        headers: { "User-Agent": USER_AGENT }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      let currentLowest = null;
      const itemName = data.item_name || `Item ${id}`;

      if (data.listings?.length > 0) {
        currentLowest = Math.min(...data.listings.map(l => l.price));
      }

      const prev = cachedMarketData[id];
      cachedMarketData[id] = { 
        name: itemName, 
        lowestPrice: currentLowest, 
        timestamp: new Date().toISOString() 
      };

      if (currentLowest !== null && prev?.lowestPrice > 0) {
        const dropPct = (prev.lowestPrice - currentLowest) / prev.lowestPrice;

        if (dropPct >= PRICE_DROP_THRESHOLD) {
          console.log(`[ALERT] Drop detected: ID ${id} (${(dropPct * 100).toFixed(2)}%)`);

          const alertKey = `alert_${id}_${Date.now()}`;
          const alertData = {
            id,
            name: itemName,
            oldPrice: prev.lowestPrice,
            newPrice: currentLowest,
            dropPercent: parseFloat((dropPct * 100).toFixed(2)),
            timestamp: new Date().toISOString()
          };

          writeAlert(alertKey, alertData);
          dropDetected = true;
        }
      }
    } catch (err) {
      console.error(`[ERROR] ID ${id}:`, err.message);
    }
  });

  await Promise.allSettled(promises);
  saveCache();

  if (dropDetected) {
    setCycleState("queued");
    console.log("[STATE] Set to queued for next cycle");
  }
}

async function processOneAlert() {
  console.log("[QUEUE] Fetching oldest pending alert...");

  const alerts = listAlerts();
  if (alerts.length === 0) {
    console.log("[QUEUE] No alerts found despite queued state - resetting");
    setCycleState("idle");
    return;
  }

  console.log(`[QUEUE] Found ${alerts.length} pending, processing first`);

  const alertFile = alerts[0];
  const key = alertFile.name;
  const alert = readAlert(key);

  if (!alert) {
    console.log("[QUEUE] Stale key, deleting");
    deleteAlert(key);
    return;
  }

  console.log(`[QUEUE] Processing: ID ${alert.id} | ${alert.name} | ${alert.dropPercent}% drop`);

  try {
    await new Promise(resolve => setTimeout(resolve, 5000));

    const apiKeyParam = process.env.WEAV3R_API_KEY ? `?apiKey=${process.env.WEAV3R_API_KEY}` : "";
    const detailUrl = `https://weav3r.dev/api/marketplace/${alert.id}${apiKeyParam}`;
    console.log(`[DETAIL] GET ${detailUrl}`);

    const res = await fetch(detailUrl, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }
    });

    const rawBody = await res.text();
    console.log(`[DETAIL-RESPONSE] Status: ${res.status} | URL: ${detailUrl}`);

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${rawBody.substring(0, 200)}`);

    const data = JSON.parse(rawBody);
    let cheapestPlayerId = null;
    let actualLowest = alert.newPrice;

    if (data.listings?.length > 0) {
      const sorted = [...data.listings].sort((a, b) => a.price - b.price);
      cheapestPlayerId = sorted[0].player_id;
      actualLowest = sorted[0].price;
      console.log(`[LINK] Cheapest: Player ${cheapestPlayerId} @ ${actualLowest}`);
    }

    const link = cheapestPlayerId
      ? `https://www.torn.com/bazaar.php?userId=${cheapestPlayerId}#/`
      : `https://www.torn.com/bazaar.php?itemId=${alert.id}`;

    await sendDiscordAlert(alert.name, alert.oldPrice, actualLowest, alert.dropPercent, link);

    deleteAlert(key);
    console.log(`[QUEUE] ✅ Sent and removed for ID ${alert.id}`);

    setCycleState("idle");

  } catch (err) {
    console.error(`[QUEUE] ❌ Failed for ID ${alert.id}: ${err.message}`);
    console.log("[QUEUE] Alert preserved for retry - state remains queued");
  }
}

async function sendDiscordAlert(name, oldPrice, newPrice, dropPct, link) {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    throw new Error('DISCORD_WEBHOOK_URL not configured');
  }

  const payload = {
    content: "@everyone",
    embeds: [{
      author: { name: `New Alert for ${name}` },
      title: `Price of ${name} has dropped by ${dropPct.toFixed(2)}%`,
      color: 3349162,
      description: `Click the link below to go to the bazaar\n${link}`
    }],
    attachments: []
  };

  console.log("[WEBHOOK] Sending payload");

  const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (res.ok || res.status === 204) {
    console.log("[WEBHOOK] ✅ Success");
  } else {
    const errText = await res.text();
    throw new Error(`Discord ${res.status}: ${errText}`);
  }
}

function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] Received ${signal}. Cleaning up...`);
  process.exit(0);
}

async function main() {
  ensureDirectories();
  loadCache();
  
  cron.schedule('* * * * *', async () => {
    console.log(`[CRON] Fired at ${new Date().toISOString()}`);
    await runCycle();
  });
  
  console.log('[INIT] Application started - monitoring every minute');
  
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch(err => {
  console.error('[FATAL] Failed to start:', err);
  process.exit(1);
});
