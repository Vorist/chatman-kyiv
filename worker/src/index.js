/**
 * Cloudflare Worker — обработчик формы лендинга
 *
 * Дедупликация:
 *   - Проверяет телефон и телеграм в KV хранилище
 *   - Нормализует телеграм: @ убирается, всё в lowercase
 *   - TTL записей: 90 дней
 *
 * Отправляет параллельно в 3 системы:
 *   1. Make.com webhook → Google Sheets + Telegram
 *   2. Meta CAPI
 *   3. TikTok Events API
 *
 * Секреты (wrangler secret put):
 *   MAKE_WEBHOOK_URL, FB_PIXEL_ID, FB_ACCESS_TOKEN
 *   ALLOWED_ORIGIN, TIKTOK_PIXEL_ID, TIKTOK_ACCESS_TOKEN
 *
 * KV namespace:
 *   LEADS_DEDUP — хранит хеши телефонов и телеграм-ников
 */

const KV_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 дней

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

    // Роут: обратная отправка статуса лида в Meta CAPI (вызывается из Make)
    if (new URL(request.url).pathname === '/status') {
      return handleStatusUpdate(request, env, corsHeaders);
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

    // Нормализация телеграма: убираем @ и приводим к lowercase
    // @Sinba08 и Sinba08 — одно и то же
    const tgNormalized = telegram.trim().replace(/^@/, '').toLowerCase();

    // ============================================
    // ДЕДУПЛИКАЦИЯ ЧЕРЕЗ KV
    // ============================================
    if (env.LEADS_DEDUP) {
      const phoneKey = `phone:${await sha256(phoneE164)}`;
      const tgKey = `tg:${await sha256(tgNormalized)}`;

      const [existingPhone, existingTg] = await Promise.all([
        env.LEADS_DEDUP.get(phoneKey),
        env.LEADS_DEDUP.get(tgKey),
      ]);

      if (existingPhone) {
        console.log('Duplicate: phone', phoneE164);
        return json({
          duplicate: true,
          message: 'Вы уже оставили заявку. Мы скоро свяжемся с вами!'
        }, 200, corsHeaders);
      }

      if (existingTg) {
        console.log('Duplicate: telegram', tgNormalized);
        return json({
          duplicate: true,
          message: 'Вы уже оставили заявку. Мы скоро свяжемся с вами!'
        }, 200, corsHeaders);
      }

      // Записываем в KV с TTL 90 дней
      // Сохраняем читаемые данные для возможной отладки
      const submittedAt = new Date().toISOString();
      await Promise.all([
        env.LEADS_DEDUP.put(phoneKey, submittedAt, { expirationTtl: KV_TTL_SECONDS }),
        env.LEADS_DEDUP.put(tgKey, submittedAt, { expirationTtl: KV_TTL_SECONDS }),
      ]);

      console.log('KV: saved phone + tg for', tgNormalized);
    }

    // ============================================
    // ОБРАБОТКА ЛИДА
    // ============================================
    const enriched = {
      ...data,
      // Атрибуция — просто проброс. Ключи всегда присутствуют (пустые, если метки не было),
      // чтобы колонки в Google Sheets не съезжали от лида к лиду.
      gclid: data.gclid || '',
      gbraid: data.gbraid || '',
      wbraid: data.wbraid || '',
      fbclid: data.fbclid || '',
      ttclid: data.ttclid || '',
      utm_source: data.utm_source || '',
      utm_medium: data.utm_medium || '',
      utm_campaign: data.utm_campaign || '',
      utm_term: data.utm_term || '',
      utm_content: data.utm_content || '',
      referrer: data.referrer || '',
      landing_page: data.landing_page || '',
      fbc: data.fbc || '',
      fbp: data.fbp || '',
      phone_e164: phoneE164,
      telegram_normalized: tgNormalized,
      channel: detectChannel(data),
      received_at: new Date().toISOString(),
      ip: request.headers.get('CF-Connecting-IP'),
      country: request.headers.get('CF-IPCountry'),
      user_agent_server: request.headers.get('User-Agent'),
    };

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

// ========================================
// СТАТУСЫ ЛИДОВ → Meta CAPI
// HR ставит статус в таблице → Make дёргает POST /status →
// Worker шлёт в Meta событие качества. Meta учится на хороших лидах.
// ========================================

// Канонические статусы → события Meta. value (USD) — условная ценность
// этапа воронки, помогает оптимизации по ценности.
const STATUS_EVENTS = {
  qualified: { event: 'QualifiedLead', value: 8 },
  interview: { event: 'InterviewScheduled', value: 15 },
  hired: { event: 'Hired', value: 40 },
};

// Возможные написания статуса из таблицы → канонический статус.
// Негативные статусы → 'skip': событие НЕ шлём (Meta учится на позитивных
// сигналах; «плохой» лид = лид, который так и не получил событие качества).
const STATUS_ALIASES = {
  qualified: ['qualified', 'квал', 'квалифицирован', 'качественный', 'якісний', 'хороший', 'good'],
  interview: ['interview', 'собеседование', 'співбесіда', 'встреча', 'зустріч'],
  hired: ['hired', 'вышел', 'вийшов', 'нанят', 'работает', 'працює'],
  skip: ['junk', 'мусор', 'плохой', 'поганий', 'спам', 'spam', 'нецелевой', 'нецільовий', 'отказ', 'відмова', 'disqualified', 'bad'],
};

function canonicalStatus(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return null;
  for (const [canon, aliases] of Object.entries(STATUS_ALIASES)) {
    if (canon === s || aliases.includes(s)) return canon;
  }
  return null;
}

async function handleStatusUpdate(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }
  // Защита: секрет в заголовке (задать: wrangler secret put STATUS_KEY)
  if (!env.STATUS_KEY || request.headers.get('X-Status-Key') !== env.STATUS_KEY) {
    return json({ error: 'Unauthorized' }, 401, corsHeaders);
  }
  if (!env.FB_PIXEL_ID || !env.FB_ACCESS_TOKEN) {
    return json({ error: 'FB credentials not configured' }, 500, corsHeaders);
  }

  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const canon = canonicalStatus(data.status);
  if (!canon) {
    return json({ error: 'Unknown status: ' + (data.status || '(empty)'), known: STATUS_ALIASES }, 400, corsHeaders);
  }
  if (canon === 'skip') {
    // Плохой лид — событие не отправляем, просто подтверждаем обработку
    return json({ success: true, skipped: true, status: canon }, 200, corsHeaders);
  }

  if (!data.phone && !data.external_id && !data.fbp && !data.fbc) {
    return json({ error: 'Need phone / external_id / fbp / fbc to match the lead' }, 400, corsHeaders);
  }

  const { event: eventName, value } = STATUS_EVENTS[canon];

  // user_data — те же идентификаторы, что были у исходного Lead,
  // чтобы Meta склеила событие качества с тем же человеком/кликом
  const userData = { country: [await sha256('ua')] };
  if (data.phone) {
    const phoneDigits = normalizePhone(String(data.phone)).replace(/\D/g, '');
    userData.ph = [await sha256(phoneDigits)];
  }
  if (data.external_id) userData.external_id = [await sha256(String(data.external_id))];
  if (data.fbp) userData.fbp = data.fbp;
  if (data.fbc) userData.fbc = data.fbc;

  // Детерминированный event_id → повторная отправка того же статуса дедуплицируется
  const eventId = `st_${canon}_${data.event_id || data.external_id || Date.now()}`;

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'system_generated',
      event_id: eventId,
      user_data: userData,
      custom_data: {
        lead_status: canon,
        currency: 'USD',
        value,
      },
    }],
  };

  const apiUrl = `https://graph.facebook.com/v19.0/${env.FB_PIXEL_ID}/events?access_token=${env.FB_ACCESS_TOKEN}`;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const resData = await res.json().catch(() => ({}));
  console.log('Status → CAPI:', canon, res.status, JSON.stringify(resData));

  if (!res.ok) {
    return json({ error: 'Meta CAPI error', details: resData }, 502, corsHeaders);
  }
  return json({ success: true, status: canon, event: eventName, event_id: eventId, fb: resData }, 200, corsHeaders);
}

// Человекочитаемый канал привлечения по меткам атрибуции
function detectChannel(d) {
  const utm = (d.utm_source || '').toLowerCase();
  if (d.gclid || d.gbraid || d.wbraid) return 'Google Ads';
  if (d.fbclid || /fb|facebook|meta|ig|instagram/.test(utm)) return 'Meta (FB/IG)';
  if (d.ttclid || /tiktok|^tt$/.test(utm)) return 'TikTok';
  if (d.utm_source) return d.utm_source;
  if (d.referrer) {
    try { return 'Referral: ' + new URL(d.referrer).hostname; } catch (e) { return 'Referral'; }
  }
  return 'Direct / Organic';
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
        value: 4.00,
        currency: 'USD',
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
  const phoneDigits = data.phone_e164.replace(/\D/g, '');
  const phoneHash = await sha256(phoneDigits);
  const externalIdHash = data.external_id ? await sha256(data.external_id) : null;

  const ip = request.headers.get('CF-Connecting-IP');
  const userAgent = data.user_agent || request.headers.get('User-Agent');

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