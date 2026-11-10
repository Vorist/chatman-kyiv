// Cloudflare Pages Function — POST /api/tiktok
//
// Серверные события для TikTok (Events API 2.0). Сюда стучится Make:
//   kind=lead    — новая заявка с сайта  → событие Lead (тот же event_id, что у пикселя
//                  в браузере, поэтому TikTok склеивает пару и не считает лид дважды)
//   kind=status  — HR сменил статус лида → CompleteRegistration / ApplicationApproval
//
// Токен TikTok НЕ хранится ни в коде, ни в Cloudflare: Make передаёт его в заголовке
// X-TikTok-Token при каждом запросе. Без токена функция бесполезна — она только
// собирает событие в правильном формате и пересылает его в TikTok.
// Выкладывается сама вместе с сайтом (git push), ручной деплой не нужен.

const TIKTOK_PIXEL_CODE = 'DBP6LBRC77U5934IJN90';
const TIKTOK_API_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const SITE_URL = 'https://chatman-kyiv.com/';
const MAX_BODY_CHARS = 20000;

// Статус из таблицы → стандартное событие TikTok для цели «Лиды».
// По своим (custom) названиям TikTok не оптимизирует. null = событие не шлём.
const STATUS_EVENTS = {
  qualified: { event: 'CompleteRegistration', value: 8 },
  converted: { event: 'ApplicationApproval', value: 40 },
  rejected: null,
  contacted: null,
};

const EVENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,49}$/;
const TOKEN_RE = /^[A-Za-z0-9._-]{20,200}$/;
const TEST_CODE_RE = /^[A-Za-z0-9_-]{4,40}$/;

const CONTENTS = [{
  content_id: 'chat-manager-kyiv',
  content_name: 'Chat Manager Kyiv',
  content_category: 'HR Lead',
}];

export async function onRequest(context) {
  const { request } = context;

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const token = (request.headers.get('X-TikTok-Token') || '').trim();
  if (!TOKEN_RE.test(token)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // Тело — обычная форма (так шлёт Make: значения из ячеек кодируются сами
  // и никакой символ не может сломать запрос) или JSON.
  let data;
  try {
    const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return json({ error: 'Body too large' }, 413);
    if (contentType.includes('application/x-www-form-urlencoded')) {
      data = Object.create(null);
      for (const [k, v] of new URLSearchParams(raw)) data[k] = v;
    } else {
      data = JSON.parse(raw);
    }
  } catch (e) {
    return json({ error: 'Invalid body' }, 400);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return json({ error: 'Invalid body' }, 400);
  }

  const kind = str(data.kind).toLowerCase();
  let built;
  if (kind === 'lead') built = await buildLead(data);
  else if (kind === 'status') built = await buildStatus(data);
  else return json({ error: 'Unknown kind' }, 400);

  if (built.response) return built.response;

  const payload = {
    event_source: 'web',
    event_source_id: TIKTOK_PIXEL_CODE,
    data: [built.event],
  };
  // Код со вкладки Test Events — событие попадёт только в тестовый просмотр TikTok
  const testCode = str(data.test_event_code);
  if (testCode) {
    if (!TEST_CODE_RE.test(testCode)) return json({ error: 'Invalid test_event_code' }, 400);
    payload.test_event_code = testCode;
  }

  try {
    const tt = await postToTikTok(token, payload);
    return json({
      success: true,
      kind,
      event: built.event.event,
      event_id: built.event.event_id,
      matched_by: Object.keys(built.event.user),
      test: Boolean(payload.test_event_code),
      tiktok_code: tt.code,
    }, 200);
  } catch (e) {
    // 424, а не 502: ответ с кодом 502 Cloudflare подменяет своей страницей ошибки, и причина теряется
    return json({ error: 'TikTok EAPI error', details: String((e && e.message) || e).slice(0, 300) }, 424);
  }
}

// ---------- сборка событий ----------

async function buildLead(data) {
  const phoneE164 = phoneToE164(data.phone);
  const user = await tiktokUser({
    phoneE164,
    externalId: str(data.external_id),
    ttclid: str(data.ttclid) || ttclidFromUrl(data.url),
    ttp: str(data.ttp),
  });
  const ip = str(data.ip);
  const userAgent = str(data.user_agent);
  if (ip && /^[0-9A-Fa-f:.]{3,45}$/.test(ip)) user.ip = ip;
  if (userAgent) user.user_agent = userAgent.slice(0, 1000);

  if (!user.phone && !user.external_id && !user.ttclid && !user.ttp) {
    return { response: json({ error: 'Need phone / external_id / ttclid / ttp to match the lead' }, 400) };
  }
  const eventId = str(data.event_id);
  if (!eventId) {
    // без event_id TikTok не сможет склеить событие с браузерным и посчитает лид дважды
    return { response: json({ error: 'event_id is required for a lead' }, 400) };
  }

  // Время события: время отправки формы, если оно правдоподобно (не из будущего
  // и не старше двух суток), иначе текущее время
  const now = Math.floor(Date.now() / 1000);
  const ts = Number(data.timestamp);
  const eventTime = Number.isFinite(ts) && ts <= now + 600 && ts >= now - 172800 ? Math.floor(ts) : now;

  return {
    event: {
      event: 'Lead',
      event_time: eventTime,
      event_id: eventId.slice(0, 200),
      user,
      page: { url: str(data.url) || str(data.landing_page) || SITE_URL, referrer: str(data.referrer) },
      properties: { currency: 'USD', value: 4.0, content_type: 'product', contents: CONTENTS },
    },
  };
}

async function buildStatus(data) {
  const status = str(data.status).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(STATUS_EVENTS, status)) {
    return { response: json({ error: 'Unknown status: ' + (str(data.status) || '(empty)').slice(0, 60) }, 400) };
  }
  const base = STATUS_EVENTS[status];
  if (!base) {
    return { response: json({ success: true, skipped: true, status }, 200) };
  }
  const mapped = { ...base };
  // Make может прислать своё имя события и ценность — чтобы сменить сопоставление без правки кода
  const customEvent = data.event;
  if (customEvent !== undefined && customEvent !== null && customEvent !== '') {
    if (typeof customEvent !== 'string' || !EVENT_NAME_RE.test(customEvent)) {
      return { response: json({ error: 'Invalid event name' }, 400) };
    }
    mapped.event = customEvent;
  }
  if (data.value !== undefined && data.value !== null && data.value !== '') {
    const v = Number(data.value);
    if (!Number.isFinite(v) || v < 0 || v > 100000) {
      return { response: json({ error: 'Invalid value' }, 400) };
    }
    mapped.value = v;
  }

  const phoneE164 = phoneToE164(data.phone);
  const user = await tiktokUser({
    phoneE164,
    externalId: str(data.external_id),
    ttclid: str(data.ttclid),
    ttp: str(data.ttp),
  });
  if (!user.phone && !user.external_id && !user.ttclid) {
    return { response: json({ error: 'Need phone / external_id / ttclid to match the lead' }, 400) };
  }

  // Детерминированный event_id → повторная отправка того же статуса не задвоится
  const phoneDigits = phoneE164 ? phoneE164.replace(/\D/g, '') : '';
  const eventId = `${str(data.event_id) || str(data.external_id) || phoneDigits}-${status}`;

  return {
    event: {
      event: mapped.event,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId.slice(0, 200),
      user,
      page: { url: str(data.landing_page) || SITE_URL },
      properties: { currency: 'USD', value: mapped.value, content_type: 'product', contents: CONTENTS },
    },
  };
}

// ---------- помощники ----------

function str(v) {
  return typeof v === 'string' ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

// Телефон → E.164 с плюсом (+380XXXXXXXXX). Те же правила, что в воркере заявок.
function phoneToE164(raw) {
  const digits = str(raw).replace(/\D/g, '');
  if (!digits) return null;
  let e164;
  if (digits.startsWith('380') && digits.length === 12) e164 = '+' + digits;
  else if (digits.startsWith('80') && digits.length === 11) e164 = '+3' + digits;
  else if (digits.length === 10 && digits.startsWith('0')) e164 = '+38' + digits;
  else if (digits.length === 9) e164 = '+380' + digits;
  else e164 = '+' + digits;
  return /^\+\d{8,15}$/.test(e164) ? e164 : null;
}

function ttclidFromUrl(url) {
  try { return new URL(str(url)).searchParams.get('ttclid') || ''; } catch (e) { return ''; }
}

// Идентификаторы человека. Телефон хешируется в формате E.164 С ПЛЮСОМ —
// ровно так же хеширует пиксель в браузере, иначе хеши не совпадут.
async function tiktokUser({ phoneE164, externalId, ttclid, ttp }) {
  const user = {};
  if (phoneE164) user.phone = await sha256(phoneE164);
  if (externalId) user.external_id = await sha256(externalId);
  // ttclid бывает до 1000 символов — обрезать его нельзя, иначе клик не сматчится
  if (ttclid) user.ttclid = ttclid.slice(0, 2000);
  if (ttp) user.ttp = ttp.slice(0, 200);
  return user;
}

async function postToTikTok(token, payload) {
  const res = await fetch(TIKTOK_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Access-Token': token },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) {}
  // TikTok может ответить HTTP 200 и при ошибке — успех только при code === 0
  if (!res.ok || !body || body.code !== 0) {
    throw new Error(`http ${res.status} code ${body ? body.code : 'n/a'}: ${(body && body.message) || text.slice(0, 200)}`);
  }
  return body;
}

async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
