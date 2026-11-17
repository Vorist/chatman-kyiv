/**
 * Cloudflare Worker — обработчик формы лендинга
 *
 * Защита роута заявки (POST /):
 *   - Origin. Заявка принимается только со своих адресов: chatman-kyiv.com,
 *     www.chatman-kyiv.com и адреса из ALLOWED_ORIGIN (можно несколько через
 *     запятую). Нет заголовка Origin или он чужой → 403. Тестовые сборки Pages
 *     (*.pages.dev) заявку отправить не могут: пробная отправка оттуда создала бы
 *     настоящую заявку в таблице и настоящую конверсию в Meta.
 *     В CORS-заголовке возвращается Origin самого запроса (плюс Vary: Origin),
 *     «*» не отдаётся никогда. Копия страницы на чужом домене заявку не отправит.
 *   - Лимит. Не больше 8 попыток с одного IP за 10 минут, дальше → 429.
 *     Счётчик лежит в том же KV. Нет IP или KV недоступен — лимит не применяется.
 *     На /status и /status/tiktok лимит не действует.
 *   - Тело. Читается как текст, больше 64 КБ → 413, принимается только JSON-объект.
 *   - Белый список. В Make уходят только известные поля формы и поля, которые
 *     добавляет сам воркер. Всё остальное отбрасывается.
 *   - Очистка значений (то, что пропускает проверка на странице, не отклоняется):
 *       name      — буквы, пробел, дефис, апостроф, точка; остальное вырезается
 *       telegram  — необязательная @ в начале и [A-Za-z0-9_]
 *       phone     — цифры и знаки номера; после нормализации обязан быть +XXXXXXXXX
 *       readiness — только 2_days / week / month
 *       остальные строки — без управляющих символов, с ограничением длины;
 *       если значение начинается с = + - @, перед ним ставится апостроф, чтобы
 *       Google Sheets не выполнил его как формулу. Рекламные идентификаторы
 *       (fbp, fbc, ttp, ttclid, gclid, gbraid, wbraid, fbclid, event_id,
 *       external_id) из одних [A-Za-z0-9._-] не трогаются совсем. Лимиты длины
 *       взяты с запасом в несколько раз от самых длинных настоящих значений:
 *       обрезанный идентификатор клика площадка уже не узнает.
 *
 * Дедупликация:
 *   - Проверяет телефон и телеграм в KV хранилище
 *   - Нормализует телеграм: @ убирается, всё в lowercase
 *   - Ключи записываются ТОЛЬКО после того, как Make принял заявку. Если Make
 *     упал и человек нажал «отправить» ещё раз, заявка дойдёт, а не будет
 *     принята за дубликат.
 *   - Ошибка KV (чтение или запись) пишется в лог и заявку не останавливает
 *   - TTL записей: 90 дней
 *
 * Куда уходит заявка:
 *   1. Make.com webhook → Google Sheets + Telegram (ждём ответа не дольше 20 секунд,
 *      от него зависит ответ форме)
 *   2. Meta CAPI — только после успеха Make, в фоне; её ошибка на ответ форме не влияет
 *   3. TikTok Events API — только если задан TIKTOK_ACCESS_TOKEN и явно включено
 *      TIKTOK_VIA_WORKER=1 (обычно выключено,
 *      см. ниже); тоже после успеха Make и в фоне
 *
 * Роуты:
 *   POST /               — заявка с лендинга
 *   POST /status         — статус лида → Meta CAPI (нужен STATUS_KEY)
 *   POST /status/tiktok  — статус лида → TikTok Events API (вызывает Make)
 *   Ключи статусов сравниваются за постоянное время.
 *
 * Секреты (wrangler secret put):
 *   MAKE_WEBHOOK_URL, FB_PIXEL_ID, FB_ACCESS_TOKEN, ALLOWED_ORIGIN
 * Необязательные:
 *   TIKTOK_VIA_WORKER       — "1" включает отправку в TikTok из воркера. Без этого воркер
 *                             в TikTok ничего не шлёт, даже если токен задан (в аккаунте
 *                             остался старый токен, а события TikTok идут через Make).
 *   TIKTOK_ACCESS_TOKEN     — НЕ задавать без нужды: серверные события TikTok уже идут
 *                             через Make → /api/tiktok. Если секрет задан, воркер шлёт
 *                             Lead в TikTok сам, параллельно с Make.
 *   TIKTOK_PIXEL_CODE       — другой пиксель вместо зашитого ниже
 *   TIKTOK_TEST_EVENT_CODE  — код из вкладки Test Events (на время проверки)
 *   STATUS_KEY              — свой ключ для /status и /status/tiktok
 *
 * KV namespace:
 *   LEADS_DEDUP — хеши телефонов и телеграм-ников (phone:…, tg:…) и счётчики
 *                 попыток по IP (rl:…, живут 20 минут)
 */

const KV_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 дней

// Версия кода — видна в заголовке X-Worker-Version любого ответа (проверка деплоя)
const WORKER_VERSION = '2026-11-17-tiktok-pixel';

// ---- Защита роута заявки ----

// Свои адреса сайта. Дополнительные задаются секретом ALLOWED_ORIGIN (через запятую).
// Тестовых сборок Pages (*.pages.dev) здесь нет намеренно: см. шапку файла.
const SITE_ORIGINS = ['https://chatman-kyiv.com', 'https://www.chatman-kyiv.com'];

const MAX_BODY_BYTES = 64 * 1024;      // тело заявки со всеми метками занимает 1–5 КБ
const RATE_MAX_ATTEMPTS = 8;           // попыток с одного IP…
const RATE_WINDOW_SECONDS = 10 * 60;   // …за 10 минут

const READINESS_VALUES = ['2_days', 'week', 'month'];

// Обычные строковые поля заявки (кроме name / age / phone / telegram / readiness /
// lang / source / timestamp — у них свои правила)
const TEXT_FIELDS = [
  'landing_page', 'first_visit', 'event_id', 'external_id', 'url', 'referrer',
  'fbp', 'fbc', 'ttp', 'ttclid', 'user_agent',
  'gclid', 'gbraid', 'wbraid', 'fbclid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
];
// Рекламные идентификаторы: по ним площадки находят клик, менять их нельзя
const AD_ID_FIELDS = ['fbp', 'fbc', 'ttp', 'ttclid', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'event_id', 'external_id'];
const AD_ID_SAFE_RE = /^[A-Za-z0-9._-]+$/;
// Ограничения длины. Самые длинные настоящие значения в таблице лидов: fbclid 212,
// fbc 220, gclid 92, referrer 649, landing_page 278 символов; user agent встроенных
// браузеров — до 400–500. Лимиты в несколько раз выше, чтобы ничего настоящего не обрезать.
const TEXT_MAX = { ttclid: 2000, url: 2000, referrer: 2000, landing_page: 2000, user_agent: 1000 };
const AD_ID_MAX = 1000;       // остальные рекламные идентификаторы
const TEXT_MAX_DEFAULT = 300; // utm_* и прочие строки

// Управляющие и невидимые символы (в том числе табуляция и переводы строк).
// U+200C и U+200D оставлены: они бывают частью эмодзи в названии кампании.
const CONTROL_CHARS_RE = /[\p{Cc}\u2028\u2029]|(?![\u200C\u200D])\p{Cf}/gu;
// С этих символов таблица начинает читать ячейку как формулу (обычные и полноширинные)
const FORMULA_LEAD_RE = /^[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/;

// TikTok: код пикселя публичный (он же стоит в коде страницы), секрет — только токен
const TIKTOK_PIXEL_CODE = 'D7P7523C77U02PK9RRH0';
const TIKTOK_API_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

// Ключ, которым сценарий Make подписывает запросы на /status/tiktok
// (заголовок X-Status-Key). Здесь лежит только его SHA-256: сам ключ хранится
// в сценарии Make и составлен из ID таблицы лидов, поэтому посторонний,
// не видевший таблицу, запрос подделать не сможет. Нужна защита строже —
// задай свой секрет: wrangler secret put STATUS_KEY (и тот же ключ в Make).
const STATUS_KEY_SHA256 = '4cc91108fb80a5df54335b85fb43886bf7a4e711631cb60f13a24b98f7f71b47';

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const originAllowed = isAllowedOrigin(origin, env);

    // CORS: возвращаем Origin самого запроса и только если он в списке своих. «*» не бывает.
    const corsHeaders = {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Worker-Version': WORKER_VERSION,
    };
    if (originAllowed) corsHeaders['Access-Control-Allow-Origin'] = origin;

    if (request.method === 'OPTIONS') {
      // Браузер на чужом домене дальше этого запроса не идёт. Строка в логе покажет адрес
      // копии страницы, которая всё ещё пытается слать заявки сюда.
      if (!originAllowed && origin) console.log('Preflight rejected: origin', cleanText(origin, 120, false));
      return new Response(null, { status: originAllowed ? 200 : 403, headers: corsHeaders });
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

    // ============================================
    // ЗАЩИТА: Origin → лимит по IP → размер и формат тела
    // ============================================
    if (!originAllowed) {
      console.log('Lead rejected: origin', cleanText(origin, 120, false) || '(none)');
      return json({ error: 'Origin not allowed' }, 403, corsHeaders);
    }

    if (await isRateLimited(env, request.headers.get('CF-Connecting-IP'))) {
      console.log('Lead rejected: rate limit');
      return json({ error: 'Too many requests' }, 429, { ...corsHeaders, 'Retry-After': String(RATE_WINDOW_SECONDS) });
    }

    const raw = await readBodyLimited(request, MAX_BODY_BYTES);
    if (raw === null) {
      return json({ error: 'Payload too large' }, 413, corsHeaders);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return json({ error: 'Invalid JSON' }, 400, corsHeaders);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return json({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    // Берём только собственные поля объекта (никаких __proto__ и т.п.)
    const field = (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined);

    if (isBlank(field('name')) || isBlank(field('phone')) || isBlank(field('telegram')) || isBlank(field('readiness'))) {
      return json({ error: 'Missing required fields' }, 400, corsHeaders);
    }

    // ============================================
    // ОЧИСТКА ПОЛЕЙ
    // Всё, что пропускает проверка на странице, проходит без изменений.
    // ============================================
    const name = cleanName(field('name'));
    const age = cleanAge(field('age'));
    const phone = cleanPhone(field('phone'));
    const telegram = cleanTelegram(field('telegram'));
    const readiness = typeof field('readiness') === 'string' ? field('readiness').trim() : '';

    const phoneE164 = phone ? normalizePhone(phone) : '';

    if (!name || age === null || !telegram || !/^\+\d{9,15}$/.test(phoneE164) || !READINESS_VALUES.includes(readiness)) {
      return json({ error: 'Validation failed' }, 400, corsHeaders);
    }

    // Нормализация телеграма: убираем @ и приводим к lowercase
    // @Sinba08 и Sinba08 — одно и то же
    const tgNormalized = telegram.replace(/^@/, '').toLowerCase();

    // ============================================
    // ДЕДУПЛИКАЦИЯ ЧЕРЕЗ KV — пока только проверка.
    // Ключи записываются ниже, после того как Make принял заявку.
    // Ошибка KV заявку не останавливает.
    // ============================================
    let phoneKey = null;
    let tgKey = null;
    if (env.LEADS_DEDUP) {
      phoneKey = `phone:${await sha256(phoneE164)}`;
      tgKey = `tg:${await sha256(tgNormalized)}`;

      const [existingPhone, existingTg] = await Promise.all([
        kvGet(env, phoneKey),
        kvGet(env, tgKey),
      ]);

      if (existingPhone || existingTg) {
        console.log('Duplicate:', existingPhone ? 'phone' : 'telegram');
        return json({
          duplicate: true,
          message: 'Вы уже оставили заявку. Мы скоро свяжемся с вами!'
        }, 200, corsHeaders);
      }
    }

    // ============================================
    // ОБРАБОТКА ЛИДА
    // В Make уходит только этот объект: известные поля формы + то, что добавил воркер.
    // Ключи всегда присутствуют (пустые, если значения не было),
    // чтобы колонки в Google Sheets не съезжали от лида к лиду.
    // ============================================
    const enriched = {
      name,
      age,
      phone,
      telegram,
      readiness,
      lang: cleanLang(field('lang')),
      source: cleanSource(field('source')),
      timestamp: cleanTimestamp(field('timestamp')),
    };
    for (const key of TEXT_FIELDS) {
      const isAdId = AD_ID_FIELDS.includes(key);
      enriched[key] = cleanText(field(key), TEXT_MAX[key] || (isAdId ? AD_ID_MAX : TEXT_MAX_DEFAULT), isAdId);
    }
    enriched.phone_e164 = phoneE164;
    enriched.telegram_normalized = tgNormalized;
    enriched.channel = detectChannel(enriched);
    enriched.received_at = new Date().toISOString();
    enriched.ip = String(request.headers.get('CF-Connecting-IP') || '').replace(/[^0-9A-Fa-f:.]/g, '').slice(0, 45);
    enriched.country = String(request.headers.get('CF-IPCountry') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
    enriched.user_agent_server = cleanText(request.headers.get('User-Agent'), 1000, false);

    // Make — главный получатель: от него зависит, что увидит человек.
    try {
      if (!env.MAKE_WEBHOOK_URL) throw new Error('MAKE_WEBHOOK_URL is not set');
      await sendToMake(env.MAKE_WEBHOOK_URL, enriched);
      console.log('Make: ok');
    } catch (e) {
      // Ключи дедупликации не записаны → повторная отправка дойдёт до Make
      console.log('Make: failed', e && e.message);
      return json({ error: 'Failed to save lead' }, 500, corsHeaders);
    }

    // Заявка сохранена — только теперь запоминаем телефон и телеграм на 90 дней
    if (env.LEADS_DEDUP && phoneKey && tgKey) {
      const submittedAt = new Date().toISOString();
      await Promise.all([
        kvPut(env, phoneKey, submittedAt, KV_TTL_SECONDS),
        kvPut(env, tgKey, submittedAt, KV_TTL_SECONDS),
      ]);
    }

    // TikTok Events API — только если задан токен; после успеха Make и в фоне:
    // ответ форме не ждёт TikTok, и никакая ошибка TikTok не влияет на сохранение лида.
    if (tiktokEnabled(env)) {
      const tiktokJob = sendToTikTok(env, enriched, request)
        .then(() => console.log('TikTok EAPI: ok'))
        .catch((e) => console.log('TikTok EAPI: failed', e && e.message));
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(tiktokJob);
    }

    // Meta CAPI — после успеха Make и в фоне: ответ форме её не ждёт,
    // ошибка Meta на ответ не влияет.
    if (env.FB_PIXEL_ID && env.FB_ACCESS_TOKEN) {
      const capiJob = sendToCAPI(env, enriched, request)
        .then(() => console.log('Meta CAPI: ok'))
        .catch((e) => console.log('Meta CAPI: failed', e && e.message));
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(capiJob);
      else await capiJob;
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
// ЗАЩИТА РОУТА ЗАЯВКИ
// ========================================

// Свой ли это адрес: основной сайт, www или адрес из списка ALLOWED_ORIGIN
function isAllowedOrigin(origin, env) {
  if (!origin || origin === 'null' || origin.length > 200) return false;
  const o = origin.toLowerCase();
  if (SITE_ORIGINS.includes(o)) return true;
  for (const part of String(env.ALLOWED_ORIGIN || '').split(',')) {
    const allowed = part.trim().replace(/\/+$/, '').toLowerCase();
    // «*» и «null» в списке игнорируются: открыть приём заявок для всех нельзя
    if (allowed && allowed !== '*' && allowed !== 'null' && allowed === o) return true;
  }
  return false;
}

// Читает тело как текст, но не больше maxBytes. null → тело слишком большое.
async function readBodyLimited(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';
  try {
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch (e) {}
        return null;
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(buf);
  } catch (e) {
    return ''; // соединение оборвалось — дальше это станет «Invalid JSON»
  }
}

// Лимит попыток с одного IP. Ключ rl:<хеш IP>:<номер 10-минутного окна>, живёт 20 минут.
// Нет IP или KV недоступен → не ограничиваем: лучше пропустить лишнее, чем потерять лида.
async function isRateLimited(env, ip) {
  if (!env.LEADS_DEDUP || !ip) return false;
  try {
    const bucket = Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000));
    const key = `rl:${(await sha256(ip)).slice(0, 32)}:${bucket}`;
    const count = parseInt(await env.LEADS_DEDUP.get(key), 10) || 0;
    if (count >= RATE_MAX_ATTEMPTS) return true;
    await env.LEADS_DEDUP.put(key, String(count + 1), { expirationTtl: RATE_WINDOW_SECONDS * 2 });
    return false;
  } catch (e) {
    console.log('KV rate limit failed:', e && e.message);
    return false;
  }
}

// KV без исключений: ошибка чтения = «не нашли», ошибка записи = только строка в логе
async function kvGet(env, key) {
  try {
    return await env.LEADS_DEDUP.get(key);
  } catch (e) {
    console.log('KV read failed:', e && e.message);
    return null;
  }
}

async function kvPut(env, key, value, ttlSeconds) {
  try {
    await env.LEADS_DEDUP.put(key, value, { expirationTtl: ttlSeconds });
    return true;
  } catch (e) {
    console.log('KV write failed:', e && e.message);
    return false;
  }
}

// ========================================
// ОЧИСТКА ПОЛЕЙ ЗАЯВКИ
// ========================================

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

// Имя: буквы любого алфавита, пробел, дефис, апострофы (' ’ ‘ ʼ) и точка.
// Всё остальное (= * _ [ ] ` скобки, цифры, кавычки…) вырезается, поэтому имя
// не может стать формулой в таблице или разметкой в сообщении Telegram.
function cleanName(value) {
  if (typeof value !== 'string') return '';
  let s = value.slice(0, 1000).normalize('NFC');
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-');        // типографские тире → дефис
  s = s.replace(/[^\p{L}\s\-'\u2019\u2018\u02BC.]/gu, '');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^[^\p{L}]+/u, '');                    // имя начинается с буквы
  return s.slice(0, 100).trim();
}

// Возраст: целое 16–99. Пусто → '' (как раньше, поле необязательное). null → отклонить.
function cleanAge(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const s = String(value).trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= 16 && n <= 99 ? n : null;
}

// Телефон: остаются только цифры и знаки, которыми пишут номер: + ( ) - пробел
function cleanPhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  // Сначала убираем лишнее, потом ограничиваем длину: иначе номер, перед которым
  // стоит длинная подпись, обрезался бы раньше, чем доходил до цифр.
  return String(value).slice(0, 400).replace(/[^\d+\-() ]/g, '').replace(/^[\s\-]+/, '').trim().slice(0, 40);
}

// Телеграм: необязательная одна @ в начале и [A-Za-z0-9_], не длиннее 64 символов
function cleanTelegram(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim().slice(0, 300);
  const at = s.startsWith('@') ? '@' : '';
  const nick = s.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64 - at.length);
  return nick ? at + nick : '';
}

function cleanLang(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'ru' ? 'ru' : 'uk';
}

function cleanSource(value) {
  if (typeof value !== 'string') return 'landing';
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^-+/, '').slice(0, 50) || 'landing';
}

// Время отправки из браузера (секунды). Остаётся числом — оно нужно Meta и TikTok.
function cleanTimestamp(value) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d{1,12}$/.test(value.trim()) ? Number(value) : NaN);
  return Number.isFinite(n) && n > 0 && n < 1e11 ? Math.floor(n) : '';
}

// Обычная строка: без управляющих символов, с ограничением длины и защитой от формул.
// isAdId = true → значение из одних [A-Za-z0-9._-] возвращается как есть.
function cleanText(value, max, isAdId) {
  if (value === null || value === undefined) return '';
  const type = typeof value;
  if (type !== 'string' && type !== 'number' && type !== 'boolean') return '';
  let s = String(value);
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed(); // битые суррогатные пары
  s = s.replace(CONTROL_CHARS_RE, '').trim().slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);              // обрезали посреди пары
  if (!s) return '';
  if (isAdId && AD_ID_SAFE_RE.test(s)) return s;
  // Апостроф в начале: таблица покажет значение текстом и не станет считать формулу
  return FORMULA_LEAD_RE.test(s) ? "'" + s : s;
}

// Сравнение строк за постоянное время: сравниваются SHA-256 обеих строк,
// поэтому ни длина, ни место первого расхождения по времени ответа не видны.
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
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
  // Защита: секрет в заголовке (задать: wrangler secret put STATUS_KEY).
  // Сравнение за постоянное время — по времени ответа ключ не подобрать.
  const statusKey = request.headers.get('X-Status-Key') || '';
  if (!env.STATUS_KEY || !statusKey || !(await safeEqual(statusKey, env.STATUS_KEY))) {
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
    // Если Make завис, человек не должен бесконечно смотреть на «Отправка…»: через
    // 20 секунд форма получит ошибку и предложит повторить. Ключи дедупликации
    // к этому моменту не записаны, поэтому повтор дойдёт до Make.
    signal: AbortSignal.timeout(20000),
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
      if (fbclid) userData.fbc = `fb.1.${(data.timestamp || Math.floor(Date.now() / 1000)) * 1000}.${fbclid}`;
    } catch(e) {}
  }

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: data.timestamp || Math.floor(Date.now() / 1000),
      event_source_url: data.url || undefined,
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
    signal: AbortSignal.timeout(10000), // фоновая задача не висит дольше 10 секунд
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

// Воркер шлёт события в TikTok, только если это включено явно. Одного токена мало:
// события TikTok идут через Make → /api/tiktok, второй отправитель дал бы дубли.
function tiktokEnabled(env) {
  return Boolean(env.TIKTOK_ACCESS_TOKEN) && String(env.TIKTOK_VIA_WORKER || '').trim() === '1';
}

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
  // Обе проверки выполняются всегда и за постоянное время
  const matchesOwn = env.STATUS_KEY ? await safeEqual(key, env.STATUS_KEY) : false;
  const matchesBuiltIn = await safeEqual(await sha256(key), STATUS_KEY_SHA256);
  return matchesOwn || matchesBuiltIn;
}

async function handleTikTokStatus(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }
  if (!(await statusKeyValid(request, env))) {
    return json({ error: 'Unauthorized' }, 401, corsHeaders);
  }
  if (!tiktokEnabled(env)) {
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