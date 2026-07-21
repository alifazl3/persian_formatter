# Persian Formatter — Pretty Text Viewer

ابزار کلاینت‌ساید برای تمیز و خوانا کردن متن خام (فارسی/انگلیسی): تشخیص عنوان/لیست/کد، رنگ‌آمیزی کد (highlight.js)، جدول مارک‌داون، فرمول ریاضی (KaTeX)، تم روشن/تیره و چیدمان هدر/ساید‌بار. حالا با قابلیت **اشتراک‌گذاری**: متن روی یک Postgres ذخیره و یک لینک کوتاه تولید می‌شود.

## معماری

- **`index.html`** — کل فرانت‌اند (تک‌فایل، استاتیک).
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

## اجرا با Docker Compose (پیشنهادی)

این هم اپ و هم یک Postgres را بالا می‌آورد و جدول `shares` خودکار ساخته می‌شود:

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

> نکته: اگر می‌خواهی به یک Postgres موجود وصل شوی (مثل همان `localhost:6432`)، فقط `DATABASE_URL` را ست کن و سرویس `postgres` در `docker-compose.yml` را حذف کن.

## دیپلوی (Dokploy)

نوع Application → Build Type = `Dockerfile`. متغیر `DATABASE_URL` را به یک Postgres در دسترس وصل کن و دامنه را به پورت کانتینر `80` متصل کن.
