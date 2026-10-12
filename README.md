# Torn Marketplace Price Monitor

Automatically monitors Torn marketplace prices and sends Discord alerts when prices drop.

## Quick Deploy to VPS

```bash
git clone https://github.com/YOUR_USERNAME/torn-bazaar-monitor.git
cd torn-bazaar-monitor
chmod +x setup.sh
./setup.sh
nano .env  # Add your Discord webhook URL
npm start
