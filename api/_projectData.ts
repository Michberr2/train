import { projectKeys, projectWrites } from '../shared/projectMerge'

/** A dedicated request client holds this lock through both writes, including
 * when no project row exists yet. Tombstones and snapshots cannot race. */
export async function writeProjectData(client: any, owner: string, key: string, value: unknown): Promise<Record<string, unknown>> {
  const keys = projectKeys(key)
  if (!keys) throw new Error('Not a project key')
  await client.query('BEGIN')
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('nalu-project-data'), hashtext($1))", [owner])
    const values: Record<string, unknown> = {}
    for (const name of keys) {
      const result = await client.query('SELECT value FROM nalu_user_data WHERE user_id = $1 AND key = $2', [owner, name])
      values[name] = result.rows[0]?.value
    }
    const changed = projectWrites(values, key, value)
    for (const [name, next] of Object.entries(changed)) await client.query(
      `INSERT INTO nalu_user_data (user_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [owner, name, JSON.stringify(next)],
    )
    await client.query('COMMIT')
    return changed
  } catch (error) { await client.query('ROLLBACK'); throw error }
}
