import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// ---- ENV ----
// PayPal sandbox app
const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT;   // required
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;   // required
// Your app deeplink: screwfixapp://order-confirmation
const SCHEME        = process.env.SCHEME || 'screwfixapp';
const REDIRECT_PATH = process.env.REDIRECT_PATH || 'order-confirmation';
const APP_LINK_BASE = `${SCHEME}://${REDIRECT_PATH}`;

const PAYPAL_BASE   = 'https://api-m.sandbox.paypal.com';

// prevent weird caching in iOS sheets
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ----- helpers -----
async function getAccessToken() {
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) {
    throw new Error(`oauth2 error ${r.status} ${await r.text()}`);
  }
  const j = await r.json();
  return j.access_token;
}

// server-side CAPTURE (recommended by PayPal docs)
app.post('/capture-order', async (req, res) => {
  try {
    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ error: 'orderID required' });

    const token = await getAccessToken();
    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: 'capture failed', details: data });

    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- Pages ----------
// --- BUG 1: диплинк НЕ из top-frame (через iframe) -> iOS игнорит ---
app.get('/inline-bug', (req, res) => {
  res.type('html').send(`<!doctype html><html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Inline BUG – deeplink from iframe (not top)</title>
  <style>
    body{font-family:-apple-system,system-ui,Arial;padding:24px;max-width:620px;margin:0 auto}
    #log{white-space:pre-wrap;background:#f6f6f6;border-radius:8px;padding:12px}
  </style>
  <script src="https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(process.env.PAYPAL_CLIENT)}&currency=GBP&intent=capture&components=buttons"></script>
  </head><body>
    <h2>BUG: deeplink from iframe (not top)</h2>
    <p>После capture вызываем диплинк ВНУТРИ iframe → SFSafariVC обычно игнорирует.</p>
    <div id="paypal-buttons"></div>
    <pre id="log"></pre>
    <iframe id="inner" style="display:none"></iframe>
    <script>
      const log = m => document.getElementById('log').textContent += m + '\\n';
      const APP = '${process.env.SCHEME || 'screwfixapp'}://${process.env.REDIRECT_PATH || 'order-confirmation'}';
      paypal.Buttons({
        createOrder: (d,a) => a.order.create({
          purchase_units:[{ amount:{ currency_code:'GBP', value:'1.00' } }]
        }),
        onApprove: async (data) => {
          const r = await fetch('/capture-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderID:data.orderID})});
          const j = await r.json(); if(!r.ok){ log('capture failed '+JSON.stringify(j)); return; }
          const deeplink = APP + '?id=' + encodeURIComponent(data.orderID);
          log('[BUG] window.top===window? '+(window.top===window));
          log('[BUG] trying deeplink INSIDE iframe -> '+deeplink);
          const f = document.getElementById('inner');
          try { f.contentWindow.location.href = deeplink; } catch(e) {}
          // Итог: на iOS лист остаётся открытым (белый/завис).
        },
        onError: e => log('onError '+(e?.message||e))
      }).render('#paypal-buttons');
    </script>
  </body></html>`);
});

// --- BUG 2: вообще без диплинка (ждут /return) -> тоже зависает ---
app.get('/inline-no-deeplink', (req, res) => {
  res.type('html').send(`<!doctype html><html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Inline BUG – no deeplink at all</title>
  <style>
    body{font-family:-apple-system,system-ui,Arial;padding:24px;max-width:620px;margin:0 auto}
    #log{white-space:pre-wrap;background:#f6f6f6;border-radius:8px;padding:12px}
    #overlay{position:fixed;inset:0;background:#fff;display:none;align-items:center;justify-content:center;z-index:9999}
    .spinner{width:48px;height:48px;border:4px solid #e5e7eb;border-top-color:#2563eb;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:12px}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
  <script src="https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(process.env.PAYPAL_CLIENT)}&currency=GBP&intent=capture&components=buttons"></script>
  </head><body>
    <h2>BUG: no deeplink</h2>
    <p>После capture просто показываем оверлей и НИЧЕГО не навигируем.</p>
    <div id="paypal-buttons"></div>
    <pre id="log"></pre>
    <div id="overlay"><div><div class="spinner"></div><div>Processing… (no return)</div></div></div>
    <script>
      const log = m => document.getElementById('log').textContent += m + '\\n';
      const overlay = document.getElementById('overlay');
      paypal.Buttons({
        createOrder:(d,a)=>a.order.create({purchase_units:[{amount:{currency_code:'GBP',value:'1.00'}}]}),
        onApprove: async (data)=>{
          const r=await fetch('/capture-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderID:data.orderID})});
          const j=await r.json(); if(!r.ok){log('capture failed '+JSON.stringify(j));return;}
          log('capture OK, but we DO NOT navigate'); overlay.style.display='flex';
        }
      }).render('#paypal-buttons');
    </script>
  </body></html>`);
});

// --- FIX: диплинк из top-frame (правильно) ---
app.get('/inline-fix', (req, res) => {
  res.type('html').send(`<!doctype html><html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Inline FIX – deeplink from TOP frame</title>
  <style>
    body{font-family:-apple-system,system-ui,Arial;padding:24px;max-width:620px;margin:0 auto}
    #log{white-space:pre-wrap;background:#f6f6f6;border-radius:8px;padding:12px}
  </style>
  <script src="https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(process.env.PAYPAL_CLIENT)}&currency=GBP&intent=capture&components=buttons"></script>
  </head><body>
    <h2>FIX: deeplink from TOP frame</h2>
    <div id="paypal-buttons"></div>
    <pre id="log"></pre>
    <script>
      const log = m => document.getElementById('log').textContent += m + '\\n';
      const APP = '${process.env.SCHEME || 'screwfixapp'}://${process.env.REDIRECT_PATH || 'order-confirmation'}';
      paypal.Buttons({
        createOrder:(d,a)=>a.order.create({purchase_units:[{amount:{currency_code:'GBP',value:'1.00'}}]}),
        onApprove: async (data)=>{
          const r=await fetch('/capture-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderID:data.orderID})});
          const j=await r.json(); if(!r.ok){log('capture failed '+JSON.stringify(j));return;}
          const deeplink = APP + '?id=' + encodeURIComponent(data.orderID);
          log('[FIX] top? '+(window.top===window)+' -> '+deeplink);
          try{ window.top.location.href = deeplink; }
          catch(e){ const a=document.createElement('a'); a.href=deeplink; document.body.appendChild(a); a.click(); }
        }
      }).render('#paypal-buttons');
    </script>
  </body></html>`);
});


// health
app.get('/health', (req, res) => res.json({ ok: true, now: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('listening on ' + PORT);
  if (!PAYPAL_CLIENT || !PAYPAL_SECRET) {
    console.warn('⚠️  Missing PAYPAL_CLIENT / PAYPAL_SECRET');
  }
});