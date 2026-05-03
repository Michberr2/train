# Train — Meet Nalu Slider

React.js + Node.js + Postgres recreation of the `meet nalu` 5-page slider from `nalumobilefriendly`.

## Stack
- **client**: Vite + React 18 + TypeScript (.tsx) + Tailwind + Framer Motion
- **server**: Node.js + Express + TypeScript + `pg` (Postgres)
- **db**: Postgres (`waitlist` table)

## Setup

```bash
# 1. Install
npm install

# 2. Configure server env
cp server/.env.example server/.env
# edit DATABASE_URL

# 3. Initialize Postgres schema
npm run db:init

# 4. Run dev (client :5173, server :4000)
npm run dev
```

Vite proxies `/api/*` to the Express server on `:4000`.

## Pages (slider)
1. Meet Nalu — Hero + email capture
2. Platform — Wealth Management AI
3. Solutions — Methods / Advice / Reliability / Reward tabs
4. Pricing — three-tier
5. Learn — Company / Documentation / About tabs
