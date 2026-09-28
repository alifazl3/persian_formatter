# Persian Formatter — Pretty Text Viewer

ابزار تمیز و خوانا کردن متن خام (فارسی/انگلیسی): تشخیص عنوان/لیست/کد، رنگ‌آمیزی کد (highlight.js)، جدول مارک‌داون، فرمول ریاضی (KaTeX)، تم روشن/تیره و چیدمان هدر/ساید‌بار. می‌توان متن را ذخیره کرد، در فولدر قرار داد و لینک اشتراک ساخت. همهٔ این کارها بدون ورود هم در دسترس‌اند.

## معماری

- **`index.html`، `library.js`، `library.css`** — رابط فرمت‌کننده، کتابخانه و حساب.
- **`server/`** — API روی Node.js + TypeScript با معماری سه‌لایه:
  - `handlers/` — لایهٔ HTTP (تبدیل request/response).
  - `services/` — منطق کسب‌وکار (اعتبارسنجی، تولید id، شمارش بازدید).
  - `repositories/` — دسترسی به داده (Postgres).
  - بقیه: `domain/` (تایپ‌ها)، `db/` (pool + migration)، `config.ts`، `errors.ts`، `middleware/`.

سرور هم `index.html` را سرو می‌کند و هم این API را:

| Method | Path | کار |
|--------|------|-----|
| `POST` | `/api/shares` | ذخیرهٔ `{ content }` → `{ id, url }` |
| `GET`  | `/api/shares/:id` | خواندن یک share |
| `POST` | `/api/shares/:id/reports` | ثبت گزارش مشکل بیننده روی صفحهٔ اشتراکی، با `{ note? }` اختیاری |
| `GET`  | `/api/reports` | فهرست گزارش‌ها (ادمین)؛ نیاز به هدر `x-admin-token` برابر `ADMIN_TOKEN`. بدون ست بودن `ADMIN_TOKEN` غیرفعال است |
| `GET`  | `/s/:id` | همان SPA؛ کلاینت id را از مسیر می‌خواند و محتوا را fetch می‌کند |
| `GET` | `/api/identity` | ساخت نشست مهمان یا خواندن ایمیل حساب جاری |
| `POST` | `/api/auth/register/options` و `/verify` | ساخت حساب با ایمیل و passkey |
| `POST` | `/api/auth/login/options` و `/verify` | ورود با ایمیل و passkey |
| `POST` | `/api/auth/logout` | خروج |
| `GET` | `/api/library` | فهرست فولدرها و متن‌های کاربر یا مهمان |
| `POST`، `PATCH`، `DELETE` | `/api/items` و `/api/items/:id` | ذخیره، ویرایش، انتقال و حذف متن |
| `POST`، `PATCH`، `DELETE` | `/api/folders` و `/api/folders/:id` | ساخت، تغییر نام و حذف فولدر |
| `POST`، `GET`، `DELETE` | `/api/folders/:id/links` | ساخت، فهرست و لغو لینک فولدر؛ فقط مالک |
| `POST` | `/api/folder-links/:token/redeem` | استفاده از لینک و دریافت مجوز موقت |
| `GET` | `/f/:token` | باز کردن فولدر اشتراکی |

ذخیرهٔ مهمان با کوکی نشست انجام می‌شود و تا ۹۰ روز در همان مرورگر در دسترس است. با ورود، متن‌ها و فولدرهای مهمان به حساب منتقل می‌شوند. ایمیل فقط شناسهٔ حساب است؛ ایمیل تأیید ارسال نمی‌شود. برای ورود دوباره، passkey لازم است. مرورگر و دامنه باید از WebAuthn پشتیبانی کنند (HTTPS یا `localhost`).

لینک فولدر می‌تواند فقط‌خواندنی یا دارای دسترسی کامل باشد. دسترسی کامل اجازهٔ افزودن، ویرایش و حذف متن و نیز تغییر نام یا حذف فولدر را می‌دهد؛ ساخت و لغو لینک فقط در اختیار مالک است. لینک یک‌بارمصرف هنگام نخستین باز کردن مصرف می‌شود و به بازکننده مجوز ۲۴ ساعته می‌دهد تا بتواند صفحه را دوباره بارگذاری کند. لینک چندبارمصرف را می‌توان چند بار باز کرد. لغو لینک، مجوزهای صادرشده از آن را هم باطل می‌کند. آدرس کامل لینک فقط هنگام ساخت نمایش داده می‌شود.

## اجرا با Docker Compose (پیشنهادی)

این هم اپ و هم یک Postgres را بالا می‌آورد و جدول‌ها خودکار ساخته می‌شوند:

```bash
docker compose up --build
# http://localhost:8080
```

## اجرای لوکالِ بک‌اند (بدون Docker)

نیاز به یک Postgres در دسترس:

```bash
cd server
npm install
export DATABASE_URL="postgres://postgres:mysecretpassword@localhost:5432/persian_formatter"
export PUBLIC_DIR="$(cd .. && pwd)"   # جایی که index.html هست
npm run dev          # یا: npm run build && npm start
# http://localhost:3000
```

### متغیرهای محیطی

| Env | پیش‌فرض | توضیح |
|-----|---------|-------|
| `PORT` | `3000` | پورت سرور |
| `DATABASE_URL` | `postgres://postgres:mysecretpassword@localhost:5432/persian_formatter` | اتصال Postgres |
| `PUBLIC_DIR` | ریشهٔ مخزن | پوشهٔ شامل `index.html` |
| `MAX_CONTENT_LENGTH` | `200000` | حداکثر طول متن قابل اشتراک |
| `ADMIN_TOKEN` | *(خالی)* | توکن هدر `x-admin-token` برای `GET /api/reports`؛ خالی = endpoint غیرفعال |
| `WEBAUTHN_ORIGIN` | مبدأ درخواست | مبدأ دقیق مرورگر، مانند `https://example.com`؛ برای دیپلوی پشت پراکسی تنظیم شود |
| `WEBAUTHN_RP_ID` | دامنهٔ `WEBAUTHN_ORIGIN` | دامنهٔ ثبت passkey، بدون پروتکل و پورت |

> نکته: اگر می‌خواهی به یک Postgres موجود وصل شوی (مثل همان `localhost:6432`)، فقط `DATABASE_URL` را ست کن و سرویس `postgres` در `docker-compose.yml` را حذف کن.

## دیپلوی (Dokploy)

نوع Application → Build Type = `Dockerfile`. متغیر `DATABASE_URL` را به یک Postgres در دسترس وصل کن و دامنه را به پورت کانتینر `80` متصل کن. برای passkey، `WEBAUTHN_ORIGIN` را با آدرس HTTPS نهایی و `WEBAUTHN_RP_ID` را با نام همان دامنه تنظیم کن.
