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
  const CLIENT = encodeURIComponent(process.env.PAYPAL_CLIENT || '');
  const SCHEME = process.env.SCHEME || 'screwfixapp';
  const PATH   = process.env.REDIRECT_PATH || 'order-confirmation';
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Inline FIX – deep link from TOP frame (with robust fallbacks)</title>
  <style>
    body{font-family:-apple-system,system-ui,Arial;padding:24px;max-width:700px;margin:0 auto}
    #log{white-space:pre-wrap;background:#f6f6f6;border-radius:8px;padding:12px}
    #overlay{position:fixed;inset:0;background:#fff;display:none;align-items:center;justify-content:center;flex-direction:column;z-index:9999}
    .spinner{width:48px;height:48px;border:4px solid #e5e7eb;border-top-color:#2563eb;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:12px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .btn{background:#2563eb;color:#fff;border:0;padding:10px 16px;border-radius:8px;cursor:pointer}
    .muted{color:#6b7280;font-size:14px;margin-top:8px;text-align:center;max-width:320px}
  </style>
  <script src="https://www.paypal.com/sdk/js?client-id=${CLIENT}&currency=GBP&intent=capture&components=buttons"></script>
</head>
<body>
  <h2>Inline FIX — top-frame deep link (with fallbacks)</h2>
  <p>После успешного capture мы пытаемся открыть диплинк из верхнего окна несколькими способами, 
  плюс есть кнопка на случай, если iOS потребует явный жест.</p>

  <div id="paypal-buttons"></div>
  <pre id="log"></pre>

  <div id="overlay">
    <div class="spinner"></div>
    <div id="status">Processing… returning to app</div>
    <button id="manual" class="btn" style="margin-top:14px;display:none">Open in app</button>
    <div class="muted">If it doesn't switch automatically, tap the button.</div>
  </div>

  <script>
    const log   = m => document.getElementById('log').textContent += m + '\\n';
    const show  = id => (document.getElementById(id).style.display = 'block');
    const hide  = id => (document.getElementById(id).style.display = 'none');
    const overlay = document.getElementById('overlay');
    const status  = document.getElementById('status');
    const btn     = document.getElementById('manual');

    const APP_SCHEME = '${SCHEME}://${PATH}';

    function tryDeepLink(deeplink){
      log('[DL] top? ' + (window.top === window) + ' | ' + deeplink);

      // Attempt 1: top frame replace (prevents back)
      try {
        window.top.location.replace(deeplink);
        log('[DL] replace() issued');
      } catch(e){}

      // Attempt 2: assign (some iOS versions react to this)
      setTimeout(() => {
        try { window.top.location.href = deeplink; log('[DL] href= set'); } catch(e){}
      }, 100);

      // Attempt 3: synthetic click (some contexts require a "gesture-like" event)
      setTimeout(() => {
        try {
          const a = document.createElement('a');
          a.href = deeplink;
          a.rel = 'noopener';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          log('[DL] anchor.click() fired');
        } catch(e){}
      }, 200);

      // Attempt 4: HTTPS bounce (SFSafariVC sometimes likes http(s) -> 302 -> scheme)
      setTimeout(() => {
        const bounce = '/dl?id=' + encodeURIComponent(new URL(deeplink).searchParams.get('id') || '');
        try { window.top.location.href = bounce; log('[DL] https-bounce -> ' + bounce); } catch(e){}
      }, 400);

      // If none fired (still on page after ~1s), show button (user gesture)
      setTimeout(() => {
        btn.style.display = 'inline-block';
      }, 1000);
    }

    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const deeplink = APP_SCHEME + '?id=' + encodeURIComponent(id || '');
      status.textContent = 'Opening app…';
      tryDeepLink(deeplink);
    });

    // Log visibility state changes (полезно понять, уходила ли страница в background)
    document.addEventListener('visibilitychange', () => {
      log('[page] visibility=' + document.visibilityState);
    });

    paypal.Buttons({
      createOrder: (data, actions) => {
        log('createOrder (client)…');
        return actions.order.create({
          intent: 'CAPTURE',
          purchase_units: [{ amount: { currency_code: 'GBP', value: '1.00' } }]
        });
      },
      onApprove: async (data, actions) => {
        log('onApprove orderID=' + data.orderID);

        const r = await fetch('/capture-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderID: data.orderID })
        });
        const j = await r.json();
        if (!r.ok) { log('capture failed: ' + JSON.stringify(j)); return; }
        log('capture OK');

        // Показать overlay и попытаться уйти по диплинку
        overlay.style.display = 'flex';
        btn.setAttribute('data-id', data.orderID);

        const deeplink = APP_SCHEME + '?id=' + encodeURIComponent(data.orderID);
        status.textContent = 'Returning to app…';
        tryDeepLink(deeplink);
      },
      onError: (err) => log('onError: ' + (err?.message || String(err))),
      onCancel: () => log('onCancel')
    }).render('#paypal-buttons');
  </script>
</body>
</html>`);
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