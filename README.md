# Лендинг «Чат-менеджер в офис — Киев»

Одностраничный лендинг для HR lead generation. Стек:
- **HTML + CSS + Vanilla JS** — статика, хостится на Cloudflare Pages
- **Cloudflare Worker** — обработчик формы (Make webhook + Meta CAPI)

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

# ID пикселя (для CHATI2v1 это 1237613791688649)
npx wrangler secret put FB_PIXEL_ID

# Access Token для CAPI: Events Manager → Settings → Generate Access Token
npx wrangler secret put FB_ACCESS_TOKEN

# Твой домен лендинга (важно для CORS!)
npx wrangler secret put ALLOWED_ORIGIN
# → введи: https://YOUR-DOMAIN.com
```

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

### Шаг 6. Запусти tail-логи для проверки

```bash
npx wrangler tail
```

Отправь тестовую заявку — в консоли увидишь лог с результатом Make + CAPI.

---

## 🧪 Как проверить что всё работает

1. **Форма → Make** — зайди в Make сценарий, отправь заявку, убедись что в Google Sheets появилась строка
2. **Форма → Meta Pixel** — Events Manager → Test Events → вставь свой домен → заполни форму → событие `Lead` должно прилететь
3. **Форма → CAPI** — Events Manager → Overview → в графике `Lead` должны быть события с пометкой **Server** (не только Browser)
4. **Lighthouse** — Chrome DevTools → Lighthouse → Run audit. Цель: 90+ по всем параметрам

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
