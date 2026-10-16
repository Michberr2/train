/** Stream large saved-data responses using the existing JSON contract. Native
 * and browser clients still call response.json(); they do not need a new format.
 * This avoids the host's buffered response limit without dropping history. */
export async function storedJson(res: any, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length < 1000000 || typeof res.write !== 'function') { res.json(value); return }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'private, no-store')
  res.flushHeaders?.()
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    if (res.destroyed || res.writableEnded) return
    if (res.write(bytes.subarray(offset, offset + 32768)) === false) {
      const ready = await new Promise<boolean>((resolve, reject) => {
        const cleanup = () => { res.off('drain', drain); res.off('close', close); res.off('error', error) }
        const drain = () => { cleanup(); resolve(true) }
        const close = () => { cleanup(); resolve(false) }
        const error = (err: Error) => { cleanup(); reject(err) }
        res.once('drain', drain); res.once('close', close); res.once('error', error)
        if (res.destroyed || res.writableEnded) close()
      })
      if (!ready) return
    }
  }
  res.end()
}
