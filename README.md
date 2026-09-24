# TMSZ — tmsz.net

موقع TMSZ للخدمات التقنية: صفحة واحدة ثابتة (HTML/CSS/JS) بدون أي مكتبات أو بناء.

## الهيكل
```
public_html/          ← ارفع محتويات هذا المجلد إلى public_html على الاستضافة
├── index.html
├── .htaccess         ← ضغط، كاش، ترويسات أمان (تحويل HTTPS معطّل افتراضياً)
├── robots.txt
├── sitemap.xml
└── assets/
    ├── css/style.css
    ├── js/main.js
    └── img/ (favicon.svg, og.svg, og.png)
store                 ← CSS مخصص لمتجر سلة (منفصل عن الموقع)
```

## الرفع على الاستضافة (إنجازي)
1. خذ نسخة احتياطية من `public_html` الحالي من مدير الملفات.
2. ارفع محتويات مجلد `public_html/` من هذا المستودع (مع الملف المخفي `.htaccess`).
3. بعد التأكد من تفعيل SSL، فعّل أسطر تحويل HTTPS في `.htaccess`.

## التعديل
- بيانات التواصل (واتساب/تيليجرام/البريد) داخل `index.html`.
- الألوان في أعلى `assets/css/style.css` ضمن `:root`.
- الكلمات المتحركة في العنوان: الخاصية `data-words` في `index.html`.

## المعاينة محلياً
```
cd public_html && python3 -m http.server 8000
```
