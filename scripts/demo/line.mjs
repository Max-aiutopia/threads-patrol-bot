// node line.mjs <text|image|postback|follow|sticker> [payload] [--old] [--user U_x]
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const info = JSON.parse(fs.readFileSync(path.join(DIR, '..', '..', '.demo', 'info.json'), 'utf8'));
const [kind, payload] = process.argv.slice(2);
const old = process.argv.includes('--old');
const ui = process.argv.indexOf('--user'); const userId = ui > 0 ? process.argv[ui + 1] : 'U_admin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = async () => (await (await fetch(`${info.mock}/__calls`)).json()).calls;
const before = await calls(); const seq0 = before.length ? before[before.length - 1].seq : 0;
const tag = randomBytes(6).toString('hex');
const ev = { type: kind === 'text' || kind === 'image' || kind === 'sticker' ? 'message' : kind, mode: 'active', timestamp: Date.now() - (old ? 60_000 : 0), source: { type: 'user', userId }, webhookEventId: '01RV' + tag.toUpperCase(), deliveryContext: { isRedelivery: false }, replyToken: 'rt' + tag };
if (kind === 'text') ev.message = { id: '9' + Date.now(), type: 'text', text: payload };
if (kind === 'image') ev.message = { id: '8' + Date.now(), type: 'image', contentProvider: { type: 'line' } };
if (kind === 'sticker') ev.message = { id: '7' + Date.now(), type: 'sticker', packageId: '1', stickerId: '1' };
if (kind === 'postback') ev.postback = { data: payload };
const body = JSON.stringify({ destination: 'Ubot', events: [ev] });
const sig = createHmac('sha256', info.secrets.LINE_CHANNEL_SECRET).update(body).digest('base64');
const r = await fetch(`${info.base}/line/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': sig }, body });
console.log('webhook', r.status);
const t0 = Date.now();
let got = null;
while (Date.now() - t0 < 30000) {
  const cs = (await calls()).filter((c) => c.seq > seq0);
  got = cs.find((c) => c.service === 'line' && (c.path === '/v2/bot/message/reply' || c.path === '/v2/bot/message/push'));
  if (got && Date.now() - t0 > 1500) break;
  await sleep(300);
}
const cs = (await calls()).filter((c) => c.seq > seq0);
for (const c of cs) {
  if (c.service === 'line' && /reply|push/.test(c.path)) {
    console.log(`--- ${c.path} status ${c.status} ${c.headers['x-line-retry-key'] ? 'retry-key' : ''}`);
    for (const m of c.body.messages || []) printMsg(m);
  } else console.log(`(${c.service} ${c.method} ${c.path} ${c.status}${c.mode ? ' mode=' + c.mode : ''})`);
}
if (process.argv.includes('--json')) fs.writeFileSync(path.join(DIR, 'last.json'), JSON.stringify(cs, null, 2));
function printMsg(m) {
  if (m.type === 'text') { console.log('[TEXT]\n' + m.text); if (m.quickReply) console.log('  QR:', m.quickReply.items.map((i) => i.action.label).join(' / ')); return; }
  if (m.type === 'flex') {
    console.log(`[FLEX] altText="${m.altText}"`);
    const bubbles = m.contents.type === 'carousel' ? m.contents.contents : [m.contents];
    bubbles.forEach((b, i) => {
      const texts = []; const btns = [];
      const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (n.type === 'text') texts.push(n.text); if (n.type === 'button') btns.push(`${n.action.label} <${n.action.type}${n.action.uri ? ' ' + n.action.uri : ''}${n.action.data ? ' ' + n.action.data : ''}${n.action.displayText ? ' dt=' + n.action.displayText : ''}>`); Object.values(n).forEach(walk); };
      walk(b.header); walk(b.body); walk(b.footer);
      console.log(`  bubble ${i + 1}: ${texts.join(' | ')}`);
      for (const bt of btns) console.log(`     btn: ${bt}`);
    });
    if (m.quickReply) console.log('  QR:', m.quickReply.items.map((i) => i.action.label).join(' / '));
    return;
  }
  console.log(JSON.stringify(m).slice(0, 400));
}
