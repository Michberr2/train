#!/usr/bin/env python3
# serve-browser.py — a tiny local Chromium for Nalu's web Screen executor.
#
# This runs a REAL Chromium on your machine (Playwright). n4lu.ai embeds its live
# screen and tells it what to click — but the THINKING happens on n4lu.ai
# (/api/agent), so this runner needs **NO API key**. Your browser reaches
# localhost directly, so no tunnel either.
#
# --- Install (one time) ----------------------------------------------------
#   python -m venv ~/nbrowser && source ~/nbrowser/bin/activate
#   pip install -U playwright fastapi "uvicorn[standard]" httpx
#   python -m playwright install chromium
#
# --- Run -------------------------------------------------------------------
#   python scripts/serve-browser.py           # a Chromium window opens; :8700
#
# Then on n4lu.ai open "Nalu Browser" and type a task — you watch it work and
# can take over the real window for passwords / 2FA. Logins persist (profile).
#
# Env (optional):
#   NALU_AGENT_URL   default https://n4lu.ai   (where the brain lives)
#   PORT             default 8700
#   NALU_BROWSER_HEADLESS=1  to hide the window (default: shown)

import asyncio
import json
import os
import shutil
import subprocess

import httpx
import uvicorn
from fastapi import FastAPI, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from playwright.async_api import async_playwright

AGENT_URL = os.environ.get("NALU_AGENT_URL", "https://n4lu.ai").rstrip("/")
PORT = int(os.environ.get("PORT", "8700"))
# Headless by DEFAULT: the browser appears INSIDE n4lu.ai (its live screen is
# streamed into the page), not as a separate window. You click & type on that
# embedded screen. Set NALU_BROWSER_HEADLESS=0 only if you also want a real
# pop-up window on your desktop.
HEADLESS = os.environ.get("NALU_BROWSER_HEADLESS", "1") not in ("0", "false", "no")
PROFILE = os.environ.get("NALU_BROWSER_PROFILE", os.path.expanduser("~/.nalu-web-browser"))
MAX_STEPS = int(os.environ.get("NALU_BROWSER_MAX_STEPS", "24"))

EXTRACT_JS = r"""(function(){
  function vis(el){var r=el.getBoundingClientRect();var s=getComputedStyle(el);return r.width>1&&r.height>1&&s.visibility!=='hidden'&&s.display!=='none'&&r.bottom>0&&r.top<innerHeight+300;}
  var sel='a,button,input,textarea,select,[role=button],[role=link],[role=tab],[onclick]';
  var els=[].slice.call(document.querySelectorAll(sel)).filter(vis).slice(0,120);
  var out=[];
  els.forEach(function(el,i){
    el.setAttribute('data-nalu-idx',i);
    var t=(el.innerText||el.value||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('name')||'').trim().replace(/\s+/g,' ');
    out.push({i:i,tag:el.tagName.toLowerCase(),type:el.getAttribute('type')||'',text:t});
  });
  return JSON.stringify({url:location.href,title:document.title,elements:out});
})()"""

app = FastAPI()


# The primary UI is served from this SAME origin (the iframe loads https://localhost:8701
# and calls its own endpoints), so it needs no CORS at all. These headers exist only for
# n4lu.ai's optional health probe — and we allow ONLY n4lu.ai/n4lu.com, so a random site
# the user visits can't drive their local browser.
ALLOWED_ORIGINS = {"https://n4lu.ai", "https://n4lu.com"}


@app.middleware("http")
async def cors_pna(request, call_next):
    origin = request.headers.get("origin", "")
    allowed = origin in ALLOWED_ORIGINS
    if request.method == "OPTIONS":
        from starlette.responses import Response as R

        resp = R(status_code=204)
    else:
        resp = await call_next(request)
    if allowed:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "*"
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
    return resp


S: dict = {}


async def _launch(pw, headless):
    ctx = await pw.chromium.launch_persistent_context(
        PROFILE, headless=headless, viewport={"width": 1280, "height": 820}, args=["--no-default-browser-check"]
    )
    page = ctx.pages[0] if ctx.pages else await ctx.new_page()
    try:
        await page.goto("about:blank")
    except Exception:
        pass
    # Verify the renderer actually works. A headful Chromium launched from a
    # process with no GUI session (e.g. a detached background runner) starts but
    # never renders — screenshot/evaluate then fail. Check both.
    await asyncio.wait_for(page.screenshot(type="png"), timeout=8)
    await asyncio.wait_for(page.evaluate("1+1"), timeout=8)
    return ctx, page


@app.on_event("startup")
async def startup():
    S["lock"] = asyncio.Lock()  # created in uvicorn's loop (3.9-safe)
    pw = await async_playwright().start()
    S["pw"] = pw
    try:
        ctx, page = await _launch(pw, HEADLESS)
        mode = "headless" if HEADLESS else "window"
    except Exception as e:
        if not HEADLESS:
            print(f"!! window mode unavailable here ({e!r}) — using headless; watch it in the panel")
            ctx, page = await _launch(pw, True)
            mode = "headless (no GUI session)"
        else:
            raise
    S["ctx"], S["page"] = ctx, page
    print(f">> Nalu local browser ready [{mode}] — brain at {AGENT_URL}/api/web (no local key)")


# The full Nalu Browser UI, served BY this local server so it loads from
# http://localhost:8700 — every call below is same-origin (no mixed-content / no
# Private Network Access wall), so it works in Chrome, Safari AND Firefox. The
# brain stays server-side (see next_action), so this page needs no API key.
INDEX_HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Nalu Browser</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0b0c10;color:#ededed;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
body{display:flex;flex-direction:column;height:100vh}
.bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.1)}
.title{font-weight:600;font-size:14px}
.badge{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.1);color:#9a9a9a}
.badge.ok{background:rgba(16,185,129,.15);color:#6ee7b7}
.hint{font-size:11px;color:#9fd0ff}
.row{display:flex;align-items:center;gap:8px;padding:8px 14px;border-top:1px solid rgba(255,255,255,.1)}
.row.top{border-top:none;border-bottom:1px solid rgba(255,255,255,.1)}
input{flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.15);color:#ededed;
border-radius:8px;padding:8px 12px;font-size:13px;outline:none}
input:focus{border-color:rgba(255,255,255,.3)}
button{background:rgba(255,255,255,.1);color:#ededed;border:none;border-radius:8px;padding:8px 14px;
font-size:13px;cursor:pointer}button:hover{background:rgba(255,255,255,.2)}
button.primary{background:rgba(34,211,238,.9);color:#fff;font-weight:500}
button.primary:hover{background:rgb(34,211,238)}button:disabled{opacity:.5;cursor:default}
.screen{flex:1;overflow:hidden;padding:12px;background:#0c0e14;outline:none}
.screen:focus{box-shadow:inset 0 0 0 1px rgba(34,211,238,.4)}
.screen img{display:block;margin:0 auto;width:100%;max-width:1100px;border-radius:10px;
border:1px solid rgba(255,255,255,.12);background:#fff;cursor:crosshair;user-select:none}
.log{max-height:120px;overflow:auto;padding:8px 14px;border-top:1px solid rgba(255,255,255,.1);
background:rgba(0,0,0,.3);font-size:12px;color:#bcd}.log .res{color:#ededed;margin-bottom:4px}
</style></head><body>
<div class="bar"><span class="title">&#129441; Nalu Browser</span>
<span id="badge" class="badge">connecting&hellip;</span>
<span class="hint" style="margin-left:auto">click &amp; type on the screen to take over &mdash; keystrokes stay on your machine</span></div>
<div class="row top"><input id="addr" placeholder="Address (e.g. gmail.com)" />
<button onclick="go()">Go</button></div>
<div id="screen" class="screen" tabindex="0"><img id="shot" alt="live browser" draggable="false" /></div>
<div class="row"><input id="task" placeholder='What should Nalu do?  e.g. "go to gmail.com and open my inbox"' />
<button id="runbtn" class="primary" onclick="run()">Run</button></div>
<div id="log" class="log" style="display:none"></div>
<script>
var screen=document.getElementById('screen'),shot=document.getElementById('shot'),
badge=document.getElementById('badge'),log=document.getElementById('log'),running=false;
function refresh(){shot.src='/screenshot?t='+Date.now();}
function burst(){var n=0,id=setInterval(function(){refresh();if(++n>=4)clearInterval(id);},170);}
function post(p,b){return fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
async function health(){try{var r=await fetch('/health',{cache:'no-store'});if(r.ok){badge.textContent='connected';badge.className='badge ok';}else throw 0;}
catch(e){badge.textContent='disconnected';badge.className='badge';}}
health();setInterval(health,4000);refresh();setInterval(refresh,800);
async function go(){var v=document.getElementById('addr').value.trim();if(!v)return;await post('/goto',{url:v});burst();}
document.getElementById('addr').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
async function run(){var t=document.getElementById('task').value.trim();if(!t||running)return;
running=true;var btn=document.getElementById('runbtn');btn.disabled=true;showLog('Nalu is working&hellip;',[]);
try{var r=await fetch('/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:t})});
var d=await r.json();showLog(d.result||'Done.',d.steps||[]);}catch(e){showLog('Error: '+e,[]);}
running=false;btn.disabled=false;burst();}
document.getElementById('task').addEventListener('keydown',function(e){if(e.key==='Enter')run();});
var qtask=new URLSearchParams(location.search).get('task');
if(qtask){document.getElementById('task').value=qtask;setTimeout(run,900);}
function showLog(res,steps){log.style.display='block';var h='<div class="res">'+esc(res)+'</div>';
for(var i=0;i<steps.length;i++){h+='<div>'+(i+1)+'. '+esc(String(steps[i]))+'</div>';}log.innerHTML=h;}
shot.addEventListener('click',function(e){var r=shot.getBoundingClientRect();
post('/click',{xr:(e.clientX-r.left)/r.width,yr:(e.clientY-r.top)/r.height}).then(burst);screen.focus();});
var SPECIAL={Enter:1,Backspace:1,Tab:1,Delete:1,Escape:1,ArrowLeft:1,ArrowRight:1,ArrowUp:1,ArrowDown:1,Home:1,End:1,PageUp:1,PageDown:1};
screen.addEventListener('keydown',function(e){if(e.metaKey||e.ctrlKey||e.altKey)return;e.preventDefault();
if(e.key.length===1)post('/type',{text:e.key}).then(burst);else if(SPECIAL[e.key])post('/key',{key:e.key}).then(burst);});
screen.addEventListener('wheel',function(e){post('/scroll',{dy:e.deltaY});},{passive:true});
</script></body></html>"""


@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse(INDEX_HTML)


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/screenshot")
async def screenshot():
    page = S.get("page")
    if not page:
        return Response(status_code=503)
    try:
        png = await page.screenshot(type="png")
        return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})
    except Exception as e:
        print("screenshot error:", repr(e))
        return Response(status_code=503)


class GotoReq(BaseModel):
    url: str


@app.post("/goto")
async def goto(req: GotoReq):
    page = S["page"]
    await page.goto(req.url if "://" in req.url else "https://" + req.url, wait_until="domcontentloaded")
    return {"ok": True}


# --- Direct interaction (you click/type on the embedded screen in n4lu.ai) ----
# Coords are normalized 0..1 over the viewport so they survive any display scale.
class ClickReq(BaseModel):
    xr: float
    yr: float


@app.post("/click")
async def click(req: ClickReq):
    page = S["page"]
    vp = page.viewport_size or {"width": 1280, "height": 820}
    await page.mouse.click(max(0.0, min(1.0, req.xr)) * vp["width"], max(0.0, min(1.0, req.yr)) * vp["height"])
    return {"ok": True}


class TypeReq(BaseModel):
    text: str


@app.post("/type")
async def type_text(req: TypeReq):
    await S["page"].keyboard.type(req.text, delay=8)
    return {"ok": True}


class KeyReq(BaseModel):
    key: str


@app.post("/key")
async def key(req: KeyReq):
    await S["page"].keyboard.press(req.key)
    return {"ok": True}


class ScrollReq(BaseModel):
    dy: float


@app.post("/scroll")
async def scroll(req: ScrollReq):
    await S["page"].mouse.wheel(0, req.dy)
    return {"ok": True}


class RunReq(BaseModel):
    task: str


async def next_action(task: str, info: dict, history: list) -> dict:
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            f"{AGENT_URL}/api/web",
            json={"action": "agent", "task": task, "url": info.get("url"), "title": info.get("title"), "elements": info.get("elements"), "history": history},
        )
        return r.json()


@app.post("/run")
async def run(req: RunReq):
    lock = S["lock"]
    if lock.locked():
        return {"result": "Already working on a task — wait for it to finish.", "steps": []}
    async with lock:
        page = S["page"]
        history: list = []
        steps: list = []
        result = ""
        for _ in range(MAX_STEPS):
            await asyncio.sleep(1.1)
            try:
                info = json.loads(await page.evaluate(EXTRACT_JS))
            except Exception:
                await asyncio.sleep(0.6)
                continue
            try:
                a = await next_action(req.task, info, history)
            except Exception as e:
                result = f"brain error: {e}"
                break
            act = a.get("action")
            parts = [str(act)]
            if a.get("index") is not None:
                parts.append("#" + str(a.get("index")))
            if a.get("url"):
                parts.append(str(a["url"]))
            if a.get("text"):
                parts.append('"' + str(a["text"]) + '"')
            label = " ".join(parts) + " — " + str(a.get("reason", ""))
            history.append(label)
            steps.append(label)
            try:
                if act == "done":
                    result = a.get("reason", "Done.")
                    break
                elif act == "navigate" and a.get("url"):
                    u = a["url"]
                    await page.goto(u if "://" in u else "https://" + u, wait_until="domcontentloaded")
                elif act == "click" and a.get("index") is not None:
                    await page.click(f'[data-nalu-idx="{a["index"]}"]', timeout=8000)
                elif act == "type" and a.get("index") is not None:
                    await page.fill(f'[data-nalu-idx="{a["index"]}"]', a.get("text", ""), timeout=8000)
                elif act == "scroll":
                    await page.evaluate("window.scrollBy(0, innerHeight*0.8)")
            except Exception as e:
                history.append(f"(action failed: {e})")
        return {"result": result, "steps": steps[-25:], "url": page.url}


HTTPS_PORT = int(os.environ.get("NALU_BROWSER_HTTPS_PORT", "8701"))
CERT = os.path.join(PROFILE, "cert.pem")
KEY = os.path.join(PROFILE, "key.pem")


def ensure_cert():
    """Return (cert, key) for a browser-TRUSTED localhost cert, or None.

    A trusted https://localhost is the only way an HTTPS site (n4lu.ai) can embed
    this local browser inline in EVERY browser incl. Safari (which blocks all
    http://localhost subresources). We use mkcert: the user runs `mkcert -install`
    once (trusts a local CA in the system + browsers); we then mint the leaf cert.
    """
    if os.path.exists(CERT) and os.path.exists(KEY):
        return CERT, KEY
    mk = shutil.which("mkcert")
    if not mk:
        return None
    os.makedirs(PROFILE, exist_ok=True)
    try:
        subprocess.run(
            [mk, "-cert-file", CERT, "-key-file", KEY, "localhost", "127.0.0.1", "::1"],
            check=True, capture_output=True, text=True,
        )
        return (CERT, KEY) if os.path.exists(CERT) and os.path.exists(KEY) else None
    except Exception as e:
        print(f"!! mkcert could not mint a cert ({e}). Run `mkcert -install` first.")
        return None


if __name__ == "__main__":
    cert = ensure_cert()
    if cert:
        print(f">> Nalu Browser on https://localhost:{HTTPS_PORT}  — embeds inline in n4lu.ai in EVERY browser (incl. Safari)")
        uvicorn.run(app, host="127.0.0.1", port=HTTPS_PORT, ssl_certfile=cert[0], ssl_keyfile=cert[1])
    else:
        print("!! No trusted localhost certificate yet. To embed inline in Safari, run ONCE:")
        print("     brew install mkcert nss && mkcert -install")
        print(f"   then restart. Falling back to HTTP on :{PORT} (inline works only in Chrome/Firefox).")
        uvicorn.run(app, host="127.0.0.1", port=PORT)
