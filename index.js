const MARKETPLACE_IDS = [1501];
const PRICE_DROP_THRESHOLD = 0.01;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CACHE_FILE = './price_cache.json';

let cachedMarketData = {};
const fs = require('fs');
const cron = require('node-cron');

// Load cache
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      cachedMarketData = JSON.parse(data);
      console.log('[CACHE] Loaded from file');
    }
  } catch (err) {
    console.error('[CACHE] Failed to load:', err.message);
  }
}

// Save cache
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cachedMarketData, null, 2));
  } catch (err) {
    console.error('[CACHE] Failed to save:', err.message);
  }
}

// Send Discord alert immediately
async function sendDiscordAlert(name, oldPrice, newPrice, dropPct, link) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.error('[ERROR] DISCORD_WEBHOOK_URL not set in environment');
    return false;
  }

  const payload = {
    content: "@everyone",
    embeds: [{
      author: { name: `🚨 Price Drop Alert: ${name}` },
      title: `Price dropped by ${dropPct.toFixed(2)}%`,
      description: `Old: $${oldPrice.toFixed(2)} → New: $${newPrice.toFixed(2)}\n\n[View on Bazaar](${link})`,
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
      console.log(`[ALERT] ✅ Sent Discord notification for ${name}`);
      return true;
    } else {
      const errText = await res.text();
      console.error(`[ALERT] ❌ Discord failed: ${res.status} - ${errText}`);
      return false;
    }
  } catch (err) {
    console.error(`[ALERT] ❌ Failed to send: ${err.message}`);
    return false;
  }
}

// Check prices and send alerts immediately
async function checkPrices() {
  console.log(`[CHECK] Monitoring ${MARKETPLACE_IDS.length} items...`);

  const apiKeyParam = process.env.WEAV3R_API_KEY ? `&apiKey=${process.env.WEAV3R_API_KEY}` : "";

  for (const id of MARKETPLACE_IDS) {
    try {
      const res = await fetch(`https://weav3r.dev/api/marketplace/${id}?filler=1${apiKeyParam}`, {
        headers: { "User-Agent": USER_AGENT }
      });
      
      if (!res.ok) {
        console.error(`[ERROR] HTTP ${res.status} for item ${id}`);
        continue;
      }

      const data = await res.json();
      const itemName = data.item_name || `Item ${id}`;
      
      let currentLowest = null;
      if (data.listings?.length > 0) {
        currentLowest = Math.min(...data.listings.map(l => l.price));
      }

      const prev = cachedMarketData[id];
      
      // Update cache with current price
      cachedMarketData[id] = { 
        name: itemName, 
        lowestPrice: currentLowest, 
        timestamp: new Date().toISOString() 
      };

      // Check for price drop
      if (currentLowest !== null && prev?.lowestPrice > 0) {
        const dropPct = (prev.lowestPrice - currentLowest) / prev.lowestPrice;

        if (dropPct >= PRICE_DROP_THRESHOLD) {
          console.log(`[DROP] 📉 ${itemName}: ${(dropPct * 100).toFixed(2)}% drop ($${prev.lowestPrice} → $${currentLowest})`);
          
          // Get detailed info for the link
          let link = `https://www.torn.com/bazaar.php?itemId=${id}`;
          
          try {
            const detailRes = await fetch(`https://weav3r.dev/api/marketplace/${id}${apiKeyParam ? `?apiKey=${process.env.WEAV3R_API_KEY}` : ''}`, {
              headers: { "User-Agent": USER_AGENT }
            });
            
            if (detailRes.ok) {
              const detailData = await detailRes.json();
              if (detailData.listings?.length > 0) {
                const sorted = [...detailData.listings].sort((a, b) => a.price - b.price);
                const cheapestPlayerId = sorted[0].player_id;
                if (cheapestPlayerId) {
                  link = `https://www.torn.com/bazaar.php?userId=${cheapestPlayerId}#/`;
                }
              }
            }
          } catch (err) {
            console.error(`[WARN] Could not fetch details for link: ${err.message}`);
          }

          // Send alert IMMEDIATELY
          await sendDiscordAlert(itemName, prev.lowestPrice, currentLowest, dropPct * 100, link);
        }
      }
      
    } catch (err) {
      console.error(`[ERROR] Failed to check item ${id}: ${err.message}`);
    }
  }

  // Save updated cache
  saveCache();
  console.log('[CHECK] ✓ Complete\n');
}

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] Received ${signal}`);
  saveCache();
  process.exit(0);
}

// Initialize
async function main() {
  // Check for required env vars
  if (!process.env.DISCORD_WEBHOOK_URL) {
    console.error('❌ ERROR: DISCORD_WEBHOOK_URL is not set!');
    console.error('Create a .env file with: DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN');
    process.exit(1);
  }

  console.log('✅ Environment variables loaded');
  console.log(`   Webhook: ${process.env.DISCORD_WEBHOOK_URL.substring(0, 30)}...`);
  if (process.env.WEAV3R_API_KEY) {
    console.log(`   API Key: Configured`);
  } else {
    console.log(`   API Key: Not set (using public rate limits)`);
  }
  console.log('');

  loadCache();
  
  // Run immediately on start
  console.log('[INIT] Running initial check...\n');
  await checkPrices();
  
  // Schedule every minute
  cron.schedule('* * * * *', async () => {
    await checkPrices();
  });
  
  console.log('✅ Monitoring active - checking every minute');
  console.log('   Press Ctrl+C to stop\n');
  
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
