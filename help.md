# from repo root

# Backend
cd wa-mcp-bot/backend
cp .env.example .env
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload

# Bot (separate terminal)
cd wa-mcp-bot/bot
cp .env.example .env
npm install
node bot.js