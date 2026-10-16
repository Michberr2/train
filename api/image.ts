// Legacy image endpoint. Existing anonymous callers keep their request/response
// contract; generated images now always return validated, stable raster bytes.
import { cors } from './_cors'
import { generateImage, imageDataUrl, imageSize } from './_imageGeneration'

export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  let body: any
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {} }
  catch { return res.status(400).json({ error: 'invalid JSON' }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Provide an image request object.' })
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt || prompt.length > 6000) return res.status(400).json({ error: 'Provide an image prompt of up to 6000 characters.' })
  let size
  try { size = imageSize(body.size) }
  catch (error) { return res.status(400).json({ error: (error as Error).message }) }
  try {
    const image = await generateImage(prompt, size.width, size.height, { timeoutMs: 220000 })
    return res.status(200).json({ url: imageDataUrl(image), name: 'Nalu Image' })
  } catch { return res.status(502).json({ error: 'The image service could not produce an image. Please retry.' }) }
}
