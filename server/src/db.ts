import pg from 'pg'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL not set — waitlist endpoints will fail until configured')
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})
