/**
 * Cloudflare Worker — обработчик формы лендинга
 *
 * Дедупликация:
 *   - Проверяет телефон и телеграм в KV хранилище
 *   - Нормализует телеграм: @ убирается, всё в lowercase
 *   - TTL записей: 90 дней
 *
 * Отправляет в 3 системы:
 *   1. Make.com webhook → Google Sheets + Telegram
 *   2. Meta CAPI
 *   3. TikTok Events API (в фоне — ответ форме его не ждёт)
 *
 * Роуты:
 *   POST /               — заявка с лендинга
 *   POST /status         — статус лида → Meta CAPI (нужен STATUS_KEY)
 *   POST /status/tiktok  — статус лида → TikTok Events API (вызывает Make)
 *
 * Секреты (wrangler secret put):
 *   MAKE_WEBHOOK_URL, FB_PIXEL_ID, FB_ACCESS_TOKEN, ALLOWED_ORIGIN
 *   TIKTOK_ACCESS_TOKEN  — токен Events API из TikTok Events Manager
 * Необязательные:
 *   TIKTOK_PIXEL_CODE       — другой пиксель вместо зашитого ниже
 *   TIKTOK_TEST_EVENT_CODE  — код из вкладки Test Events (на время проверки)
 *   STATUS_KEY              — свой ключ для /status и /status/tiktok
 *
 * KV namespace:
 *   LEADS_DEDUP — хранит хеши телефонов и телеграм-ников
 */

const KV_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 дней

// Версия кода — видна в заголовке X-Worker-Version любого ответа (проверка деплоя)
const WORKER_VERSION = '2026-11-10-tiktok';

// TikTok: код пикселя публичный (он же стоит в коде страницы), секрет — только токен
const TIKTOK_PIXEL_CODE = 'DBP6LBRC77U5934IJN90';
const TIKTOK_API_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

// Ключ, которым сценарий Make подписывает запросы на /status/tiktok
// (заголовок X-Status-Key). Здесь лежит только его SHA-256: сам ключ хранится
// в сценарии Make и составлен из ID таблицы лидов, поэтому посторонний,
// не видевший таблицу, запрос подделать не сможет. Нужна защита строже —
// задай свой секрет: wrangler secret put STATUS_KEY (и тот же ключ в Make).
const STATUS_KEY_SHA256 = '4cc91108fb80a5df54335b85fb43886bf7a4e711631cb60f13a24b98f7f71b47';

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'X-Worker-Version': WORKER_VERSION,
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const pathname = new URL(request.url).pathname;

    // Роут: статус лида из таблицы → TikTok Events API (вызывается из Make)
    if (pathname === '/status/tiktok') {
      return handleTikTokStatus(request, env, corsHeaders);
    }

    // Роут: обратная отправка статуса лида в Meta CAPI (вызывается из Make)
    if (pathname === '/status') {
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

    // TikTok Events API — в фоне: ответ форме не ждёт TikTok, и никакая
    // ошибка TikTok не может повлиять на сохранение лида.
    if (env.TIKTOK_ACCESS_TOKEN) {
      const tiktokJob = sendToTikTok(env, enriched, request)
        .then(() => console.log('TikTok EAPI: ok'))
        .catch((e) => console.log('TikTok EAPI: failed', e && e.message));
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(tiktokJob);
    }

    const [makeRes, capiRes] = await Promise.allSettled([
      env.MAKE_WEBHOOK_URL
        ? sendToMake(env.MAKE_WEBHOOK_URL, enriched)
        : Promise.resolve(null),
      env.FB_PIXEL_ID && env.FB_ACCESS_TOKEN
        ? sendToCAPI(env, enriched, request)
        : Promise.resolve(null),
    ]);

    console.log('Make:', makeRes.status, makeRes.reason?.message || 'ok');
    console.log('Meta CAPI:', capiRes.status, capiRes.reason?.message || 'ok');

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

// ========================================
// TIKTOK EVENTS API  (POST /open_api/v1.3/event/track/, формат Events API 2.0)
// ========================================

function tiktokPixelCode(env) {
  return env.TIKTOK_PIXEL_CODE || TIKTOK_PIXEL_CODE;
}

// Идентификаторы человека для TikTok. Телефон хешируется в формате E.164
// С ПЛЮСОМ (+380XXXXXXXXX) — ровно так же хеширует пиксель в браузере,
// иначе хеши браузера и сервера не совпадут.
async function tiktokUser({ phoneE164, externalId, ttclid, ttp }) {
  const user = {};
  if (phoneE164 && /^\+\d{8,15}$/.test(phoneE164)) user.phone = await sha256(phoneE164);
  if (externalId) user.external_id = await sha256(String(externalId));
  // ttclid бывает до 1000 символов — обрезать его нельзя, иначе клик не сматчится
  if (ttclid) user.ttclid = String(ttclid).slice(0, 2000);
  if (ttp) user.ttp = String(ttp).slice(0, 200);
  return user;
}

async function postTikTokEvents(env, events) {
  const payload = {
    event_source: 'web',
    event_source_id: tiktokPixelCode(env),
    data: events,
  };
  if (env.TIKTOK_TEST_EVENT_CODE) payload.test_event_code = env.TIKTOK_TEST_EVENT_CODE;

  const res = await fetch(TIKTOK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Access-Token': env.TIKTOK_ACCESS_TOKEN,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) {}

  // TikTok отвечает HTTP 200 даже при ошибке — успех только при code === 0
  if (!res.ok || !body || body.code !== 0) {
    throw new Error(`TikTok EAPI http ${res.status} code ${body ? body.code : 'n/a'}: ${(body && body.message) || text.slice(0, 200)}`);
  }
  return body;
}

const TIKTOK_CONTENTS = [{
  content_id: 'chat-manager-kyiv',
  content_name: 'Chat Manager Kyiv',
  content_category: 'HR Lead',
}];

// Заявка с сайта → событие Lead. event_id тот же, что у пикселя в браузере:
// TikTok склеивает пару «браузер + сервер» в одно событие.
async function sendToTikTok(env, data, request) {
  let ttclid = data.ttclid || null;
  if (!ttclid && data.url) {
    try { ttclid = new URL(data.url).searchParams.get('ttclid'); } catch (e) {}
  }

  const user = await tiktokUser({
    phoneE164: data.phone_e164,
    externalId: data.external_id,
    ttclid,
    ttp: data.ttp,
  });
  const ip = request.headers.get('CF-Connecting-IP');
  const userAgent = data.user_agent || request.headers.get('User-Agent');
  if (ip) user.ip = ip;
  if (userAgent) user.user_agent = userAgent;

  // Время события: часы браузера, если они не врут больше чем на 10 минут; иначе время сервера
  const now = Math.floor(Date.now() / 1000);
  const ts = Number(data.timestamp);
  const eventTime = Number.isFinite(ts) && Math.abs(now - ts) <= 600 ? Math.floor(ts) : now;

  const resData = await postTikTokEvents(env, [{
    event: 'Lead',
    event_time: eventTime,
    event_id: data.event_id || `lead_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    user,
    page: {
      url: data.url || data.landing_page || '',
      referrer: data.referrer || '',
    },
    properties: {
      currency: 'USD',
      value: 4.0,
      content_type: 'product',
      contents: TIKTOK_CONTENTS,
    },
  }]);
  console.log('TikTok EAPI response:', JSON.stringify(resData));
  return resData;
}

// ========================================
// СТАТУСЫ ЛИДОВ → TikTok Events API
// HR ставит статус в таблице → сценарий Make шлёт POST /status/tiktok →
// Worker отправляет событие качества в тот же пиксель.
//
// Имена — СТАНДАРТНЫЕ события TikTok для цели «Лиды»: по своим (custom)
// событиям TikTok не оптимизирует, только показывает их в отчётах.
//   Qualified → CompleteRegistration («качественный лид»)
//   Converted → ApplicationApproval  («заявку одобрили: вышел на работу»)
// null = статус известен, но событие не шлём (негативные статусы).
// ========================================
const TIKTOK_STATUS_EVENTS = {
  qualified: { event: 'CompleteRegistration', value: 8 },
  converted: { event: 'ApplicationApproval', value: 40 },
  rejected: null,
  contacted: null,
};

// Make может прислать своё имя события (поле event) — чтобы сменить
// сопоставление без передеплоя воркера. Правила TikTok для имени:
// латиница, цифры, «_» и «-», не длиннее 50 символов.
const TIKTOK_EVENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,49}$/;

async function statusKeyValid(request, env) {
  const key = request.headers.get('X-Status-Key') || '';
  if (!key) return false;
  if (env.STATUS_KEY && key === env.STATUS_KEY) return true;
  return (await sha256(key)) === STATUS_KEY_SHA256;
}

async function handleTikTokStatus(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }
  if (!(await statusKeyValid(request, env))) {
    return json({ error: 'Unauthorized' }, 401, corsHeaders);
  }
  if (!env.TIKTOK_ACCESS_TOKEN) {
    return json({ error: 'TikTok token not configured' }, 503, corsHeaders);
  }

  // Тело — JSON или обычная форма (application/x-www-form-urlencoded).
  // Make шлёт форму: значения из ячеек кодируются сами, и никакой символ
  // в таблице (кавычка, перенос строки) не может сломать запрос.
  let data;
  try {
    const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
    const raw = await request.text();
    if (contentType.includes('application/x-www-form-urlencoded')) {
      data = Object.create(null);
      for (const [k, v] of new URLSearchParams(raw)) data[k] = v;
    } else {
      data = JSON.parse(raw);
    }
  } catch (e) {
    return json({ error: 'Invalid JSON' }, 400, corsHeaders);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return json({ error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const status = String(data.status || '').toLowerCase().trim();
  if (!Object.prototype.hasOwnProperty.call(TIKTOK_STATUS_EVENTS, status)) {
    return json({ error: 'Unknown status: ' + (data.status || '(empty)') }, 400, corsHeaders);
  }
  const base = TIKTOK_STATUS_EVENTS[status];
  if (!base) {
    return json({ success: true, skipped: true, status }, 200, corsHeaders);
  }
  const mapped = { ...base };
  if (data.event !== undefined && data.event !== null && data.event !== '') {
    if (typeof data.event !== 'string' || !TIKTOK_EVENT_NAME_RE.test(data.event)) {
      return json({ error: 'Invalid event name' }, 400, corsHeaders);
    }
    mapped.event = data.event;
  }
  if (data.value !== undefined && data.value !== null && data.value !== '') {
    const v = Number(data.value);
    if (!Number.isFinite(v) || v < 0 || v > 100000) {
      return json({ error: 'Invalid value' }, 400, corsHeaders);
    }
    mapped.value = v;
  }

  const phoneDigits = String(data.phone || '').replace(/\D/g, '');
  const phoneE164 = phoneDigits ? normalizePhone(phoneDigits) : null;
  if (!phoneE164 && !data.external_id && !data.ttclid) {
    return json({ error: 'Need phone / external_id / ttclid to match the lead' }, 400, corsHeaders);
  }

  const user = await tiktokUser({
    phoneE164,
    externalId: data.external_id,
    ttclid: data.ttclid,
    ttp: data.ttp,
  });

  // Детерминированный event_id → повторная отправка того же статуса не задвоится
  const eventId = `${data.event_id || data.external_id || phoneDigits}-${status}`;

  try {
    const tt = await postTikTokEvents(env, [{
      event: mapped.event,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      user,
      page: { url: data.landing_page || 'https://chatman-kyiv.com/' },
      properties: {
        currency: 'USD',
        value: mapped.value,
        content_type: 'product',
        contents: TIKTOK_CONTENTS,
      },
    }]);
    console.log('Status → TikTok:', status, mapped.event, eventId, JSON.stringify(tt));
    return json({ success: true, status, event: mapped.event, event_id: eventId, tiktok_code: tt.code }, 200, corsHeaders);
  } catch (e) {
    console.log('Status → TikTok failed:', status, eventId, e && e.message);
    return json({ error: 'TikTok EAPI error', details: String((e && e.message) || e).slice(0, 300) }, 502, corsHeaders);
  }
}

async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}