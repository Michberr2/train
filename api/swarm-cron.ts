import { runDueSwarmJobs } from './_swarmWorker'

/** Separate budget from existing Autopilot and message delivery schedules. */
export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store')
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized.' })
  try {
    return res.status(200).json({ ok: true, ...await runDueSwarmJobs() })
  } catch { return res.status(500).json({ error: 'The Swarm scheduler could not finish this pass.' }) }
}
