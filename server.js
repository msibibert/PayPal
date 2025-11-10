import express from 'express';
import fetch from 'node-fetch';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Глобально выключим кеш на время отладки (можно потом убрать)
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ==== ENV ====
const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT;   // Sandbox client-id
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;   // Sandbox secret
const BASE_URL      = process.env.BASE_URL;        // https://<your-app>.onrender.com
const SCHEME        = process.env.SCHEME || 'screwfixapp';
const REDIRECT_PATH = process.env.REDIRECT_PATH || 'order-confirmation';
const PAYPAL_BASE   = 'https://api-m.sandbox.paypal.com';

const APP_LINK_BASE = `${SCHEME}://${REDIRECT_PATH}`; // screwfixapp://order-confirmation
// =============

async function getAccessToken() {
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`oauth2/token ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

// Создать ордер → вернуть approvalUrl и orderId
// ?mode=bug|fix пробрасываем в return_url, чтобы можно было включать/выключать обходы
app.post('/create-order', async (req, res) => {
  try {
    const mode = (req.query.mode === 'fix') ? 'fix' : 'bug';
    const accessToken = await getAccessToken();

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' } }],
        application_context: {
          return_url: `${BASE_URL}/return?mode=${mode}`,
          cancel_url: `${BASE_URL}/return?mode=${mode}`
        }
      })
    });

    const order = await r.json();
    const approve = (order.links || []).find(l => l.rel === 'approve');
    res.json({ approvalUrl: approve?.href, orderId: order.id, order });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// /return — только отдаём страницу (в ней postMessage+close, без авто-диплинков)
app.get('/return', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'modal_host.html'));
});

// Страницы
app.get('/popup_modal.html', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'popup_modal.html'))
);
app.get('/topframe.html', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'topframe.html'))
);

app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, now: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('listening on ' + PORT));