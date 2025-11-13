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

// Prevent aggressive caching in iOS sheets
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

// Server-side CAPTURE (recommended by PayPal)
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

// BUG: deeplink from iframe (not top frame) -> often ignored by iOS
app.get('/inline-bug', (req, res) => {
  res.type('html').send(`<!doctype html><html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Inline BUG – deeplink from iframe (not top)</title>
  <style>
    body{font-family:-apple-system,system-ui,Arial;padding:24px;max-width:620px;margin:0 auto}
    #log{white-space:pre-wrap;background:#f6f6f6;border-radius:8px;padding:12px}
  </style>
  <script src="https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(PAYPAL_CLIENT)}&currency=GBP&intent=capture&components=buttons"></script>
  </head><body>
    <h2>BUG: deeplink from iframe (not top)</h2>
    <p>After capture, the page tries to open the deeplink inside an iframe. iOS often ignores this.</p>
    <div id="paypal-buttons"></div>
    <pre id="log"></pre>
    <iframe id="inner" style="display:none"></iframe>
    <script>
      const log = m => document.getElementById('log').textContent += m + '\\n';
      const APP = '${APP_LINK_BASE}';
      paypal.Buttons({
        createOrder: (data, actions) => actions.order.create({
          purchase_units:[{ amount:{ currency_code:'GBP', value:'1.00' } }]
        }),
        onApprove: async (data) => {
          const r = await fetch('/capture-order', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({orderID:data.orderID})
          });
          const j = await r.json();
          if (!r.ok) {
            log('capture failed ' + JSON.stringify(j));
            return;
          }
          const deeplink = APP + '?id=' + encodeURIComponent(data.orderID);
          log('[BUG] window.top===window? ' + (window.top === window));
          log('[BUG] trying deeplink INSIDE iframe -> ' + deeplink);
          const f = document.getElementById('inner');
          try { f.contentWindow.location.href = deeplink; } catch(e) {}
          // Result: on iOS, SFSafariVC usually stays open (white / stuck).
        },
        onError: e => log('onError ' + (e?.message || e))
      }).render('#paypal-buttons');
    </script>
  </body></html>`);
});

// FIX 1: deeplink from TOP frame (no HTTP bounce)
app.get('/inline-fix-top', (req, res) => {
  const clientId = encodeURIComponent(PAYPAL_CLIENT || '');
  const scheme   = SCHEME;
  const path     = REDIRECT_PATH;

  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Inline FIX (TOP frame deeplink)</title>
  <style>
    body{font-family:-apple-system,system-ui,Arial;padding:24px;max-width:700px;margin:0 auto}
    #log{white-space:pre-wrap;background:#f6f6f6;border-radius:8px;padding:12px}
    #overlay{position:fixed;inset:0;background:#fff;display:none;align-items:center;justify-content:center;flex-direction:column;z-index:9999}
    .spinner{width:48px;height:48px;border:4px solid #e5e7eb;border-top-color:#2563eb;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:12px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .btn{background:#2563eb;color:#fff;border:0;padding:10px 16px;border-radius:8px;cursor:pointer}
    .muted{color:#6b7280;font-size:14px;margin-top:8px;text-align:center;max-width:320px}
  </style>
  <script src="https://www.paypal.com/sdk/js?client-id=${clientId}&currency=GBP&intent=capture&components=buttons"></script>
</head>
<body>
  <h2>Inline FIX — deeplink from TOP frame</h2>
  <p>After successful capture we navigate to the app deeplink from the top frame.</p>

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
    const overlay = document.getElementById('overlay');
    const status  = document.getElementById('status');
    const btn     = document.getElementById('manual');

    const APP_SCHEME = '${scheme}://${path}';

    function tryDeepLinkTop(deeplink){
      log('[DL TOP] window.top===window? ' + (window.top === window) + ' | ' + deeplink);

      // Attempt 1: replace (no back)
      try {
        window.top.location.replace(deeplink);
        log('[DL TOP] replace() issued');
      } catch(e){}

      // Attempt 2: assign
      setTimeout(() => {
        try { window.top.location.href = deeplink; log('[DL TOP] href set'); } catch(e){}
      }, 100);

      // Attempt 3: synthetic anchor click
      setTimeout(() => {
        try {
          const a = document.createElement('a');
          a.href = deeplink;
          a.rel = 'noopener';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          log('[DL TOP] anchor.click() fired');
        } catch(e){}
      }, 200);

      // If still here after ~1s, show manual button
      setTimeout(() => {
        btn.style.display = 'inline-block';
      }, 1000);
    }

    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const deeplink = APP_SCHEME + '?id=' + encodeURIComponent(id || '');
      status.textContent = 'Opening app…';
      tryDeepLinkTop(deeplink);
    });

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

        overlay.style.display = 'flex';
        btn.setAttribute('data-id', data.orderID);

        const deeplink = APP_SCHEME + '?id=' + encodeURIComponent(data.orderID);
        status.textContent = 'Returning to app…';
        tryDeepLinkTop(deeplink);
      },
      onError: (err) => log('onError: ' + (err?.message || String(err))),
      onCancel: () => log('onCancel')
    }).render('#paypal-buttons');
  </script>
</body>
</html>`);
});

// FIX 2: deeplink via HTTPS 302 bounce (/dl)
app.get('/inline-fix-302', (req, res) => {
  const clientId = encodeURIComponent(PAYPAL_CLIENT || '');
  const scheme   = SCHEME;
  const path     = REDIRECT_PATH;

  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Inline FIX (HTTPS 302 bounce)</title>
  <style>
    body{font-family:-apple-system,system-ui,Arial;padding:24px;max-width:700px;margin:0 auto}
    #log{white-space:pre-wrap;background:#f6f6f6;border-radius:8px;padding:12px}
    #overlay{position:fixed;inset:0;background:#fff;display:none;align-items:center;justify-content:center;flex-direction:column;z-index:9999}
    .spinner{width:48px;height:48px;border:4px solid #e5e7eb;border-top-color:#2563eb;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:12px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .btn{background:#2563eb;color:#fff;border:0;padding:10px 16px;border-radius:8px;cursor:pointer}
    .muted{color:#6b7280;font-size:14px;margin-top:8px;text-align:center;max-width:320px}
  </style>
  <script src="https://www.paypal.com/sdk/js?client-id=${clientId}&currency=GBP&intent=capture&components=buttons"></script>
</head>
<body>
  <h2>Inline FIX — HTTPS 302 bounce</h2>
  <p>After capture we navigate to a HTTPS URL on this domain (<code>/dl</code>) which immediately returns a 302 redirect to the custom scheme.</p>

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
    const overlay = document.getElementById('overlay');
    const status  = document.getElementById('status');
    const btn     = document.getElementById('manual');

    const APP_SCHEME = '${scheme}://${path}';

    function tryDeepLinkBounce(orderId){
      const deeplink = APP_SCHEME + '?id=' + encodeURIComponent(orderId);
      const bounce   = '/dl?id=' + encodeURIComponent(orderId);
      log('[DL 302] deeplink=' + deeplink);
      log('[DL 302] bounce  = ' + bounce);

      // Navigate to HTTPS endpoint on same origin, which 302-redirects to the scheme
      try {
        window.top.location.href = bounce;
        log('[DL 302] window.top.location.href = ' + bounce);
      } catch (e) {
        log('[DL 302] error: ' + e.message);
      }

      // Show manual button as fallback
      setTimeout(() => {
        btn.style.display = 'inline-block';
      }, 1000);
    }

    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      tryDeepLinkBounce(id || '');
    });

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

        overlay.style.display = 'flex';
        btn.setAttribute('data-id', data.orderID);
        status.textContent = 'Returning to app…';

        tryDeepLinkBounce(data.orderID);
      },
      onError: (err) => log('onError: ' + (err?.message || String(err))),
      onCancel: () => log('onCancel')
    }).render('#paypal-buttons');
  </script>
</body>
</html>`);
});

// HTTPS-bounce: /dl?id=... -> 302 -> screwfixapp://order-confirmation?id=..
app.get('/dl', (req, res) => {
  const id    = req.query.id || '';
  const scheme = SCHEME;
  const path   = REDIRECT_PATH;
  const target = `${scheme}://${path}?id=${encodeURIComponent(id)}`;
  res.set('Cache-Control', 'no-store');
  res.redirect(302, target);
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