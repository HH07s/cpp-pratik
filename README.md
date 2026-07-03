# C++ Pratik

Tarayıcıdan çalışan, **canlı interaktif terminalli** bir C++ derleyici ve pratik platformu.
Kod yaz, çalıştır, programın `cin`'e gelince **gerçekten dursun** — tıpkı kendi
makinendeki terminal gibi, ama kurulum yok.

🔗 **Canlı demo:** https://hh07s.github.io/cpp-pratik/

> Not: Backend ücretsiz katmanda barındırıldığı için boşta kalınca uyur; ilk
> "Çalıştır" ~30-50 sn sürebilir (sunucu uyanır), sonrası anında çalışır.

---

## Ne yapar?

İki modu var, üstteki menüden geçiş yapılır:

### 🖥️ Compiler — serbest derleyici
İstediğin C++ kodunu yaz, **Çalıştır**'a bas. Kod uzak bir sunucuda derlenir ve
gerçek bir PTY (sözde-terminal) üzerinde çalışır; çıktı WebSocket ile tarayıcıdaki
xterm.js terminaline canlı akar. `cin` gerektiren programlar terminalde girdi bekler
ve sen yazınca devam eder. Kodun tarayıcıda (localStorage) otomatik saklanır.

### 📚 Soru Çöz — pratik + otomatik değerlendirme
Kullanıcı kendi sorularını ekler (başlık, açıklama, ipucu, başlangıç kodu ve
`{girdi → beklenen çıktı}` test çiftleri). **Testleri Çalıştır** ile çözüm, tüm
testlere karşı otomatik değerlendirilir; hepsi geçerse soru "çözüldü" işaretlenir.
İlerleme ve sorular tarayıcıda saklanır, JSON olarak dışa/içe aktarılabilir.

---

## Mimari

```
Tarayıcı  (GitHub Pages — statik: CodeMirror editörü + xterm.js terminali)
   │
   ├─ Batch  ── HTTPS ─────▶  Godbolt (Compiler Explorer) API      (Testleri Çalıştır)
   │
   └─ Canlı  ── wss:// ────▶  server.js  (Node + ws)               (Compiler / canlı çalıştırma)
                                 │   {run · input · kill} ⇄ {status · stdout · exit · error}
                                 ▼
                              sandbox.js  ── node-pty ──▶  g++ derle + ./main çalıştır
                                 │
                                 ├─ SANDBOX=docker : her çalıştırma ayrı, kısıtlı konteynerde (VPS)
                                 └─ SANDBOX=local  : host'ta g++ + ulimit (Render/Fly gibi PaaS)
```

- **Frontend** tek bir statik `index.html` — bağımlılıklar CDN'den (CodeMirror, xterm.js).
  GitHub Pages'te barınır, indirme/kurulum gerektirmez.
- **Backend** (`backend/`) Node + `ws` + `node-pty`. Batch "Testleri Çalıştır" katmanı
  Godbolt API kullanır (backend gerektirmez); canlı terminal ise backend'e bağlanır.

Frontend'i backend'e bağlayan tek sabit `index.html` içinde:

```js
const BACKEND_WS_URL = "wss://<backend-adresin>"; // boşsa canlı mod pasif kalır
```

---

## Teknolojiler

| Katman | Teknoloji |
|---|---|
| Editör | CodeMirror 5 (C++ modu, satır kaydırma) |
| Terminal | xterm.js + fit-addon |
| Batch derleme | Godbolt (Compiler Explorer) API |
| Canlı köprü | WebSocket (`ws`) |
| PTY / süreç | `node-pty` → `g++ -O2 -std=c++17` |
| İzolasyon | Docker (VPS) veya platform konteyneri/microVM (PaaS) |
| Barındırma | GitHub Pages (frontend) + Render (backend) |

---

## Güvenlik

Halka açık kod çalıştırma için katmanlı korumalar:

- **İzole çalıştırma** — `SANDBOX=docker` modunda her çalıştırma ayrı konteynerde:
  `--network=none` (ağ yok), `--cap-drop=ALL`, salt-okunur kök, root olmayan kullanıcı,
  `--memory` / `--cpus` / `--pids-limit`, `--rm` ile otomatik temizlik.
- **Duvar-saati zaman aşımı** (çalıştırma 10 sn, derleme 20 sn).
- **Çıktı limiti** (1 MB — aşılınca süreç öldürülür, bağlantı kapatılır).
- **Rate limit + eşzamanlılık** (bağlantı başına tek çalıştırma + minimum aralık;
  sunucu genelinde eşzamanlı iş sınırı) ve **kod boyutu limiti** (128 KB).
- **Origin süzme** — `ALLOWED_ORIGINS` ile yalnızca izinli site bağlanabilir.

Ayrıntılar ve dağıtım rehberi: [backend/README.md](backend/README.md).

---

## Yerel geliştirme

```bash
# Backend (canlı terminal için) — Linux/WSL/macOS
cd backend
npm install                       # node-pty native derlenir (build-essential/Xcode CLT gerekir)
docker build -t cpp-pratik-runner runner   # SANDBOX=docker kullanacaksan
SANDBOX=docker npm start          # ya da SANDBOX=local npm start  → :8080

# Frontend
# index.html içinde: const BACKEND_WS_URL = "ws://localhost:8080";
# ardından statik bir sunucuyla aç, örn:
python3 -m http.server 8765       # → http://localhost:8765
```

Sağlık kontrolü: `curl http://localhost:8080/healthz`

---

## Dağıtım (özet)

- **Frontend → GitHub Pages:** repo public olmalı (ücretsiz planda), Settings → Pages →
  Deploy from branch `main` /root. Statik site olduğu için kökte boş bir **`.nojekyll`**
  dosyası bulunur (Jekyll işlemesini kapatır).
- **Backend → Render (ücretsiz):** New → Web Service → repo → Root Directory `backend`,
  Docker, Free; env `ALLOWED_ORIGINS=https://<kullanici>.github.io`. Adres `wss://...` olarak
  `BACKEND_WS_URL`'e yazılır. (Render docker-in-docker vermediği için `SANDBOX=local` kullanır.)
- Tam izolasyon (`SANDBOX=docker`) için VPS + reverse proxy seçeneği: [backend/README.md](backend/README.md).
