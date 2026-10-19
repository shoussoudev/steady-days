"""Build the Steady Days web app (GitHub Pages) from src/steady-days.html.
The same source is also published as the Claude artifact; here we add the Firebase shim, sign-in gate and PWA bits."""
import shutil,time,pathlib
root=pathlib.Path(__file__).resolve().parent.parent
src=(root/"src/steady-days.html").read_text()
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
</style>
</head><body>
''' % (stamp,stamp)
gate='''
<div id="sd-gate" hidden><div class="box"><img src="icons/icon-192.png" alt=""><h1>Steady Days</h1><p>A calm place for your day. Sign in to open your journal.</p>
<button type="button" id="sd-signin">Sign in with Google</button><p id="sd-gate-msg" class="small" role="status"></p></div></div>
</body></html>
'''
(root/"index.html").write_text(head+src+gate)
for f in ["shim.js","boot.js","manifest.webmanifest"]:shutil.copy(root/"web"/f,root/f)
(root/"sw.js").write_text((root/"web/sw.js").read_text().replace("__BUILD__",stamp))
(root/".nojekyll").write_text("")
print("built",stamp)
