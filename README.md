# C++ Pratik

- `index.html` — frontend (GitHub Pages'te statik yayınlanır). Batch "Çalıştır" ve
  "Testleri Çalıştır" Godbolt (Compiler Explorer) API'siyle çalışır; **⚡ Canlı Çalıştır**
  butonu WebSocket + PTY backend'ine bağlanıp gerçek zamanlı `cin` girdisi sağlar.
  (Not: eski Piston/emkc.org API'si Şubat 2026'da whitelist-only olduğu için batch
  katmanı Godbolt'a taşındı — `execute`/`interpret` imzaları korunarak.)
- `backend/` — canlı terminal backend'i (Node + ws + node-pty). Kurulum, güvenlik ve
  deploy adımları için [backend/README.md](backend/README.md).

Canlı modu açmak için `index.html` içindeki tek sabiti doldur:

```js
const BACKEND_WS_URL = "wss://<backend-adresin>"; // boşsa buton pasif kalır
```
