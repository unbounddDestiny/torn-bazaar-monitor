require('dotenv').config();

const MARKETPLACE_URL = 'https://weav3r.dev/api/marketplace';
const PRICE_DROP_THRESHOLD = 0.01; // 1% drop triggers alert
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CACHE_FILE = './price_cache.json';

// Optional: Only track specific IDs. Leave empty [] to track EVERYTHING
const TRACKED_ITEM_IDS = []; 

let cachedMarketData = {};
const fs = require('fs');
const cron = require('node-cron');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      cachedMarketData = JSON.parse(data);
      console.log(`[CACHE] Loaded ${Object.keys(cachedMarketData).length} items from file`);
    }
  } catch (err) {
    console.error('[CACHE] Failed to load:', err.message);
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cachedMarketData, null, 0)); // Compact JSON for speed
  } catch (err) {
    console.error('[CACHE] Failed to save:', err.message);
  }
}

async function sendDiscordAlert(name, itemId, oldPrice, newPrice, dropPct) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const link = `https://www.torn.com/bazaar.php?itemId=${itemId}`;
  const payload = {
    content: "@everyone",
    embeds: [{
      author: { name: `🚨 Price Drop: ${name}` },
      title: `${dropPct.toFixed(2)}% Drop Detected!`,
      description: `**Old:** $${oldPrice.toLocaleString()}\n**New:** $${newPrice.toLocaleString()}\n\n[View Item on Bazaar](${link})`,
      color: 15158332,
      timestamp: new Date().toISOString()
    }]
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok || res.status === 204) {
      console.log(`[ALERT] ✅ Sent: ${name} (${dropPct.toFixed(2)}%)`);
      return true;
    }
    console.error(`[ALERT] ❌ Discord ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error(`[ALERT] ❌ Send failed: ${err.message}`);
  }
  return false;
}

async function checkAllPrices() {
  const startTime = Date.now();
  console.log(`[CHECK] Fetching full marketplace...`);

  try {
    const apiKeyParam = process.env.WEAV3R_API_KEY ? `?apiKey=${process.env.WEAV3R_API_KEY}` : "";
    const res = await fetch(`${MARKETPLACE_URL}${apiKeyParam}`, {
      headers: { "User-Agent": USER_AGENT }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const rawData = await res.json();
    const parseTime = Date.now();
    
    // Handle both array and object-wrapped responses
    const items = Array.isArray(rawData) ? rawData : (rawData.items || rawData.data || []);
    
    if (!items.length) throw new Error("No items found in API response");

    let dropsFound = 0;
    let itemsTracked = 0;

    for (const item of items) {
      const id = item.item_id;
      
      // Filter: Skip if we're tracking specific IDs and this isn't one of them
      if (TRACKED_ITEM_IDS.length > 0 && !TRACKED_ITEM_IDS.includes(id)) continue;
      
      // Skip items with no active bazaars or null prices
      const currentLowest = item.lowest_price;
      if (currentLowest === null || currentLowest === undefined || item.total_bazaars === 0) continue;

      itemsTracked++;
      const itemName = item.item_name || `Item ${id}`;
      const prev = cachedMarketData[id];

      // Update cache
      cachedMarketData[id] = {
        name: itemName,
        lowestPrice: currentLowest,
        timestamp: Date.now()
      };

      // Check for drop
      if (prev && prev.lowestPrice > 0 && currentLowest < prev.lowestPrice) {
        const dropPct = (prev.lowestPrice - currentLowest) / prev.lowestPrice;

        if (dropPct >= PRICE_DROP_THRESHOLD) {
          dropsFound++;
          console.log(`[DROP] 📉 ${itemName}: ${(dropPct * 100).toFixed(2)}% ($${prev.lowestPrice.toLocaleString()} → $${currentLowest.toLocaleString()})`);
          
          // Send immediately - don't wait
          await sendDiscordAlert(itemName, id, prev.lowestPrice, currentLowest, dropPct * 100);
        }
      }
    }

    saveCache();
    const totalTime = Date.now() - startTime;
    console.log(`[CHECK] ✓ Done in ${totalTime}ms | Tracked: ${itemsTracked} | Drops: ${dropsFound} | Parse: ${parseTime - startTime}ms\n`);

  } catch (err) {
    console.error(`[CHECK] ❌ Failed: ${err.message}\n`);
  }
}

function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received. Saving cache...`);
  saveCache();
  process.exit(0);
}

async function main() {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    console.error('❌ DISCORD_WEBHOOK_URL not set in .env');
    process.exit(1);
  }

  console.log('✅ Environment loaded');
  console.log(`   Mode: ${TRACKED_ITEM_IDS.length > 0 ? `Tracking ${TRACKED_ITEM_IDS.length} items` : 'Tracking ALL items'}`);
  console.log(`   Threshold: ${PRICE_DROP_THRESHOLD * 100}%\n`);

  loadCache();

  // Run immediately on start
  await checkAllPrices();

  // Schedule every minute
  cron.schedule('* * * * *', checkAllPrices);

  console.log('✅ Monitoring active\n');
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
