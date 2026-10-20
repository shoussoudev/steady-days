"""Build the Steady Days web app (GitHub Pages) from src/steady-days.html.
The same source is also published as the Claude artifact; here we add the Firebase shim, sign-in gate and PWA bits."""
import shutil,time,pathlib
root=pathlib.Path(__file__).resolve().parent.parent
src=(root/"src/steady-days.html").read_text()
# In the app, tasks live in Steady Days itself, so drop "TickTick" from user-facing wording.
WORDING=[("Progress logged and added to TickTick","Progress logged"),("Added to TickTick","Added"),("Moved in TickTick","Moved"),
  ("” in TickTick`","”`"),('<span class="eyebrow">From TickTick</span>','<span class="eyebrow">Your tasks</span>'),
  ("Nothing due today in TickTick.","Nothing due today."),("moves it to tomorrow in TickTick.","moves it to tomorrow."),
  ("Loading your TickTick lists…","Loading your lists…"),("Pick which TickTick lists count","Pick which lists count"),
  ("Which TickTick lists to use","Which lists to use"),('<optgroup label="TickTick">','<optgroup label="Lists">'),
  ("Couldn't reach TickTick","Couldn't load your tasks"),("Choose your TickTick","Choose your"),
  ("TickTick returned an error: ","Something went wrong: "),("TickTick refused that change: ","That change didn't go through: "),
  ("Loading TickTick…","Loading your tasks…"),("TickTick unavailable","Tasks unavailable"),
  ("Notes are saved here and added as a comment on the task in TickTick.","Notes are saved with the project.")]
for a,b in WORDING:
    n=src.count(a)
    if not n:raise SystemExit("wording not found: "+a)
    src=src.replace(a,b)
stamp=time.strftime("%Y%m%d%H%M%S")
head='''<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#2F5A44">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<script src="shim.js?v=%s"></script>
<script type="module" src="boot.js?v=%s"></script>
<style>
#sd-gate{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:24px;background:var(--bg,#EEF1EA)}
#sd-gate[hidden]{display:none}
#sd-gate .box{max-width:340px;text-align:center;display:grid;gap:14px;justify-items:center}
#sd-gate img{width:72px;height:72px;border-radius:18px}
#sd-gate h1{margin:0;font-family:var(--f-display,system-ui);font-size:1.8rem;color:var(--ink,#1B2A21)}
#sd-gate p{margin:0;color:var(--muted,#5B6A5F)}
#sd-signin{font:inherit;font-weight:600;background:var(--accent,#2F5A44);color:var(--accent-ink,#F3F8F3);border:0;border-radius:12px;padding:12px 20px;cursor:pointer}
#sd-gate.opening .when-out{visibility:hidden}
</style>
</head><body>
''' % (stamp,stamp)
gate='''
<div id="sd-gate" class="opening"><div class="box"><img src="icons/icon-192.png" alt=""><h1>Steady Days</h1><p class="when-out">A calm place for your day. Sign in to open your journal.</p>
<button type="button" id="sd-signin" class="when-out">Sign in with Google</button><p id="sd-gate-msg" class="small" role="status"></p></div></div>
<script>/* if the sign-in code can't load at all (e.g. first visit offline), say so instead of waiting forever */
setTimeout(function(){var g=document.getElementById("sd-gate");if(g&&g.classList.contains("opening")){g.classList.remove("opening");var m=document.getElementById("sd-gate-msg");if(m)m.textContent="Still opening… If this stays, check your connection and reload."}},12000);</script>
</body></html>
'''
(root/"index.html").write_text(head+gate.replace("</body></html>","")+src+"\n</body></html>\n")
for f in ["shim.js","boot.js","tasks.js","manifest.webmanifest"]:shutil.copy(root/"web"/f,root/f)
(root/"sw.js").write_text((root/"web/sw.js").read_text().replace("__BUILD__",stamp))
(root/".nojekyll").write_text("")
print("built",stamp)
