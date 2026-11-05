// Loaded explicitly by the isolated integration test, never by the companion.
globalThis.fetch = async (url, options) => {
  if (url !== 'https://n4lu.com/api/auth') throw Error('Unexpected fixture request')
  const token = options.headers.Authorization
  if (!['Bearer fixture-owner-a', 'Bearer fixture-owner-b'].includes(token)) return Response.json({ error: 'invalid' }, { status: 401 })
  return Response.json({ user: { id: token.endsWith('-a') ? 'owner-a' : 'owner-b' } })
}
