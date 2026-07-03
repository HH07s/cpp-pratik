# C++ Pratik — Canlı Terminal Backend'i

Tarayıcıdaki xterm.js terminali ile gerçek bir `g++` derleyicisi + PTY (sözde-terminal)
arasında çift yönlü WebSocket köprüsü. Program `cin`'e gelince **gerçekten durur**,
kullanıcı yazıp Enter'a basınca devam eder.

```
Tarayıcı (GitHub Pages, xterm.js)
   │  wss://  {run / input / kill}
   ▼
server.js (Node + ws)
   │
   ▼
sandbox.js  ──ya──▶  docker run (izole konteyner, önerilen)      [SANDBOX=docker]
            ──ya──▶  host'ta g++ + ulimit (Docker'sız PaaS)      [SANDBOX=local]
                        │
                        ▼
                    node-pty  ◀── stdin/stdout ──▶  ./main
```

## WebSocket protokolü

| Yön | Mesaj | Açıklama |
|---|---|---|
| İstemci → Sunucu | `{type:"run", code, cols?, rows?}` | Derle + çalıştır (cols/rows opsiyonel PTY boyutu) |
| İstemci → Sunucu | `{type:"input", data}` | Kullanıcının terminale yazdıkları → sürecin stdin'i |
| İstemci → Sunucu | `{type:"kill"}` | Çalışan süreci öldür |
| Sunucu → İstemci | `{type:"status", stage}` | `"compiling"` / `"running"` / `"done"` |
| Sunucu → İstemci | `{type:"stdout", data}` | Program çıktısı (PTY akışı, ANSI dahil) |
| Sunucu → İstemci | `{type:"compile_error", data}` | Derleme hatası (ANSI temizlenmiş) — süreç başlatılmaz |
| Sunucu → İstemci | `{type:"exit", code}` | Süreç bitti |
| Sunucu → İstemci | `{type:"error", message}` | Zaman aşımı, limit, rate-limit vb. |

Sağlık kontrolü: `GET /healthz` → `{"ok":true,"sandbox":"docker","activeRuns":0}`

## Varsayılanlar (ortam değişkenleriyle değiştirilebilir)

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `PORT` | `8080` | HTTP + WS portu |
| `SANDBOX` | `docker` | `docker` ya da `local` |
| `RUNNER_IMAGE` | `cpp-pratik-runner` | docker modunda kullanılan imaj |
| `JOBS_DIR` | os tmp | Geçici kod klasörlerinin kökü |
| `RUN_TIMEOUT_MS` | `10000` | Duvar-saati zaman aşımı (çalıştırma) |
| `COMPILE_TIMEOUT_MS` | `20000` | Derleme zaman aşımı |
| `MAX_OUTPUT_BYTES` | `1048576` | Çıktı limiti (aşılınca süreç öldürülür, bağlantı kapanır) |
| `MAX_CODE_BYTES` | `131072` | Kod boyutu limiti |
| `MAX_CONCURRENT_RUNS` | `4` | Sunucu genelinde eşzamanlı çalıştırma |
| `MIN_RUN_INTERVAL_MS` | `1000` | Bağlantı başına iki çalıştırma arası minimum süre |
| `MEMORY_LIMIT` / `CPU_LIMIT` / `PIDS_LIMIT` | `256m` / `0.5` / `128` | docker modu kaynak limitleri |
| `ALLOWED_ORIGINS` | (boş = hepsi) | Virgüllü liste, ör. `https://kullanici.github.io` |

Derleme komutu: `g++ -O2 -std=c++17 -fdiagnostics-color=never main.cpp -o main`

## Sandbox modu nasıl seçilir?

- **Docker çalıştırabildiğin bir yerdeysen (VPS, kendi makinen):** `SANDBOX=docker`.
  Her derleme/çalıştırma `--network=none --memory=256m --cpus=0.5 --pids-limit=128
  --cap-drop=ALL --security-opt=no-new-privileges --read-only --rm` bayraklarıyla,
  root olmayan kullanıcıyla, salt-okunur mount'la ayrı bir konteynerde koşar. **Önerilen.**
- **Yönetilen PaaS'taysan (Render/Railway/Fly):** bu platformlar konteyner içinde Docker
  çalıştırmana (Docker-in-Docker) **izin vermez** → `SANDBOX=local`. Kod, servis
  konteynerinin içinde root olmayan kullanıcı + `ulimit` + duvar-saati zaman aşımıyla koşar.
  İzolasyon docker moduna göre zayıftır; dış duvar platformun kendi konteneri/microVM'idir.
  Daha sıkı istiyorsan `sandbox.js`'e `bubblewrap`/`nsjail`/`firejail` tabanlı üçüncü bir
  mod eklenebilir — katman bunun için modüler tutuldu (tek dosya, iki uygulama).

## Yerelde çalıştırma

### A) Docker sandbox ile (backend host'ta, kod konteynerde)

```bash
cd backend
npm install                      # node-pty native derlenir (Xcode CLT / build-essential gerekir)
docker build -t cpp-pratik-runner runner
SANDBOX=docker npm start         # :8080
```

macOS + Docker Desktop notu: varsayılan tmp klasörü (`/var/folders/...`) Docker'a mount
edilemeyebilir. Paylaşılan bir yol ver: `JOBS_DIR=$HOME/cpp-jobs mkdir -p $HOME/cpp-jobs && ...`

### B) Tamamen konteynerde (local sandbox — PaaS simülasyonu)

```bash
docker build -t cpp-pratik-backend backend
docker run --rm -p 8080:8080 cpp-pratik-backend
```

### Frontend'i bağla

`index.html` içinde: `const BACKEND_WS_URL = "ws://localhost:8080";`
Sayfayı aç (file:// veya herhangi bir statik sunucu), **⚡ Canlı Çalıştır**'a bas.

Hızlı el testi (tarayıcısız):

```bash
curl http://localhost:8080/healthz
```

## Deploy

> **Mixed content uyarısı:** GitHub Pages **https** olduğundan tarayıcı yalnızca
> **wss://** (TLS'li) backend'e bağlanabilir. Render/Fly/Railway bunu otomatik verir;
> VPS'te bir reverse proxy (Caddy/nginx + Let's Encrypt) gerekir.

### Render (en kolay yol, SANDBOX=local)

1. Repo'yu GitHub'a it. Render → New → **Web Service** → repo'yu seç.
2. Ayarlar: Root Directory `backend`, Environment **Docker** (Dockerfile'ı otomatik bulur).
3. Env: `ALLOWED_ORIGINS=https://<kullanici>.github.io` (önerilir). `SANDBOX=local` imajda hazır.
4. Deploy sonrası adres: `wss://<servis>.onrender.com` → frontend'e yaz.
   - Ücretsiz planda servis uykuya dalar; ilk bağlantı 30–60 sn gecikebilir.

### Railway (SANDBOX=local)

1. Railway → New Project → Deploy from GitHub repo.
2. Service ayarlarında Root Directory: `backend` (Dockerfile otomatik algılanır).
3. Networking → Generate Domain → `wss://<domain>` frontend'e.

### Fly.io (SANDBOX=local — Fly zaten her uygulamayı microVM'de koşturur)

```bash
cd backend
fly launch --no-deploy        # Dockerfile'ı algılar; internal port 8080
fly deploy
# adres: wss://<app>.fly.dev
```

### VPS (önerilen, SANDBOX=docker — tam izolasyon)

```bash
# 1) Docker + Node 18+ kur (Ubuntu örneği)
sudo apt-get update && sudo apt-get install -y docker.io nodejs npm build-essential

# 2) Repo'yu çek, kur
git clone <repo> && cd <repo>/backend
npm install
docker build -t cpp-pratik-runner runner

# 3) systemd servisi
sudo tee /etc/systemd/system/cpp-pratik.service > /dev/null <<'EOF'
[Unit]
Description=cpp-pratik backend
After=docker.service
[Service]
WorkingDirectory=/opt/cpp-pratik/backend
Environment=SANDBOX=docker
Environment=ALLOWED_ORIGINS=https://KULLANICI.github.io
ExecStart=/usr/bin/node server.js
Restart=always
User=cpprun
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now cpp-pratik
# not: cpprun kullanıcısı docker grubunda olmalı: sudo usermod -aG docker cpprun

# 4) TLS reverse proxy (Caddy — en kısa yol)
sudo apt-get install -y caddy
echo 'cpp.alanadi.com {
  reverse_proxy localhost:8080
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
# frontend: const BACKEND_WS_URL = "wss://cpp.alanadi.com";
```

Alternatif: backend'i de konteynerde koşturup host Docker soketini vermek
(`-v /var/run/docker.sock:/var/run/docker.sock`) mümkündür, ama soketi konteynere
vermek fiilen root vermek demektir — sadece tek kullanıcılık kişisel VPS'te,
bilinçli tercihle yapın.

## Güvenlik özeti

- Çalıştırma başına izole konteyner: ağ yok, 256 MB RAM (swap kapalı), 0.5 CPU,
  128 pid, tüm capability'ler düşük, `no-new-privileges`, salt-okunur kök +
  salt-okunur kod mount'u, root olmayan kullanıcı, `--rm` ile otomatik temizlik.
- Duvar-saati zaman aşımı (10 sn) her modda `server.js`'te; derleme için ayrı (20 sn).
- 1 MB çıktı limiti — aşılınca süreç öldürülür ve bağlantı kapatılır (kod 1009).
- Bağlantı başına tek eşzamanlı çalıştırma + 1 sn aralık; sunucu genelinde 4 eşzamanlı iş.
- Kod boyutu 128 KB ile sınırlı; WS `maxPayload` da buna göre ayarlı.
- `ALLOWED_ORIGINS` ile origin süzme (üretimde açın).
- Local modda ek `ulimit`ler: core 0, dosya 10 MB, 64 fd, 256 MB vm (platform destekliyorsa).

## Bilinen kısıtlar / sorun giderme

- `--memory-swap` bazı çekirdeklerde (swap accounting kapalı) uyarı verir; sorun olursa
  `sandbox.js`'ten o satırı kaldırın — `--memory` yine geçerli olur.
- `npm install` sırasında node-pty derlenir: macOS'ta Xcode Command Line Tools,
  Linux'ta `build-essential` + `python3` gerekir (servis Dockerfile'ı bunları içerir).
- Çalıştırmada `posix_spawnp failed` görürsen: npm bazen node-pty'nin `spawn-helper`
  dosyasını çalıştırma izni olmadan çıkarır. Çözüm:
  `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`
- Local modda süreç ağacının tamamı değil PTY'deki ana süreç öldürülür; fork bombasına
  karşı gerçek koruma docker modundaki `--pids-limit`'tir. Halka açık kurulumda docker
  modunu ya da en azından platform konteynerini kullanın; backend'i asla çıplak,
  sınırsız bir makinede herkese açık çalıştırmayın.
