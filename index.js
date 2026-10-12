require('dotenv').config();

const fs = require('fs');
const cron = require('node-cron');

// --- CONFIGURATION ---
// REPLACE THIS WITH YOUR CLOUDFLARE WORKER URL
const SETTINGS_URL = 'https://your-worker-name.your-subdomain.workers.dev/api/settings';

const MARKETPLACE_URL = 'https://weav3r.dev/api/marketplace';
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CACHE_FILE = './price_cache.json';

let cachedMarketData = {};
let currentSettings = {};

// --- HELPER FUNCTIONS ---

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      cachedMarketData = JSON.parse(data);
      console.log(`[CACHE] Loaded ${Object.keys(cachedMarketData).length} items`);
    }
  } catch (err) { console.error('[CACHE] Load failed:', err.message); }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cachedMarketData, null, 0));
  } catch (err) { console.error('[CACHE] Save failed:', err.message); }
}

async function fetchSettings() {
  try {
    const res = await fetch(SETTINGS_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    // Update live settings
    currentSettings.webhook = data.webhook;
    currentSettings.threshold = parseFloat(data.threshold) || 1;
    currentSettings.itemIds = data.itemIds ? data.itemIds.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
    
    console.log(`[CONFIG] Updated: Threshold=${currentSettings.threshold}%, Tracking=${currentSettings.itemIds.length > 0 ? currentSettings.itemIds.length + ' items' : 'ALL'}`);
  } catch (err) {
    console.error(`[CONFIG] Failed to fetch settings: ${err.message}`);
  }
}

async function sendDiscordAlert(name, itemId, oldPrice, newPrice, dropPct, link) {
  if (!currentSettings.webhook) return;

  const payload = {
    embeds: [{
      title: `📉 Price Drop: ${name}`,
      url: link,
      color: 15158332,
      fields: [
        { name: 'Old Price', value: `$${oldPrice.toLocaleString()}`, inline: true },
        { name: 'New Price', value: `$${newPrice.toLocaleString()}`, inline: true },
        { name: 'Drop', value: `${dropPct.toFixed(2)}%`, inline: true }
      ],
      footer: { text: `Item ID: ${itemId}` }
    }]
  };

  try {
    const res = await fetch(currentSettings.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok || res.status === 204) console.log(`[ALERT] ✅ Sent: ${name}`);
    else console.error(`[ALERT] ❌ Discord Error: ${res.status}`);
  } catch (err) { console.error(`[ALERT] ❌ Send failed: ${err.message}`); }
}

async function sendErrorWebhook(errorTitle, errorMessage) {
  if (!currentSettings.webhook) return;
  
  const payload = {
    embeds: [{
      title: `⚠️ ERROR: ${errorTitle}`,
      description: errorMessage,
      color: 16711680,
      timestamp: new Date().toISOString()
    }]
  };

  try {
    await fetch(currentSettings.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) { console.error('[ERROR WEBHOOK] Failed to send error report'); }
}

// --- MAIN LOGIC ---

async function checkPrices() {
  // 1. Always fetch latest settings first
  await fetchSettings();

  if (!currentSettings.webhook) {
    console.log('[CHECK] Skipped: No webhook configured in remote settings');
    return;
  }

  console.log(`[CHECK] Starting marketplace scan...`);
  const startTime = Date.now();

  try {
    const res = await fetch(MARKETPLACE_URL, {
      headers: { 'User-Agent': USER_AGENT }
    });

    // Handle 500 Errors specifically
    if (res.status >= 500) {
      let errorBody = { error: 'Server Error', message: 'No details' };
      try { errorBody = await res.json(); } catch (e) {}
      await sendErrorWebhook(errorBody.error || 'API Server Error', errorBody.message || 'Unknown error from Weav3r');
      return;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const rawData = await res.json();
    const items = Array.isArray(rawData) ? rawData : (rawData.items || []);
    
    let dropsFound = 0;
    const newCache = {};

    for (const item of items) {
      const id = item.item_id;
      
      // Filter Logic
      if (currentSettings.itemIds.length > 0 && !currentSettings.itemIds.includes(id)) continue;
      
      // Skip invalid data
      if (item.lowest_price === null || item.total_bazaars === 0) continue;

      newCache[id] = item.lowest_price;
      const prevPrice = cachedMarketData[id];

      // Check for drop
      if (prevPrice && prevPrice > 0 && item.lowest_price < prevPrice) {
        const dropPct = ((prevPrice - item.lowest_price) / prevPrice) * 100;
        
        if (dropPct >= currentSettings.threshold) {
          dropsFound++;
          console.log(`[DROP] 📉 ${item.item_name}: ${(dropPct).toFixed(2)}% ($${prevPrice} → $${item.lowest_price})`);
          
          // Get detailed info for the link (Find cheapest player)
          let link = `https://www.torn.com/bazaar.php?itemId=${id}`;
          try {
            const detailRes = await fetch(`${MARKETPLACE_URL}/${id}`, {
              headers: { 'User-Agent': USER_AGENT }
            });
            if (detailRes.ok) {
              const detailData = await detailRes.json();
              if (detailData.listings && detailData.listings.length > 0) {
                // Sort by price to find the absolute cheapest
                const sortedListings = detailData.listings.sort((a, b) => a.price - b.price);
                const cheapestPlayerId = sortedListings[0].player_id;
                if (cheapestPlayerId) {
                  link = `https://www.torn.com/bazaar.php?userId=${cheapestPlayerId}#/`;
                }
              }
            }
          } catch (err) {
            console.error(`[WARN] Could not fetch details for link: ${err.message}`);
          }

          await sendDiscordAlert(item.item_name, id, prevPrice, item.lowest_price, dropPct, link);
        }
      }
    }

    // Update cache with only tracked items to keep file small
    cachedMarketData = { ...cachedMarketData, ...newCache };
    saveCache();

    const totalTime = Date.now() - startTime;
    console.log(`[CHECK] ✓ Done in ${totalTime}ms | Drops: ${dropsFound}\n`);

  } catch (err) {
    console.error(`[CHECK] ❌ Critical Failure: ${err.message}`);
    await sendErrorWebhook('Monitor Crash', err.message);
  }
}

// --- INITIALIZATION ---

async function main() {
  console.log('[INIT] Starting Torn Marketplace Monitor...');
  loadCache();
  
  // Run immediately
  await checkPrices();

  // Schedule every minute
  cron.schedule('* * * * *', checkPrices);

  console.log('[INIT] Active. Waiting for next cycle...\n');
}

main();
