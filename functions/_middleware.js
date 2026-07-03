// Cloudflare Pages Function — автоопределение языка
// Украинский браузер → / (uk), русский → /ru/ (ru).
// Срабатывает ТОЛЬКО на корневой документ (/ или /index.html), метод GET.
// /ru/..., статика и уже выбранный язык (cookie pref_lang) — не трогаем.

const COOKIE_ATTRS = 'Path=/; Max-Age=31536000; SameSite=Lax';

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Перехватываем только корневой украинский документ и только GET.
  // Всё остальное (/ru/, /images, /favicon, /logo, /og-image,
  // /robots.txt, /sitemap.xml, /privacy.html и т.д.) проходит насквозь.
  const isRoot = path === '/' || path === '/index.html';
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
