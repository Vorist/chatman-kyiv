// Cloudflare Pages Function — общий «привратник» сайта.
//
// 1. Служебные файлы репозитория (исходник воркера, README, настройки) посетителям
//    не отдаются: в ответ 404. Pages публикует весь репозиторий как сайт, поэтому
//    без этой проверки их мог скачать кто угодно.
// 2. Запасные адреса сайта (www, служебный chatman-kyiv.pages.dev, адрес с точкой на конце)
//    ведут на основной chatman-kyiv.com: только на нём работают счётчики и форма.
//    Тестовые сборки веток (что-то.chatman-kyiv.pages.dev) не трогаем.
// 3. Автоопределение языка: украинский браузер → / (uk), русский → /ru/ (ru).
//    Срабатывает ТОЛЬКО на корневой документ (/ или /index.html), метод GET.
//    /ru/..., статика и уже выбранный язык (cookie pref_lang) — не трогаем.

const COOKIE_ATTRS = 'Path=/; Max-Age=31536000; SameSite=Lax';
const MAIN_HOST = 'chatman-kyiv.com';
// Запасные адреса того же сайта → 301 на основной (сравнение точное, без масок)
const ALIAS_HOSTS = ['www.' + MAIN_HOST, 'chatman-kyiv.pages.dev'];

// Что закрыто от посетителей. Проверяется уже раскодированный путь без повторов «/».
const PRIVATE_PATHS = [
  /^\/worker(\/|$)/i,                       // исходник и настройки воркера заявок
  /^\/functions(\/|$)/i,                    // исходники функций сайта
  /^\/node_modules(\/|$)/i,
  /(^|\/)\.(?!well-known(\/|$))[A-Za-z0-9_][^\/]*/, // .claude, .git, .env и любые dot-файлы (кроме /.well-known/)
  /\.(md|toml|lock|map|log|bak|sh|ya?ml|env|ini)$/i,
  /(^|\/)package(-lock)?\.json$/i,
  /^\/images\/readme\.txt$/i,
  /^\/_(headers|redirects|routes\.json|worker\.js)$/i,
];

function isPrivatePath(pathname) {
  let p = pathname;
  try { p = decodeURIComponent(pathname); } catch (e) { /* битое %-кодирование — проверяем как есть */ }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return PRIVATE_PATHS.some((re) => re.test(p));
}

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (isPrivatePath(path)) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    });
  }

  // Запасной адрес → основной (только чтение страниц; запросы к /api/ не трогаем).
  // «chatman-kyiv.com.» с точкой на конце — тот же сайт, но для браузера это другой адрес.
  const rawHost = url.hostname.toLowerCase();
  const host = rawHost.replace(/\.$/, '');
  const isAlias = ALIAS_HOSTS.includes(host) || (host === MAIN_HOST && rawHost !== MAIN_HOST);
  if (isAlias && (request.method === 'GET' || request.method === 'HEAD')) {
    return Response.redirect('https://' + MAIN_HOST + path + url.search, 301);
  }

  // Перехватываем только корневой украинский документ и только GET.
  // Всё остальное (/ru/, /images, /favicon, /logo, /og-image,
  // /robots.txt, /sitemap.xml, /privacy.html и т.д.) проходит насквозь.
  const isRoot = path === '/' || path === '/index.html';

  // Форма отправляется скриптом страницы. Если скрипт не сработал (выключен JavaScript),
  // браузер шлёт форму сам, POST-ом на адрес страницы. Вместо пустой страницы с ошибкой 405
  // возвращаем человека на ту же страницу. Данные формы при этом никуда не сохраняются.
  if (request.method === 'POST' && (isRoot || path === '/ru/' || path === '/ru/index.html')) {
    return Response.redirect(url.origin + path + url.search, 303);
  }

  if (request.method !== 'GET' || !isRoot) {
    return next();
  }

  // Уже выбранный язык уважаем без раздумий.
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pref_lang=(ru|uk)(?:;|$)/);
  const pref = match ? match[1] : null;

  if (pref === 'ru') {
    // сохраняем query (?utm_*, fbclid, gclid…), чтобы атрибуция не терялась
    return Response.redirect(new URL('/ru/' + url.search, url).toString(), 302);
  }
  if (pref === 'uk') {
    return next();
  }

  // Cookie нет → смотрим Accept-Language, берём первый языковой тег.
  const accept = (request.headers.get('Accept-Language') || '').toLowerCase();
  const firstTag = accept.split(',')[0].trim();

  if (firstTag.startsWith('ru')) {
    return new Response(null, {
      status: 302,
      headers: {
        // сохраняем query (?utm_*, fbclid, gclid…), чтобы атрибуция не терялась
        'Location': new URL('/ru/' + url.search, url).toString(),
        'Set-Cookie': `pref_lang=ru; ${COOKIE_ATTRS}`,
        'Cache-Control': 'no-store',
      },
    });
  }

  // uk / en / любое другое → отдаём украинскую версию и фиксируем выбор.
  const response = await next();
  const res = new Response(response.body, response);
  res.headers.append('Set-Cookie', `pref_lang=uk; ${COOKIE_ATTRS}`);
  return res;
}
