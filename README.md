# Persian Formatter — Pretty Text Viewer

ابزار سادهٔ کلاینت‌ساید برای تمیز و خوانا کردن متن خام (فارسی/انگلیسی). متن را Paste می‌کنی و خروجی بخش‌بندی‌شده، با تشخیص عنوان/لیست/کد نمایش داده می‌شود.

## اجرا به‌صورت محلی

چون اپ کاملاً استاتیک است، کافی است `index.html` را در مرورگر باز کنی، یا:

```bash
python3 -m http.server 8000
# http://localhost:8000
```

## دیپلوی (Docker / Dokploy)

پروژه با یک `Dockerfile` بر پایهٔ nginx سرو می‌شود.

```bash
docker build -t persian-formatter .
docker run -p 8080:80 persian-formatter
# http://localhost:8080
```

در Dokploy: نوع Application → Build Type = `Dockerfile` → دامنه را به پورت کانتینر `80` متصل کن.
