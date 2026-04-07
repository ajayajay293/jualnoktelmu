# JarzX Telegram Store

Website untuk jual akun Telegram dengan sistem balance dan withdraw otomatis.

## Fitur

- ✅ Jual akun Telegram (OTP & 2FA support)
- ✅ Sistem balance otomatis
- ✅ Withdraw ke e-wallet (DANA, GoPay, OVO, ShopeePay, Bank)
- ✅ Live notification saat ada penjualan
- ✅ Session tersimpan di sessions.json
- ✅ Mobile responsive
- ✅ Animasi smooth tanpa lag

## Konfigurasi API

```
API ID: 31929193
API HASH: 926aaced8b1367c281f8f9547f7808d5
```

## Harga

- Nomor Biasa: Rp 5.000
- Nomor Premium (+1): Rp 25.000

## Install & Run

```bash
npm install
npm start
```

## File Structure

```
tgstore/
├── server.js          # Backend Express + WebSocket
├── package.json       # Dependencies
├── public/
│   ├── index.html     # Frontend
│   └── tgstore-logo.png
└── data/
    ├── database.json  # User & account data
    ├── sessions.json  # Telegram sessions
    └── withdrawals.json # Withdrawal history
```

## API Endpoints

- `POST /api/auth` - Register/Login user
- `POST /api/send-otp` - Kirim OTP ke nomor
- `POST /api/verify-otp` - Verifikasi OTP
- `POST /api/verify-2fa` - Verifikasi 2FA
- `POST /api/withdraw` - Request withdraw
- `GET /api/settings` - Get harga & settings
- `GET /api/stats` - Get statistik
- `GET /api/user/:id/accounts` - Get riwayat penjualan
- `GET /api/user/:id/withdrawals` - Get riwayat withdraw

## Made by JarzX
