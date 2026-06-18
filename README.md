# CS AI Sukumba

Sistem customer service AI untuk brand Sukumba. Project ini menggabungkan admin panel, AI service, dan WhatsApp gateway agar customer bisa dilayani otomatis lewat WhatsApp, sementara tim admin tetap bisa mengelola produk, FAQ, testimoni, template CS, order, closingan, log percakapan, dan konfigurasi AI dari dashboard.

## Ringkasan

Repository ini terdiri dari 3 service utama:

| Service | Folder | Port | Teknologi | Fungsi |
| --- | --- | --- | --- | --- |
| Admin Panel | `admin-panel/` | `5001` | Flask, SQLite | Dashboard admin, data produk/FAQ/testimoni/template, order, closingan, analytics, riwayat chat, integrasi Telegram, proxy WhatsApp |
| AI Service | `ai-service/` | `5000` | Flask, Waitress | Orkestrasi agent AI, deteksi intent, konsultasi, informasi produk, order flow, parsing closingan, notifikasi order |
| WA Gateway | `wa-gateway/` | `3000` | Node.js, Express, Baileys | Koneksi WhatsApp, QR login, menerima/mengirim pesan, menyimpan history, meneruskan chat ke AI |

Data utama disimpan di SQLite pada folder `data/`, sehingga container bisa di-rebuild tanpa menghapus database selama volume tetap dipakai.

## Fitur Utama

- Dashboard admin berbasis web dengan login password.
- Manajemen produk Sukumba, FAQ, testimoni, dan template jawaban CS.
- Test AI langsung dari panel admin.
- Integrasi WhatsApp menggunakan Baileys.
- QR WhatsApp bisa dipantau dari admin panel.
- AI chat dengan memory customer, riwayat percakapan, dan state order/konsultasi.
- Deteksi intent untuk membedakan chat umum, konsultasi, produk, order, status pesanan, komplain, dan eskalasi.
- Order flow WhatsApp yang menyimpan pesanan ke database.
- Parsing closingan manual atau bulk menjadi data terstruktur.
- Export closingan ke file XLS.
- Analytics dan log percakapan.
- Integrasi Telegram untuk notifikasi order dan webhook.
- Proteksi API internal menggunakan `INTERNAL_API_KEY`.

## Arsitektur Singkat

Alur percakapan WhatsApp:

```text
Customer WhatsApp
  -> WA Gateway (Baileys)
  -> Admin Panel API untuk history/profile/data publik
  -> AI Service untuk intent dan jawaban
  -> WA Gateway mengirim balasan ke customer
```

Alur admin:

```text
Admin Browser
  -> Admin Panel
  -> SQLite database di folder data/
  -> WA Gateway untuk status QR/koneksi
  -> AI Service untuk test chat dan parsing closingan
```

## Struktur Folder

```text
.
|-- admin-panel/
|   |-- app.py
|   |-- requirements.txt
|   |-- Dockerfile
|   |-- static/
|   `-- templates/
|-- ai-service/
|   |-- ai_service_v2.py
|   |-- requirements.txt
|   |-- Dockerfile
|   `-- sukumba_core/
|-- wa-gateway/
|   |-- index.js
|   |-- package.json
|   `-- Dockerfile
|-- data/
|   |-- admin_panel.db
|   |-- order_sessions.json
|   `-- auth_info_baileys/
|-- tools/
|   `-- register_testimonials.py
`-- docker-compose.yml
```

## Prasyarat

Untuk menjalankan dengan Docker:

- Docker Desktop
- Docker Compose

Untuk menjalankan manual tanpa Docker:

- Python 3.11 atau lebih baru
- Node.js 22 atau kompatibel
- npm
- Akun/API key LLM, misalnya Groq, jika fitur AI ingin aktif

## Setup Cepat dengan Docker

Cara ini paling direkomendasikan karena semua service langsung jalan bersama.

1. Copy file environment:

```powershell
Copy-Item admin-panel\.env.example admin-panel\.env
Copy-Item ai-service\.env.example ai-service\.env
Copy-Item wa-gateway\.env.example wa-gateway\.env
```

2. Isi nilai penting pada file `.env` masing-masing service.

Pastikan `INTERNAL_API_KEY` sama di:

- `admin-panel/.env`
- `ai-service/.env`
- `wa-gateway/.env`

Minimal konfigurasi yang perlu diubah:

```env
SECRET_KEY=isi_random_secret_minimal_32_karakter
ADMIN_PASSWORD=password_login_admin
INTERNAL_API_KEY=isi_key_rahasia_yang_sama
GROQ_API_KEY=isi_api_key_groq
ADMIN_WA=628xxxxxxxxxx
```

3. Build dan jalankan semua service:

```powershell
docker compose up --build
```

4. Buka dashboard admin:

```text
http://localhost:5001
```

Login memakai password dari `ADMIN_PASSWORD`.

5. Scan QR WhatsApp.

Buka menu WhatsApp di admin panel, lalu scan QR menggunakan aplikasi WhatsApp pada nomor yang akan dipakai sebagai CS.

## URL Service

Saat berjalan via Docker:

| Service | URL Lokal |
| --- | --- |
| Admin Panel | `http://localhost:5001` |
| AI Service Health | `http://localhost:5000/health` |
| WA Gateway Health | `http://localhost:3000/health` |
| WA Status | `http://localhost:3000/wa-status` |

Di dalam Docker network, service saling mengakses memakai nama container:

```text
http://admin-panel-docker:5001
http://ai-service-docker:5000
http://wa-gateway-docker:3000
```

## Konfigurasi Environment

### `admin-panel/.env`

| Variable | Wajib | Keterangan |
| --- | --- | --- |
| `SECRET_KEY` | Ya | Secret Flask session. Gunakan string random panjang. |
| `ADMIN_PASSWORD` | Ya | Password login admin panel. |
| `INTERNAL_API_KEY` | Ya | Key internal antar service. Harus sama di semua service. |
| `TELEGRAM_BOT_TOKEN` | Tidak | Token bot Telegram untuk webhook/notifikasi. |
| `TELEGRAM_CHAT_ID` | Tidak | Chat ID default untuk notifikasi. |
| `ADMIN_WA` | Disarankan | Nomor WhatsApp admin format Indonesia, contoh `62812...`. |
| `DB_PATH` | Ya untuk Docker | Path SQLite. Default Docker: `/app/data/admin_panel.db`. |
| `AI_URL` | Ya | URL AI service. Docker: `http://ai-service-docker:5000`. |
| `WA_GATEWAY_URL` | Ya | URL WA gateway. Docker: `http://wa-gateway-docker:3000`. |

### `ai-service/.env`

| Variable | Wajib | Keterangan |
| --- | --- | --- |
| `INTERNAL_API_KEY` | Ya | Key internal antar service. |
| `ADMIN_URL` | Ya | URL admin panel. Docker: `http://admin-panel-docker:5001`. |
| `WA_GATEWAY_URL` | Tidak | URL WA gateway. |
| `GROQ_API_KEY` | Ya untuk AI | API key Groq. |
| `LLM_API_URL` | Ya untuk AI | Endpoint chat completion. Default Groq compatible. |
| `LLM_MODEL` | Ya untuk AI | Model LLM, contoh `llama-3.3-70b-versatile`. |
| `TELEGRAM_BOT_TOKEN` | Tidak | Token Telegram. |
| `TELEGRAM_CHAT_ID` | Tidak | Target chat Telegram. |

`LLM_API_KEY` juga didukung oleh kode. Jika tidak diisi, service memakai `OPENROUTER_API_KEY` atau `GROQ_API_KEY`.

### `wa-gateway/.env`

| Variable | Wajib | Keterangan |
| --- | --- | --- |
| `INTERNAL_API_KEY` | Ya | Key internal antar service. |
| `ADMIN_URL` | Ya | URL admin panel. Docker: `http://admin-panel-docker:5001`. |
| `AI_URL` | Ya | URL AI service. Docker: `http://ai-service-docker:5000`. |
| `ADMIN_WA` | Disarankan | Nomor admin untuk notifikasi/escalation. |

## Menjalankan Manual Tanpa Docker

Gunakan cara ini jika ingin development langsung dari source.

### 1. Admin Panel

```powershell
cd admin-panel
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
python app.py
```

Untuk manual mode, sesuaikan `admin-panel/.env`:

```env
DB_PATH=../data/admin_panel.db
AI_URL=http://localhost:5000
WA_GATEWAY_URL=http://localhost:3000
```

### 2. AI Service

Buka terminal kedua:

```powershell
cd ai-service
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
python ai_service_v2.py
```

Untuk manual mode, sesuaikan `ai-service/.env`:

```env
ADMIN_URL=http://localhost:5001
WA_GATEWAY_URL=http://localhost:3000
```

### 3. WA Gateway

Buka terminal ketiga:

```powershell
cd wa-gateway
npm install
Copy-Item .env.example .env
node index.js
```

Untuk manual mode, sesuaikan `wa-gateway/.env`:

```env
ADMIN_URL=http://localhost:5001
AI_URL=http://localhost:5000
```

## Endpoint Penting

### Admin Panel

| Method | Endpoint | Fungsi |
| --- | --- | --- |
| `GET` | `/` | Dashboard admin |
| `GET/POST` | `/login` | Login admin |
| `GET` | `/api/settings` | Ambil konfigurasi |
| `POST` | `/api/settings` | Simpan konfigurasi |
| `GET/POST` | `/api/products` | List/tambah produk |
| `PUT/DELETE` | `/api/products/<id>` | Update/hapus produk |
| `GET/POST` | `/api/faqs` | List/tambah FAQ |
| `GET/POST` | `/api/testimonials` | List/tambah testimoni |
| `GET/POST` | `/api/cs-templates` | List/tambah template CS |
| `GET` | `/api/wa/status` | Status koneksi WhatsApp |
| `GET` | `/api/wa/qr` | QR WhatsApp |
| `POST` | `/api/chat-proxy` | Proxy test chat ke AI service |
| `GET/POST` | `/api/orders` | List/tambah order |
| `GET` | `/api/analytics` | Ringkasan analytics |
| `GET/POST` | `/api/closings` | List/tambah closingan |
| `GET` | `/api/closings/export` | Export closingan XLS |
| `POST` | `/api/parse-manual` | Parse satu closingan |
| `POST` | `/api/parse-bulk` | Parse banyak closingan |

### AI Service

Endpoint AI service memakai header internal jika `INTERNAL_API_KEY` aktif:

```http
X-Internal-Key: isi_key_rahasia_yang_sama
```

| Method | Endpoint | Fungsi |
| --- | --- | --- |
| `POST` | `/ai-chat` | Generate jawaban AI untuk chat customer |
| `POST` | `/detect-intent` | Deteksi intent pesan |
| `POST` | `/parse-closing` | Parse closingan menjadi JSON |
| `POST` | `/parse-bulk` | Parse banyak closingan |
| `POST` | `/notify-order` | Kirim notifikasi order |
| `GET` | `/health` | Health check service |

### WA Gateway

| Method | Endpoint | Fungsi |
| --- | --- | --- |
| `POST` | `/send-message` | Kirim pesan WhatsApp |
| `GET` | `/wa-status` | Status koneksi WhatsApp |
| `GET` | `/wa-qr` | Ambil QR login |
| `POST` | `/wa-disconnect` | Disconnect WhatsApp |
| `POST` | `/wa-reconnect` | Reset auth dan reconnect |
| `GET` | `/health` | Health check gateway |

## Database dan Data Persisten

Database SQLite berada di:

```text
data/admin_panel.db
```

Folder penting lain:

| Path | Fungsi |
| --- | --- |
| `data/auth_info_baileys/` | Session login WhatsApp Baileys |
| `data/order_sessions.json` | Session order aktif dari WA gateway |
| `admin-panel/static/uploads/` | Upload produk, FAQ, dan media |
| `admin-panel/static/uploads/testimoni/` | File testimoni |

Admin panel akan membuat tabel otomatis saat start melalui `init_db()` di `admin-panel/app.py`.

Tabel utama:

- `settings`
- `products`
- `faqs`
- `testimonials`
- `cs_templates`
- `conversation_logs`
- `conversation_history`
- `customer_profiles`
- `orders`
- `closings`
- `telegram_users`

## Menambahkan Testimoni dari File

Jika file testimoni sudah ada di `admin-panel/static/uploads/testimoni/`, jalankan:

```powershell
python tools\register_testimonials.py
```

Script ini akan mendaftarkan file gambar/video ke tabel `testimonials` di `data/admin_panel.db`.

## Operasional WhatsApp

1. Jalankan semua service.
2. Buka admin panel di `http://localhost:5001`.
3. Masuk ke bagian WhatsApp.
4. Jika status `waiting_scan`, scan QR.
5. Jika koneksi bermasalah, gunakan tombol reconnect dari panel admin atau panggil:

```powershell
Invoke-RestMethod -Method Post http://localhost:3000/wa-reconnect
```

Session WhatsApp tersimpan di `data/auth_info_baileys/`. Jika ingin login ulang dari nol, reconnect dengan reset auth atau hapus folder session tersebut setelah semua service dimatikan.

## Perintah Docker yang Sering Dipakai

Menjalankan service:

```powershell
docker compose up --build
```

Menjalankan di background:

```powershell
docker compose up -d --build
```

Melihat log semua service:

```powershell
docker compose logs -f
```

Melihat log satu service:

```powershell
docker compose logs -f admin-panel-docker
docker compose logs -f ai-service-docker
docker compose logs -f wa-gateway-docker
```

Stop service:

```powershell
docker compose down
```

Restart service:

```powershell
docker compose restart
```

## Troubleshooting

### Admin panel tidak bisa login

- Pastikan `ADMIN_PASSWORD` di `admin-panel/.env` sudah benar.
- Restart container setelah mengubah `.env`.

```powershell
docker compose restart admin-panel-docker
```

### AI tidak menjawab atau fallback terus

- Pastikan `GROQ_API_KEY` atau `LLM_API_KEY` sudah diisi.
- Pastikan `LLM_API_URL` dan `LLM_MODEL` benar.
- Cek health AI service:

```powershell
Invoke-RestMethod http://localhost:5000/health
```

- Cek log:

```powershell
docker compose logs -f ai-service-docker
```

### API antar service error unauthorized

- Pastikan `INTERNAL_API_KEY` sama persis di semua `.env`.
- Restart semua service setelah perubahan.

```powershell
docker compose restart
```

### WhatsApp tidak terkoneksi

- Cek status:

```powershell
Invoke-RestMethod http://localhost:3000/wa-status
```

- Reconnect:

```powershell
Invoke-RestMethod -Method Post http://localhost:3000/wa-reconnect
```

- Jika masih gagal, matikan service, hapus `data/auth_info_baileys/`, lalu jalankan ulang dan scan QR baru.

### Database tidak terbaca di Docker Desktop Windows

Project ini memakai SQLite. Pada bind mount Windows/OneDrive, mode WAL bisa bermasalah. Kode admin panel sudah mengatur `PRAGMA journal_mode = DELETE` agar lebih stabil.

Jika database tetap bermasalah:

- Pastikan folder `data/` bisa ditulis.
- Hindari menjalankan beberapa instance admin panel yang memakai DB sama.
- Backup `data/admin_panel.db`, lalu restart container.

### Port sudah dipakai

Default port:

- Admin Panel: `5001`
- AI Service: `5000`
- WA Gateway: `3000`

Jika port bentrok, ubah mapping port di `docker-compose.yml`, misalnya:

```yaml
ports:
  - "5002:5001"
```

## Catatan Keamanan

- Jangan commit file `.env` yang berisi secret.
- Gunakan `SECRET_KEY` yang panjang dan random.
- Gunakan `ADMIN_PASSWORD` yang kuat.
- Samakan `INTERNAL_API_KEY` hanya antar service internal.
- Jangan membuka endpoint internal AI/WA gateway ke publik tanpa reverse proxy, auth, dan firewall.
- Backup `data/admin_panel.db` secara berkala.
- Folder `data/auth_info_baileys/` berisi session WhatsApp, perlakukan seperti credential.

## Checklist Deploy

- [ ] `admin-panel/.env` sudah dibuat dan diisi.
- [ ] `ai-service/.env` sudah dibuat dan diisi.
- [ ] `wa-gateway/.env` sudah dibuat dan diisi.
- [ ] `INTERNAL_API_KEY` sama di semua service.
- [ ] `ADMIN_PASSWORD` sudah diganti.
- [ ] `GROQ_API_KEY` atau `LLM_API_KEY` sudah diisi.
- [ ] `ADMIN_WA` sudah memakai format `628...`.
- [ ] `docker compose up --build` sukses.
- [ ] Admin panel bisa dibuka di `http://localhost:5001`.
- [ ] AI health check `http://localhost:5000/health` berstatus `ok`.
- [ ] WA gateway health check `http://localhost:3000/health` berstatus `ok`.
- [ ] QR WhatsApp berhasil discan.
- [ ] Test chat dari admin panel berhasil.
