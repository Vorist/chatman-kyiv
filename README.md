# Лендинг «Чат-менеджер в офис — Киев»

Одностраничный лендинг для HR lead generation. Стек:
- **HTML + CSS + Vanilla JS** — статика, хостится на Cloudflare Pages
- **Cloudflare Worker** — обработчик формы (Make webhook + Meta CAPI + TikTok Events API)

## 📁 Структура проекта

```
landing-job/
├── index.html              ← главный файл лендинга
├── favicon.svg             ← иконка в таб браузера
├── robots.txt              ← для поисковиков
├── _headers                ← HTTP-заголовки для Cloudflare Pages
├── .gitignore
├── README.md               ← этот файл
│
├── images/                 ← скриншоты отзывов
│   ├── review-1.jpg        ← (добавь сам)
│   ├── review-2.jpg        ← (добавь сам)
│   └── ...
│
└── worker/                 ← Cloudflare Worker (деплоится отдельно)
    ├── wrangler.toml       ← конфиг Worker
    ├── package.json
    ├── .dev.vars.example   ← шаблон env-переменных
    └── src/
        └── index.js        ← код обработчика формы
```

## 🚀 Деплой: быстрый путь (30 минут)

### Шаг 1. Купи домен (~$10/год)

Рекомендую: [Namecheap](https://namecheap.com) или [Porkbun](https://porkbun.com).
Примеры: `job-kyiv.com`, `chat-manager.work`, `kyiv-office.co`.

### Шаг 2. Добавь домен в Cloudflare (бесплатно)

1. Создай аккаунт на [cloudflare.com](https://cloudflare.com)
2. **Add site** → введи домен → выбери **Free план**
3. Cloudflare даст тебе 2 NS-сервера — пропиши их у регистратора домена
4. Подожди ~5–30 минут пока DNS обновится

### Шаг 3. Задеплой статику на Cloudflare Pages

**Вариант А: через Git (рекомендую)**

1. Залей папку `landing-job/` на GitHub/GitLab (публичный или приватный — неважно)
2. В Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. Выбери репозиторий, в настройках сборки:
   - **Build command:** (пусто)
   - **Build output directory:** `/` (или имя папки если лежит внутри)
4. **Save and Deploy**
5. Через ~1 минуту получишь URL вида `landing-job.pages.dev` — открой, должно работать

**Вариант Б: через Direct Upload (если не хочешь Git)**

1. В Dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**
2. Перетащи всю папку `landing-job/` (кроме папки `worker/`)
3. Получишь такой же URL

### Шаг 4. Подключи свой домен к Pages

В настройках Pages проекта → **Custom domains** → **Set up a custom domain** → введи свой домен.
SSL-сертификат подключится автоматически.

### Шаг 5. Добавь скриншоты отзывов

Положи файлы в `/images/` с именами `review-1.jpg`, `review-2.jpg` и т.д.
Пока файлов нет — на их месте показываются плейсхолдеры с именем файла (удобно для отладки).

### Шаг 6. Замени плейсхолдеры в `index.html`

Открой `index.html` и найди по поиску `YOUR-DOMAIN.com` — замени на свой домен в:
- `<link rel="canonical">`
- `<meta property="og:url">`
- `<meta property="og:image">` (и создай `og-image.jpg` 1200×630 в корне)

Также в `robots.txt` замени домен в Sitemap.

---

## 🔧 Деплой Cloudflare Worker (для обработки формы)

### Шаг 1. Установи wrangler CLI

```bash
cd landing-job/worker
npm install
```

### Шаг 2. Залогинься в Cloudflare

```bash
npx wrangler login
```

Откроется браузер, подтверди доступ.

### Шаг 3. Задай секреты

```bash
# URL твоего Make.com webhook (копируй из Make сценария)
npx wrangler secret put MAKE_WEBHOOK_URL

# ID пикселя: тот же, что в fbq('init', ...) на странице (для CHATI2v1 это 2160949541347107).
# Если ID здесь и на странице разойдутся, серверные и браузерные события перестанут склеиваться.
npx wrangler secret put FB_PIXEL_ID

# Access Token для CAPI: Events Manager → Settings → Generate Access Token
npx wrangler secret put FB_ACCESS_TOKEN

# Твой домен лендинга (важно для CORS!)
npx wrangler secret put ALLOWED_ORIGIN
# → введи: https://YOUR-DOMAIN.com

```

### TikTok: серверные события

Серверные события TikTok (Events API) идут **не через Worker**, а через функцию сайта
`functions/api/tiktok.js` (адрес `/api/tiktok`), которая выкладывается сама вместе с сайтом:

- **Заявка** — сценарий Make «Landing chatman-kyiv» после записи в таблицу и уведомления
  в Telegram шлёт заявку на `/api/tiktok` (`kind=lead`) → событие `Lead` с тем же `event_id`,
  что у пикселя в браузере (TikTok склеивает пару).
- **Статусы** — сценарий Make «Landing ЧАТЫ → TikTok Events API» раз в 3 часа шлёт новые
  статусы из таблицы (`kind=status`): Qualified → `CompleteRegistration`,
  Converted → `ApplicationApproval`. Отправленный статус пишется в колонку P (`TT_Last_Status`).

Токен TikTok лежит только в этих двух сценариях Make (заголовок `X-TikTok-Token`).
В коде, в репозитории и в Cloudflare его нет — не добавляй его туда: всё, что лежит
в репозитории, доступно по адресу сайта. Секрет `TIKTOK_ACCESS_TOKEN` в Worker задавать
не нужно. Даже если он там есть (остался со старых времён), Worker в TikTok ничего не шлёт,
пока явно не задано `TIKTOK_VIA_WORKER=1`: иначе `Lead` уходил бы в TikTok дважды, из Worker и из Make.

Проверить, что выкатилась новая версия Worker: в ответе есть заголовок
`X-Worker-Version` (например, `curl -i -X OPTIONS https://…workers.dev`).

### Шаг 4. Деплой Worker

```bash
npx wrangler deploy
```

Получишь URL вида: `https://chatmanager-lead-worker.YOUR_SUBDOMAIN.workers.dev`

### Шаг 5. Подключи Worker к лендингу

Открой `index.html`, найди:

```js
const WORKER_URL = 'YOUR_WORKER_NAME';
```

Замени на URL Worker'а. Передеплой лендинг на Pages.

> ⚠️ Адрес воркера записан в трёх местах, менять нужно все три в одном коммите:
> `WORKER_URL` в `index.html`, `WORKER_URL` в `ru/index.html` и `connect-src` в `_headers`.
> Если в `_headers` останется старый адрес, браузер заблокирует отправку формы и заявки перестанут приходить.

### Шаг 6. Запусти tail-логи для проверки

```bash
npx wrangler tail
```

Отправь тестовую заявку — в консоли увидишь лог с результатом Make + CAPI.

---

## 🛡 Защита сайта

- **Счётчики только на своём адресе.** GA4, тег Google Ads, пиксели Meta и TikTok включаются, только если страница открыта на chatman-kyiv.com (с www или без). Проверка идёт по контрольной сумме имени хоста в начале блока аналитики в `index.html` и `ru/index.html`. Если страницу скопируют на чужой домен, копия ничего не пришлёт в наши кабинеты. Предпросмотр веток на `*.pages.dev` поэтому тоже работает без счётчиков, это ожидаемо.
- **Смена домена.** Контрольную сумму нужно пересчитать и заменить число в обоих файлах. Имя пишется строчными латинскими буквами, без `www` и без `https://`, ровно так, как его показывает адресная строка. Домен кириллицей нужно брать в виде `xn--...`. Ошибка в любой букве молча выключит всю аналитику.

  ```bash
  python3 -c "
  x = 5381
  for c in 'new-domain.com': x = ((x << 5) + x + ord(c)) & 0xFFFFFFFF
  print(x)"
  ```

  Вместе с числом поменяй домен ещё в трёх местах: `MAIN_HOST` в `functions/_middleware.js`, строку `Access-Control-Allow-Origin` в `_headers` и `SITE_ORIGINS` в `worker/src/index.js` (после этого воркер нужно выложить заново).
- **Идентификаторы привязаны к домену.** В коде страниц нет идентификаторов GA4, Google Ads, Meta и TikTok открытым текстом: они записаны шестнадцатеричной строкой и расшифровываются по имени хоста. На chatman-kyiv.com получаются настоящие значения, на любом другом домене мусор, даже если проверку адреса вырезать. Чтобы заменить идентификатор, получи новую строку и вставь её в `ownId('...')` в `index.html` и `ru/index.html`:

  ```bash
  node -e "const h='chatman-kyiv.com';console.log([...process.argv[1]].map((c,i)=>(c.charCodeAt(0)^h.charCodeAt(i%h.length)).toString(16).padStart(2,'0')).join(''))" НОВЫЙ_ID
  ```

  Сейчас зашиты: GA4 `G-8ST25GZQJL`, Google Ads `AW-18165279501`, пиксель Meta `2160949541347107`, пиксель TikTok `D7P7523C77U02PK9RRH0`. При смене домена все четыре строки нужно получить заново с новым именем вместо `chatman-kyiv.com`.
- **Воркер принимает заявки только со своего сайта.** Основной адрес, www и адреса из `ALLOWED_ORIGIN`. Запрос с чужого сайта, из скрипта без заголовка Origin или с тестовой сборки `*.pages.dev` получает 403. Чужие адреса, с которых страница пыталась отправить форму, видны в логах воркера строкой `Preflight rejected: origin`.
- **Служебные файлы закрыты.** `functions/_middleware.js` отвечает 404 на `/worker/*`, `/README.md`, `/.claude/*` и другие файлы репозитория. Pages публикует весь репозиторий как сайт, без этой проверки их мог скачать кто угодно.
- **Запасные адреса → основной.** `www.chatman-kyiv.com`, служебный `chatman-kyiv.pages.dev` и адрес с точкой на конце перенаправляются на chatman-kyiv.com: только там работают счётчики и форма. Тестовые сборки веток (`имя-ветки.chatman-kyiv.pages.dev`) не перенаправляются.
- **Заголовки** (`_headers`): запрет встраивания страницы во фрейм, строгий CSP, HSTS.

## 🧪 Как проверить что всё работает

1. **Форма → Make** — зайди в Make сценарий, отправь заявку, убедись что в Google Sheets появилась строка
2. **Форма → Meta Pixel** — Events Manager → Test Events → вставь свой домен → заполни форму → событие `Lead` должно прилететь
3. **Форма → CAPI** — Events Manager → Overview → в графике `Lead` должны быть события с пометкой **Server** (не только Browser)
4. **Форма → TikTok** — TikTok Events Manager → пиксель → Test Events: событие `Lead` должно прийти и из браузера, и с сервера (Events API) с одинаковым `event_id`. Для серверной проверки добавь в запрос на `/api/tiktok` поле `test_event_code` с кодом со вкладки Test Events
5. **Lighthouse** — Chrome DevTools → Lighthouse → Run audit. Цель: 90+ по всем параметрам

---

## ✏️ Как менять контент

| Что поменять        | Где искать                                                                 |
|---------------------|----------------------------------------------------------------------------|
| Заголовок Hero      | `index.html` → `<h1 class="hero-title">`                                   |
| Буллиты в Hero      | `index.html` → `<ul class="bullets">`                                      |
| Поля формы          | `index.html` → `<form id="leadForm">`                                      |
| Текст в блоке цифр  | `index.html` → `<section class="stats">`                                   |
| Вопросы FAQ         | `index.html` → `<section class="faq">` → `<div class="faq-item">`          |
| Цвета/шрифты        | `index.html` → `<style>` → `:root { --accent: #FF5A1F; ... }`              |
| Количество отзывов  | `index.html` → `<div class="marquee">` (добавь блок + продублируй в дубле) |

---

## 🌆 Адаптация под второй город (Днепр)

Скопируй папку: `landing-job/` → `landing-job-dnipro/`

В копии замени:
- Тексты с «Киев» на «Днепр»
- `ALLOWED_ORIGIN` в Worker секретах (или сделай **второй** Worker)
- Пиксель остаётся тот же (CHATI2v1 — он shared между городами)
- Контрольную сумму домена и остальные места из раздела «Защита сайта» → «Смена домена». Без этого копия на новом домене не отправит в аналитику ни одного события

Задеплой как отдельный Pages проект на поддомен `dnipro.job-kyiv.com` или
отдельный домен.

---

## 💰 Стоимость

| Сервис              | План       | Цена     |
|---------------------|------------|----------|
| Домен               | —          | ~$10/год |
| Cloudflare Pages    | Free       | $0       |
| Cloudflare Worker   | Free       | $0 (до 100k запросов/день) |
| **Итого**           |            | **~$10/год** |
