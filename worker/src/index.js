/**
 * Cloudflare Worker — обработчик формы лендинга
 *
 * Принимает POST с данными формы, отправляет параллельно:
 *   1. В Make.com webhook (основной путь, данные сохраняются в Google Sheets)
 *   2. В Meta CAPI (событие Lead на пиксель)
 *   3. В TikTok Events API (событие SubmitForm)
 *
 * Переменные среды (задаются через wrangler secret):
 *   MAKE_WEBHOOK_URL      — URL Make.com webhook (обязательно)
 *   FB_PIXEL_ID           — ID Meta пикселя (2160949541347107)
 *   FB_ACCESS_TOKEN       — Access Token для Meta CAPI
 *   ALLOWED_ORIGIN        — домен лендинга для CORS
 *   TIKTOK_PIXEL_ID       — ID TikTok пикселя (D7P7523C77U02PK9RRH0)
 *   TIKTOK_ACCESS_TOKEN   — Access Token для TikTok Events API
 */

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    let data;
    try {
      data = await request.json();
    } catch (e) {
      return json({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    const { name, age, phone, telegram, readiness } = data;
    if (!name || !phone || !telegram || !readiness) {
      return json({ error: 'Missing required fields' }, 400, corsHeaders);
    }

    if (name.length > 100 || age < 16 || age > 99) {
      return json({ error: 'Validation failed' }, 400, corsHeaders);
    }

    const phoneE164 = normalizePhone(phone);

    const enriched = {
      ...data,
      phone_e164: phoneE164,
      received_at: new Date().toISOString(),
      ip: request.headers.get('CF-Connecting-IP'),
      country: request.headers.get('CF-IPCountry'),
      user_agent_server: request.headers.get('User-Agent'),
    };

    // Параллельная отправка во все 3 системы
    const [makeRes, capiRes, tiktokRes] = await Promise.allSettled([
      env.MAKE_WEBHOOK_URL
        ? sendToMake(env.MAKE_WEBHOOK_URL, enriched)
        : Promise.resolve(null),
      env.FB_PIXEL_ID && env.FB_ACCESS_TOKEN
        ? sendToCAPI(env, enriched, request)
        : Promise.resolve(null),
      env.TIKTOK_PIXEL_ID && env.TIKTOK_ACCESS_TOKEN
        ? sendToTikTok(env, enriched, request)
        : Promise.resolve(null),
    ]);

    console.log('Make:', makeRes.status, makeRes.reason?.message || 'ok');
    console.log('Meta CAPI:', capiRes.status, capiRes.reason?.message || 'ok');
    console.log('TikTok EAPI:', tiktokRes.status, tiktokRes.reason?.message || 'ok');

    if (makeRes.status === 'rejected') {
      return json({ error: 'Failed to save lead' }, 500, corsHeaders);
    }

    return json({ success: true }, 200, corsHeaders);
  },
};

// ========================================
// HELPERS
// ========================================

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function normalizePhone(phone) {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('380') && digits.length === 12) return '+' + digits;
  if (digits.startsWith('80') && digits.length === 11) return '+3' + digits;
  if (digits.length === 10 && digits.startsWith('0')) return '+38' + digits;
  if (digits.length === 9) return '+380' + digits;
  return '+' + digits;
}

async function sendToMake(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Make ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

async function sendToCAPI(env, data, request) {
  const phoneDigits = data.phone_e164.replace(/\D/g, '');
  const phoneHash = await sha256(phoneDigits);
  const nameHash = data.name ? await sha256(data.name.toLowerCase().trim()) : null;
  const countryHash = await sha256('ua');
  const externalIdHash = data.external_id ? await sha256(data.external_id) : null;

  const userData = {
    ph: [phoneHash],
    country: [countryHash],
    client_ip_address: request.headers.get('CF-Connecting-IP'),
    client_user_agent: data.user_agent || request.headers.get('User-Agent'),
  };

  if (nameHash) userData.fn = [nameHash];
  if (externalIdHash) userData.external_id = [externalIdHash];
  if (data.fbp) userData.fbp = data.fbp;

  if (data.fbc) {
    userData.fbc = data.fbc;
  } else if (data.url) {
    try {
      const urlObj = new URL(data.url);
      const fbclid = urlObj.searchParams.get('fbclid');
      if (fbclid) userData.fbc = `fb.1.${data.timestamp * 1000}.${fbclid}`;
    } catch(e) {}
  }

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: data.timestamp || Math.floor(Date.now() / 1000),
      event_source_url: data.url,
      action_source: 'website',
      event_id: data.event_id || `lead_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      user_data: userData,
      custom_data: {
        content_name: 'Chat Manager Kyiv',
        content_category: 'HR Lead',
        readiness: data.readiness,
      },
    }],
  };

  const url = `https://graph.facebook.com/v19.0/${env.FB_PIXEL_ID}/events?access_token=${env.FB_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meta CAPI ${res.status}: ${text.slice(0, 200)}`);
  }

  const resData = await res.json();
  console.log('Meta CAPI response:', JSON.stringify(resData));
  return resData;
}

async function sendToTikTok(env, data, request) {
  // Хешируем PII по правилам TikTok (SHA-256, lowercase, trimmed)
  const phoneDigits = data.phone_e164.replace(/\D/g, '');
  const phoneHash = await sha256(phoneDigits);
  const externalIdHash = data.external_id ? await sha256(data.external_id) : null;

  const ip = request.headers.get('CF-Connecting-IP');
  const userAgent = data.user_agent || request.headers.get('User-Agent');

  // ttclid — TikTok click ID (аналог fbclid у Meta)
  // Появляется в URL когда человек кликает на TikTok рекламу: ?ttclid=...
  let ttclid = null;
  if (data.url) {
    try {
      const urlObj = new URL(data.url);
      ttclid = urlObj.searchParams.get('ttclid');
    } catch(e) {}
  }

  const userData = {
    phone_numbers: [phoneHash],
    ip,
    user_agent: userAgent,
  };

  if (externalIdHash) userData.external_id = externalIdHash;
  if (ttclid) userData.ttclid = ttclid;

  const payload = {
    pixel_code: env.TIKTOK_PIXEL_ID,
    event_source: 'web',
    data: [{
      event: 'SubmitForm',
      event_time: data.timestamp || Math.floor(Date.now() / 1000),
      event_id: data.event_id || `tiktok_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      user: userData,
      page: {
        url: data.url || '',
        referrer: data.referrer || '',
      },
      properties: {
        currency: 'USD',
        value: 4.0,
        content_name: 'Chat Manager Kyiv',
        content_category: 'HR Lead',
      },
    }],
  };

  const res = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Access-Token': env.TIKTOK_ACCESS_TOKEN,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok EAPI ${res.status}: ${text.slice(0, 200)}`);
  }

  const resData = await res.json();
  console.log('TikTok EAPI response:', JSON.stringify(resData));
  return resData;
}

async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    // Парсим body
    let data;
    try {
      data = await request.json();
    } catch (e) {
      return json({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    // Валидация
    const { name, age, phone, telegram, readiness } = data;
    if (!name || !phone || !telegram || !readiness) {
      return json({ error: 'Missing required fields' }, 400, corsHeaders);
    }

    // Honeypot / anti-spam: имя слишком длинное, возраст за пределами разумного
    if (name.length > 100 || age < 16 || age > 99) {
      return json({ error: 'Validation failed' }, 400, corsHeaders);
    }

    // Нормализация телефона в E.164
    const phoneE164 = normalizePhone(phone);

    // Обогащаем данные
    const enriched = {
      ...data,
      phone_e164: phoneE164,
      received_at: new Date().toISOString(),
      ip: request.headers.get('CF-Connecting-IP'),
      country: request.headers.get('CF-IPCountry'),
      user_agent_server: request.headers.get('User-Agent'),
    };

    // Параллельная отправка
    const [makeRes, capiRes] = await Promise.allSettled([
      env.MAKE_WEBHOOK_URL
        ? sendToMake(env.MAKE_WEBHOOK_URL, enriched)
        : Promise.resolve(null),
      env.FB_PIXEL_ID && env.FB_ACCESS_TOKEN
        ? sendToCAPI(env, enriched, request)
        : Promise.resolve(null),
    ]);

    // Логируем результаты (видны в Cloudflare Dashboard → Workers → Logs)
    console.log('Make:', makeRes.status, makeRes.reason?.message || 'ok');
    console.log('CAPI:', capiRes.status, capiRes.reason?.message || 'ok');

    // Если Make упал — это критично (лид потеряется)
    if (makeRes.status === 'rejected') {
      return json({ error: 'Failed to save lead' }, 500, corsHeaders);
    }

    return json({ success: true }, 200, corsHeaders);
  },
};

// ========================================
// HELPERS
// ========================================

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Нормализация украинского телефона в E.164
 *   0671234567        → +380671234567
 *   380671234567      → +380671234567
 *   +38 (067) 123-45-67 → +380671234567
 */
function normalizePhone(phone) {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('380') && digits.length === 12) return '+' + digits;
  if (digits.startsWith('80') && digits.length === 11) return '+3' + digits;
  if (digits.length === 10 && digits.startsWith('0')) return '+38' + digits;
  if (digits.length === 9) return '+380' + digits;
  return '+' + digits; // fallback
}

async function sendToMake(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Make ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

async function sendToCAPI(env, data, request) {
  // Хешируем PII по правилам Meta (SHA-256, lowercase, trimmed)
  const phoneDigits = data.phone_e164.replace(/\D/g, '');
  const phoneHash = await sha256(phoneDigits);
  const nameHash = data.name ? await sha256(data.name.toLowerCase().trim()) : null;
  const countryHash = await sha256('ua');
  const externalIdHash = data.external_id ? await sha256(data.external_id) : null;

  const userData = {
    ph: [phoneHash],
    country: [countryHash],
    client_ip_address: request.headers.get('CF-Connecting-IP'),
    client_user_agent: data.user_agent || request.headers.get('User-Agent'),
  };

  if (nameHash) userData.fn = [nameHash];
  if (externalIdHash) userData.external_id = [externalIdHash];

  // fbp — ID браузера (устанавливается Meta Pixel автоматически)
  if (data.fbp) userData.fbp = data.fbp;

  // fbc — ID клика (устанавливается из ?fbclid= в URL рекламного объявления)
  if (data.fbc) {
    userData.fbc = data.fbc;
  } else if (data.url) {
    // Пробуем извлечь fbclid из URL если cookie не было
    try {
      const urlObj = new URL(data.url);
      const fbclid = urlObj.searchParams.get('fbclid');
      if (fbclid) {
        userData.fbc = `fb.1.${data.timestamp * 1000}.${fbclid}`;
      }
    } catch(e) {}
  }

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: data.timestamp || Math.floor(Date.now() / 1000),
      event_source_url: data.url,
      action_source: 'website',
      event_id: data.event_id || `lead_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      user_data: userData,
      custom_data: {
        content_name: 'Chat Manager Kyiv',
        content_category: 'HR Lead',
        readiness: data.readiness,
      },
    }],
  };

  const url = `https://graph.facebook.com/v19.0/${env.FB_PIXEL_ID}/events?access_token=${env.FB_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CAPI ${res.status}: ${text.slice(0, 200)}`);
  }

  // Логируем ответ Meta для диагностики
  const resData = await res.json();
  console.log('CAPI response:', JSON.stringify(resData));
  return resData;
}

async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}