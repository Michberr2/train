// OpenSCAD compile worker. Runs the openscad-wasm CGAL compile OFF the main
// thread so a heavy/slow model never freezes the page, and so a runaway compile
// can be killed by terminating the worker (the main thread can't interrupt a
// synchronous wasm callMain — that was the cause of "the whole site hangs").
//
// Message in:  { code: string }
// Message out: { stl: Uint8Array } (buffer transferred)  OR  { error: string }

const OPENSCAD_URL = '/openscad/openscad.js'

// openscad-wasm's Emscripten glue only takes its fetch() path to load the .wasm
// when it believes it is in a web/worker environment, which it detects via
// `typeof importScripts === 'function'`. A *module* worker has no window and no
// importScripts, so both flags are false and it aborts with "fetching of the wasm
// failed". importScripts is referenced ONLY for that detection (never to load
// code here), so a harmless no-op shim restores the correct fetch path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof (globalThis as any).importScripts !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).importScripts = () => {}
}

// Rebrand the underlying engine's console chatter to Nalu, so nothing in the
// browser console reveals a third-party name. (Comments here aren't shipped.)
const naluize = (s: unknown): string =>
  String(s).replace(/open ?scad/gi, 'Nalu CAD').replace(/\bCGAL\b/g, 'Nalu geometry')
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (self as any).console
  for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = c[k]?.bind(c)
    if (orig) c[k] = (...args: unknown[]) => orig(...args.map(naluize))
  }
}

self.onmessage = async (e: MessageEvent<{ code: string }>) => {
  const code = e.data?.code ?? ''
  let err = ''
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ OPENSCAD_URL)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance: any = await mod.default({
      noInitialRun: true,
      printErr: (s: string) => {
        err += naluize(s) + '\n'
      },
      print: (s: string) => {
        err += naluize(s) + '\n'
      },
    })
    instance.FS.writeFile('/in.scad', code)
    try {
      instance.callMain(['/in.scad', '--export-format=binstl', '-o', '/out.stl'])
    } catch {
      /* Emscripten throws ExitStatus on normal exit */
    }
    let out: Uint8Array
    try {
      out = instance.FS.readFile('/out.stl')
    } catch {
      ;(self as unknown as Worker).postMessage({ error: (err || 'Nalu CAD produced no output.').slice(0, 1500) })
      return
    }
    if (!out || out.length < 84) {
      ;(self as unknown as Worker).postMessage({ error: (err || 'Empty model.').slice(0, 1500) })
      return
    }
    // Copy into a standalone buffer we can transfer (zero-copy) to the main thread.
    const copy = new Uint8Array(out)
    ;(self as unknown as Worker).postMessage({ stl: copy }, [copy.buffer])
  } catch (ex) {
    ;(self as unknown as Worker).postMessage({
      error: (err || (ex instanceof Error ? ex.message : 'compile failed')).slice(0, 1500),
    })
  }
}
