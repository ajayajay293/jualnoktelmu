const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Konfigurasi API Telegram
const API_ID = 31929193;
const API_HASH = '926aaced8b1367c281f8f9547f7808d5';

// File Database
const DB_FILE = path.join(__dirname, 'data', 'database.json');
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
const WITHDRAW_FILE = path.join(__dirname, 'data', 'withdrawals.json');

// Inisialisasi Database
function initDatabase() {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({
            users: {},
            accounts: [],
            settings: {
                harga_biasa: 5000,
                harga_plus: 25000,
                min_withdraw: 10000,
                owner_id: null
            },
            stats: {
                total_accounts: 0,
                total_users: 0,
                total_withdrawn: 0
            }
        }, null, 2));
    }

    if (!fs.existsSync(SESSIONS_FILE)) {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify({}, null, 2));
    }

    if (!fs.existsSync(WITHDRAW_FILE)) {
        fs.writeFileSync(WITHDRAW_FILE, JSON.stringify([], null, 2));
    }
}

// Helper Functions
function getDB() {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function getSessions() {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
}

function saveSessions(data) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

function getWithdrawals() {
    return JSON.parse(fs.readFileSync(WITHDRAW_FILE, 'utf8'));
}

function saveWithdrawals(data) {
    fs.writeFileSync(WITHDRAW_FILE, JSON.stringify(data, null, 2));
}

// Broadcast ke semua WebSocket clients
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Active Sessions untuk proses login
const activeSessions = new Map();

// ==================== API ROUTES ====================

// Get Settings
app.get('/api/settings', (req, res) => {
    const db = getDB();
    res.json({
        success: true,
        data: {
            harga_biasa: db.settings.harga_biasa,
            harga_plus: db.settings.harga_plus,
            min_withdraw: db.settings.min_withdraw
        }
    });
});

// Register/Login User
app.post('/api/auth', (req, res) => {
    const { userId, username, name } = req.body;
    
    if (!userId) {
        return res.status(400).json({ success: false, message: 'User ID required' });
    }

    const db = getDB();
    
    if (!db.users[userId]) {
        db.users[userId] = {
            id: userId,
            username: username || '',
            name: name || 'User',
            balance: 0,
            total_sold: 0,
            joined_at: new Date().toISOString(),
            last_active: new Date().toISOString()
        };
        db.stats.total_users++;
        saveDB(db);
        
        broadcast({
            type: 'new_user',
            data: { userId, username, name }
        });
    } else {
        db.users[userId].last_active = new Date().toISOString();
        saveDB(db);
    }

    res.json({
        success: true,
        data: db.users[userId]
    });
});

// Get User Profile
app.get('/api/user/:userId', (req, res) => {
    const { userId } = req.params;
    const db = getDB();
    const user = db.users[userId];
    
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
        success: true,
        data: user
    });
});

// Step 1: Send OTP
app.post('/api/send-otp', async (req, res) => {
    const { phone, userId } = req.body;
    
    if (!phone || !userId) {
        return res.status(400).json({ success: false, message: 'Phone and User ID required' });
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    
    // Check if account already exists
    const db = getDB();
    if (db.accounts.find(a => a.phone === cleanPhone)) {
        return res.status(400).json({ success: false, message: 'Nomor sudah pernah dijual!' });
    }

    try {
        const session = new StringSession('');
        const client = new TelegramClient(session, API_ID, API_HASH, {
            connectionRetries: 5,
            useWSS: true
        });

        await client.connect();
        const { phoneCodeHash } = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, cleanPhone);

        // Simpan session sementara
        const sessionId = uuidv4();
        activeSessions.set(sessionId, {
            client,
            phone: cleanPhone,
            phoneCodeHash,
            userId,
            sessionString: session.save()
        });

        res.json({
            success: true,
            data: { sessionId, message: 'OTP terkirim!' }
        });

    } catch (error) {
        console.error('Send OTP Error:', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal mengirim OTP' });
    }
});

// Step 2: Verify OTP
app.post('/api/verify-otp', async (req, res) => {
    const { sessionId, otp, userId } = req.body;
    
    if (!sessionId || !otp) {
        return res.status(400).json({ success: false, message: 'Session ID and OTP required' });
    }

    const sessionData = activeSessions.get(sessionId);
    if (!sessionData) {
        return res.status(400).json({ success: false, message: 'Session expired' });
    }

    try {
        const { client, phone, phoneCodeHash, userId: sessionUserId } = sessionData;
        
        // Check 2FA
        let needs2FA = false;
        
        try {
            await client.invoke(new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash,
                phoneCode: otp.replace(/\s/g, '')
            }));
        } catch (error) {
            if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                needs2FA = true;
                sessionData.needs2FA = true;
                
                return res.json({
                    success: true,
                    data: { needs2FA: true, message: '2FA diperlukan' }
                });
            } else {
                throw error;
            }
        }

        // Login berhasil tanpa 2FA
        await processSuccessfulLogin(sessionId, res);

    } catch (error) {
        console.error('Verify OTP Error:', error);
        activeSessions.delete(sessionId);
        res.status(500).json({ success: false, message: error.message || 'OTP salah' });
    }
});

// Step 3: Verify 2FA
app.post('/api/verify-2fa', async (req, res) => {
    const { sessionId, password } = req.body;
    
    if (!sessionId || !password) {
        return res.status(400).json({ success: false, message: 'Session ID and password required' });
    }

    const sessionData = activeSessions.get(sessionId);
    if (!sessionData || !sessionData.needs2FA) {
        return res.status(400).json({ success: false, message: 'Invalid session' });
    }

    try {
        const { client } = sessionData;
        
        await client.checkPassword(password);
        await processSuccessfulLogin(sessionId, res);

    } catch (error) {
        console.error('2FA Error:', error);
        res.status(500).json({ success: false, message: 'Password 2FA salah' });
    }
});

// Process Successful Login
async function processSuccessfulLogin(sessionId, res) {
    const sessionData = activeSessions.get(sessionId);
    if (!sessionData) {
        return res.status(400).json({ success: false, message: 'Session expired' });
    }

    const { client, phone, userId } = sessionData;

    try {
        // Get user info
        const me = await client.getMe();
        const sessionString = client.session.save();

        // Calculate price
        const db = getDB();
        const isPlus = phone.startsWith('1');
        const price = isPlus ? db.settings.harga_plus : db.settings.harga_biasa;

        // Save account
        const accountData = {
            id: uuidv4(),
            phone: phone,
            session: sessionString,
            sellerId: userId,
            sellerName: db.users[userId]?.name || 'Unknown',
            tgId: me.id.toString(),
            tgUsername: me.username || null,
            tgFirstName: me.firstName || '',
            tgLastName: me.lastName || '',
            price: price,
            status: 'active',
            sold_at: new Date().toISOString(),
            is_plus: isPlus
        };

        db.accounts.push(accountData);
        
        // Update user balance
        if (!db.users[userId]) {
            db.users[userId] = { balance: 0, total_sold: 0 };
        }
        db.users[userId].balance += price;
        db.users[userId].total_sold = (db.users[userId].total_sold || 0) + 1;
        
        // Update stats
        db.stats.total_accounts++;
        
        saveDB(db);

        // Save to sessions.json
        const sessions = getSessions();
        sessions[accountData.id] = {
            phone: phone,
            session: sessionString,
            created_at: accountData.sold_at
        };
        saveSessions(sessions);

        // Disconnect client
        await client.disconnect();
        activeSessions.delete(sessionId);

        // Broadcast success
        broadcast({
            type: 'account_sold',
            data: {
                phone: accountData.phone,
                price: price,
                seller: db.users[userId]?.name || 'Unknown',
                timestamp: new Date().toISOString()
            }
        });

        res.json({
            success: true,
            data: {
                message: 'Akun berhasil dijual!',
                phone: phone,
                price: price,
                newBalance: db.users[userId].balance,
                account: {
                    name: `${me.firstName || ''} ${me.lastName || ''}`.trim(),
                    username: me.username,
                    id: me.id
                }
            }
        });

    } catch (error) {
        console.error('Process Login Error:', error);
        await client.disconnect();
        activeSessions.delete(sessionId);
        res.status(500).json({ success: false, message: error.message });
    }
}

// Get User Accounts
app.get('/api/user/:userId/accounts', (req, res) => {
    const { userId } = req.params;
    const db = getDB();
    const accounts = db.accounts.filter(a => a.sellerId === userId);
    
    res.json({
        success: true,
        data: accounts
    });
});

// Withdraw Request
app.post('/api/withdraw', (req, res) => {
    const { userId, method, number, amount } = req.body;
    
    if (!userId || !method || !number || !amount) {
        return res.status(400).json({ success: false, message: 'All fields required' });
    }

    const db = getDB();
    const user = db.users[userId];
    
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
    }

    const withdrawAmount = parseInt(amount);
    const minWithdraw = db.settings.min_withdraw;

    if (withdrawAmount < minWithdraw) {
        return res.status(400).json({ success: false, message: `Minimal withdraw Rp ${minWithdraw.toLocaleString()}` });
    }

    if (user.balance < withdrawAmount) {
        return res.status(400).json({ success: false, message: 'Saldo tidak mencukupi' });
    }

    // Create withdrawal request
    const withdrawal = {
        id: 'WD' + Date.now(),
        userId: userId,
        userName: user.name,
        method: method,
        number: number,
        amount: withdrawAmount,
        status: 'pending',
        created_at: new Date().toISOString(),
        processed_at: null
    };

    const withdrawals = getWithdrawals();
    withdrawals.push(withdrawal);
    saveWithdrawals(withdrawals);

    // Deduct balance
    user.balance -= withdrawAmount;
    saveDB(db);

    // Broadcast
    broadcast({
        type: 'withdraw_request',
        data: withdrawal
    });

    res.json({
        success: true,
        data: {
            message: 'Permintaan withdraw berhasil dibuat',
            withdrawalId: withdrawal.id,
            newBalance: user.balance
        }
    });
});

// Get Withdrawal History
app.get('/api/user/:userId/withdrawals', (req, res) => {
    const { userId } = req.params;
    const withdrawals = getWithdrawals();
    const userWithdrawals = withdrawals.filter(w => w.userId === userId);
    
    res.json({
        success: true,
        data: userWithdrawals
    });
});

// Get All Accounts (Admin)
app.get('/api/accounts', (req, res) => {
    const db = getDB();
    res.json({
        success: true,
        data: db.accounts
    });
});

// Get Stats
app.get('/api/stats', (req, res) => {
    const db = getDB();
    const withdrawals = getWithdrawals();
    
    res.json({
        success: true,
        data: {
            total_accounts: db.stats.total_accounts,
            total_users: db.stats.total_users,
            total_withdrawn: withdrawals.filter(w => w.status === 'completed').reduce((sum, w) => sum + w.amount, 0),
            pending_withdrawals: withdrawals.filter(w => w.status === 'pending').length
        }
    });
});

// Get Recent Sales (for live feed)
app.get('/api/recent-sales', (req, res) => {
    const db = getDB();
    const recent = db.accounts
        .slice(-10)
        .reverse()
        .map(a => ({
            phone: a.phone,
            price: a.price,
            seller: a.sellerName,
            time: a.sold_at
        }));
    
    res.json({
        success: true,
        data: recent
    });
});

// Update Settings (Admin)
app.post('/api/settings', (req, res) => {
    const { harga_biasa, harga_plus, min_withdraw } = req.body;
    const db = getDB();
    
    if (harga_biasa) db.settings.harga_biasa = parseInt(harga_biasa);
    if (harga_plus) db.settings.harga_plus = parseInt(harga_plus);
    if (min_withdraw) db.settings.min_withdraw = parseInt(min_withdraw);
    
    saveDB(db);
    
    res.json({
        success: true,
        data: db.settings
    });
});

// Approve/Reject Withdrawal (Admin)
app.post('/api/withdrawal/:id/process', (req, res) => {
    const { id } = req.params;
    const { status, adminNote } = req.body;
    
    const withdrawals = getWithdrawals();
    const withdrawal = withdrawals.find(w => w.id === id);
    
    if (!withdrawal) {
        return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    }

    withdrawal.status = status;
    withdrawal.processed_at = new Date().toISOString();
    withdrawal.admin_note = adminNote || '';
    
    saveWithdrawals(withdrawals);

    // If rejected, refund balance
    if (status === 'rejected') {
        const db = getDB();
        if (db.users[withdrawal.userId]) {
            db.users[withdrawal.userId].balance += withdrawal.amount;
            saveDB(db);
        }
    }

    broadcast({
        type: 'withdraw_processed',
        data: withdrawal
    });

    res.json({
        success: true,
        data: withdrawal
    });
});

// WebSocket Connection
wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
    
    // Send initial stats
    const db = getDB();
    ws.send(JSON.stringify({
        type: 'stats',
        data: db.stats
    }));

    ws.on('close', () => {
        console.log('WebSocket disconnected');
    });
});

// Error handling
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});

// Initialize and Start Server
initDatabase();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║           🚀 JarzX Telegram Store Server 🚀              ║
║                                                          ║
║   Server running on port: ${PORT}                          ║
║   API Endpoint: http://localhost:${PORT}/api               ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
    `);
});
