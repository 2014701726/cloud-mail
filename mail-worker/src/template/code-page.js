export default String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>最新验证码</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#17212e;font:16px system-ui,sans-serif}
main{max-width:560px;margin:40px auto;padding:0 16px}h1{font-size:23px;margin:0 0 8px}p,time{color:#64748b;font-size:14px}
article{display:flex;align-items:center;justify-content:space-between;gap:12px;background:white;border:1px solid #e2e8f0;border-radius:12px;padding:18px;margin:12px 0}
strong{display:block;font:700 28px ui-monospace,monospace;letter-spacing:2px;margin-bottom:8px}time{display:block}
button{border:0;border-radius:8px;padding:12px 18px;background:#2563eb;color:white;font:inherit;cursor:pointer}
#notice{min-height:22px}button:focus-visible{outline:3px solid #93c5fd;outline-offset:3px}
@media(max-width:400px){main{margin-top:24px}article{padding:14px}strong{font-size:25px}button{padding:12px}}
</style></head><body><main><h1>最新验证码</h1><p>5 分钟内 · 最多 5 条</p><p id="notice" role="status"></p><section id="messages" aria-label="验证码列表"></section></main>
<script>
'use strict';
const query = new URLSearchParams(location.search);
const list = document.getElementById('messages');
const notice = document.getElementById('notice');
let items = [], serverTime = Date.now(), tick = performance.now(), signature = '', loading = false;
async function copy(code, button) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(code);
    else {
      const input = document.createElement('textarea'); input.value = code;
      input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input);
      let ok; try { input.select(); ok = document.execCommand('copy'); } finally { input.remove(); }
      if (!ok) throw new Error('copy');
    }
    button.textContent = '已复制'; setTimeout(() => button.textContent = '复制', 1500);
  } catch { notice.textContent = '复制失败，请长按验证码手动复制'; }
}
function render() {
  const now = serverTime + performance.now() - tick;
  const active = items.filter(item => Date.parse(item.expires_at) > now);
  const next = JSON.stringify(active); if (signature === next) return; signature = next;
  list.replaceChildren();
  if (!active.length) { const p = document.createElement('p'); p.textContent = '暂无验证码'; list.append(p); }
  for (const item of active) {
    const row = document.createElement('article'), text = document.createElement('div');
    const code = document.createElement('strong'), time = document.createElement('time'), button = document.createElement('button');
    code.textContent = item.code; time.dateTime = item.received_at;
    time.textContent = new Date(item.received_at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false});
    button.textContent = '复制'; button.setAttribute('aria-label', '复制验证码'); button.onclick = () => copy(item.code, button);
    text.append(code, time); row.append(text, button); list.append(row);
  }
}
async function refresh() {
  if (loading || document.hidden) return;
  if (!query.get('recipient')) { notice.textContent = '请在链接中添加 ?recipient=邮箱前缀'; render(); return; }
  loading = true; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/api/codes?' + query.toString(), {cache:'no-store',signal:controller.signal});
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '读取失败');
    items = data.messages; serverTime = Date.parse(data.server_time); tick = performance.now(); notice.textContent = ''; render();
  } catch(error) { notice.textContent = error.name === 'AbortError' ? '连接超时，正在重试' : error.message; }
  finally { clearTimeout(timer); loading = false; }
}
refresh(); setInterval(render, 1000); setInterval(refresh, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
</script></body></html>`;
