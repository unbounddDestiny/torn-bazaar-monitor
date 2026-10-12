#!/bin/bash

echo "🚀 Setting up Torn Marketplace Monitor..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ required. Current: $(node -v)"
    exit 1
fi

echo "✅ Node.js $(node -v) detected"
echo "📦 Installing dependencies..."
npm install --production

if [ ! -f .env ]; then
    echo "⚙️  Creating .env file..."
    cat > .env << 'EOF'
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
# WEAV3R_API_KEY=optional_api_key_here
EOF
    echo "⚠️  Edit .env with your Discord webhook: nano .env"
fi

mkdir -p data/alerts

echo ""
echo "✅ Setup complete!"
echo "📝 Next: Edit .env, then run: npm start"
echo "💡 For production: npm install -g pm2 && pm2 start index.js --name torn-monitor"
