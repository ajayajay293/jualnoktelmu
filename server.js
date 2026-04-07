const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Konfigurasi API Telegram
const API_ID = 31929193;
const API_HASH = '926aaced8b1367c281f8f9547f7808d5';

// MongoDB Connection URI
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://cmurah60_db_user:6RHof8abbe5nQeij@ajayajay.i7lyfmk.mongodb.net/?appName=ajayajay';
const DB_NAME = 'jarzx_tg_store';

// Database collections
let db;
let usersCollection;
let accountsCollection;
let sessionsCollection;
let withdrawalsCollection;
let settingsCollection;
let statsCollection;

// Connect to MongoDB
async function connectMongoDB() {
    try {
        const client = new MongoClient(MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        
        await client.connect();
        console.log('Connected to MongoDB successfully!');
        
        db = client.db(DB_NAME);
        usersCollection = db.collection('users');
        accountsCollection = db.collection('accounts');
        sessionsCollection = db.collection('sessions');
        withdrawalsCollection = db.collection('withdrawals');
        settingsCollection = db.collection('settings');
        statsCollection = db.collection('stats');
        
        // Initialize default settings if not exists
        await initDefaultSettings();
        
        // Initialize stats if not exists
        await initDefaultStats();
        
    } catch (error) {
        console.error('MongoDB Connection Error:', error);
        console.log('Running in memory-only mode...');
        // In-memory fallback
        initMemoryStorage();
    }
}

// In-memory storage fallback
function initMemoryStorage() {
    const memoryStorage = {
        users: [],
        accounts: [],
        sessions: [],
        withdrawals: [],
        settings: { _id: 'main', harga_biasa: 5000, harga_plus: 25000, min_withdraw: 10000, owner_id: null },
        stats: { _id: 'main', total_accounts: 0, total_users: 0, total_withdrawn: 0 }
    };
    
    usersCollection = {
        findOne: async (query) => memoryStorage.users.find(u => u._id === query._id || u.id === query.id),
        find: (query) => ({ toArray: async () => memoryStorage.users }),
        insertOne: async (doc) => { memoryStorage.users.push(doc); return { insertedId: doc._id }; },
        updateOne: async (query, update) => {
            const idx = memoryStorage.users.findIndex(u => u._id === query._id);
            if (idx !== -1) {
                const setData = update.$set || {};
                const incData = update.$inc || {};
                Object.assign(memoryStorage.users[idx], setData);
                Object.keys(incData).forEach(key => {
                    memoryStorage.users[idx][key] = (memoryStorage.users[idx][key] || 0) + incData[key];
                });
            }
        }
    };
    
    accountsCollection = {
        findOne: async (query) => memoryStorage.accounts.find(a => a._id === query._id || a.phone === query.phone),
        find: (query) => ({ 
            toArray: async () => query.sellerId ? memoryStorage.accounts.filter(a => a.sellerId === query.sellerId) : memoryStorage.accounts,
            sort: () => ({ limit: () => ({ toArray: async () => memoryStorage.accounts.slice().reverse().slice(0, 10) }) })
        }),
        insertOne: async (doc) => { memoryStorage.accounts.push(doc); return { insertedId: doc._id }; }
    };
    
    sessionsCollection = {
        insertOne: async (doc) => { memoryStorage.sessions.push(doc); return { insertedId: doc._id }; }
    };
    
    withdrawalsCollection = {
        findOne: async (query) => memoryStorage.withdrawals.find(w => w._id === query._id),
        find: (query) => ({
            toArray: async () => query.userId ? memoryStorage.withdrawals.filter(w => w.userId === query.userId) : memoryStorage.withdrawals,
            count: async () => memoryStorage.withdrawals.filter(w => w.status === 'pending').length
        }),
        insertOne: async (doc) => { memoryStorage.withdrawals.push(doc); return { insertedId: doc._id }; },
        updateOne: async (query, update) => {
            const idx = memoryStorage.withdrawals.findIndex(w => w._id === query._id);
            if (idx !== -1) Object.assign(memoryStorage.withdrawals[idx], update.$set);
        }
    };
    
    settingsCollection = {
        findOne: async () => memoryStorage.settings,
        updateOne: async (query, update) => {
            Object.assign(memoryStorage.settings, update.$set);
        }
    };
    
    statsCollection = {
        findOne: async () => memoryStorage.stats,
        updateOne: async (query, update) => {
            const incData = update.$inc || {};
            Object.keys(incData).forEach(key => {
                memoryStorage.stats[key] = (memoryStorage.stats[key] || 0) + incData[key];
            });
            if (update.$set) Object.assign(memoryStorage.stats, update.$set);
        }
    };
}

// Initialize default settings
async function initDefaultSettings() {
    const existingSettings = await settingsCollection.findOne({ _id: 'main' });
    if (!existingSettings) {
        await settingsCollection.insertOne({
            _id: 'main',
            harga_biasa: 5000,
            harga_plus: 25000,
            min_withdraw: 10000,
            owner_id: null,
            updated_at: new Date().toISOString()
        });
        console.log('Default settings initialized');
    }
}

// Initialize default stats
async function initDefaultStats() {
    const existingStats = await statsCollection.findOne({ _id: 'main' });
    if (!existingStats) {
        await statsCollection.insertOne({
            _id: 'main',
            total_accounts: 0,
            total_users: 0,
            total_withdrawn: 0,
            updated_at: new Date().toISOString()
        });
        console.log('Default stats initialized');
    }
}

// Helper Functions
async function getSettings() {
    return await settingsCollection.findOne({ _id: 'main' }) || {};
}

async function updateSettings(updates) {
    await settingsCollection.updateOne(
        { _id: 'main' },
        { $set: { ...updates, updated_at: new Date().toISOString() } },
        { upsert: true }
    );
}

async function getStats() {
    return await statsCollection.findOne({ _id: 'main' }) || {};
}

async function updateStats(updates) {
    await statsCollection.updateOne(
        { _id: 'main' },
        { $set: { ...updates, updated_at: new Date().toISOString() } },
        { upsert: true }
    );
}

async function incrementStats(field, value = 1) {
    const update = {};
    update[field] = value;
    await statsCollection.updateOne(
        { _id: 'main' },
        { $inc: update, $set: { updated_at: new Date().toISOString() } },
        { upsert: true }
    );
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

// Owner credentials (in production, use hashed passwords)
const OWNER_PASSWORD = 'JarzXOwner2024!';

// ==================== API ROUTES ====================

// Get Settings
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await getSettings();
        res.json({
            success: true,
            data: {
                harga_biasa: settings.harga_biasa || 5000,
                harga_plus: settings.harga_plus || 25000,
                min_withdraw: settings.min_withdraw || 10000
            }
        });
    } catch (error) {
        console.error('Get Settings Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Register/Login User
app.post('/api/auth', async (req, res) => {
    const { userId, username, name } = req.body;
    
    if (!userId) {
        return res.status(400).json({ success: false, message: 'User ID required' });
    }

    try {
        let user = await usersCollection.findOne({ _id: userId });
        
        if (!user) {
            user = {
                _id: userId,
                id: userId,
                username: username || '',
                name: name || 'User',
                balance: 0,
                total_sold: 0,
                joined_at: new Date().toISOString(),
                last_active: new Date().toISOString()
            };
            await usersCollection.insertOne(user);
            await incrementStats('total_users');
            
            broadcast({
                type: 'new_user',
                data: { userId, username, name }
            });
        } else {
            await usersCollection.updateOne(
                { _id: userId },
                { $set: { last_active: new Date().toISOString() } }
            );
            user.last_active = new Date().toISOString();
        }

        res.json({
            success: true,
            data: user
        });
    } catch (error) {
        console.error('Auth Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get User Profile
app.get('/api/user/:userId', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const user = await usersCollection.findOne({ _id: userId });
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.json({
            success: true,
            data: user
        });
    } catch (error) {
        console.error('Get User Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Step 1: Send OTP - REAL TELEGRAM API
app.post('/api/send-otp', async (req, res) => {
    const { phone, userId } = req.body;
    
    if (!phone || !userId) {
        return res.status(400).json({ success: false, message: 'Phone and User ID required' });
    }

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    
    try {
        // Check if account already exists
        const existingAccount = await accountsCollection.findOne({ phone: cleanPhone });
        if (existingAccount) {
            return res.status(400).json({ success: false, message: 'Nomor sudah pernah dijual!' });
        }

        const session = new StringSession('');
        const client = new TelegramClient(session, API_ID, API_HASH, {
            connectionRetries: 5,
            useWSS: true
        });

        await client.connect();
        
        // REAL OTP SENDING TO TELEGRAM
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
            data: { sessionId, message: 'OTP terkirim ke Telegram!' }
        });

    } catch (error) {
        console.error('Send OTP Error:', error);
        res.status(500).json({ success: false, message: error.message || 'Gagal mengirim OTP' });
    }
});

// Step 2: Verify OTP - REAL TELEGRAM API
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
            // REAL OTP VERIFICATION WITH TELEGRAM
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

// Step 3: Verify 2FA - REAL TELEGRAM API
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
        
        // REAL 2FA VERIFICATION WITH TELEGRAM
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
        // Get user info from Telegram
        const me = await client.getMe();
        const sessionString = client.session.save();

        // Calculate price
        const settings = await getSettings();
        const isPlus = phone.startsWith('1');
        const price = isPlus ? (settings.harga_plus || 25000) : (settings.harga_biasa || 5000);

        // Save account with COMPLETE DETAILS
        const accountData = {
            _id: uuidv4(),
            id: uuidv4(),
            phone: phone,
            session: sessionString,
            sellerId: userId,
            sellerName: 'Unknown',
            tgId: me.id.toString(),
            tgUsername: me.username || null,
            tgFirstName: me.firstName || '',
            tgLastName: me.lastName || '',
            tgFullName: `${me.firstName || ''} ${me.lastName || ''}`.trim(),
            price: price,
            status: 'active',
            sold_at: new Date().toISOString(),
            is_plus: isPlus
        };

        // Get seller name
        const seller = await usersCollection.findOne({ _id: userId });
        if (seller) {
            accountData.sellerName = seller.name || 'Unknown';
        }

        await accountsCollection.insertOne(accountData);
        
        // Update user balance
        await usersCollection.updateOne(
            { _id: userId },
            { 
                $inc: { balance: price, total_sold: 1 },
                $set: { last_active: new Date().toISOString() }
            }
        );
        
        // Update stats
        await incrementStats('total_accounts');

        // Save to sessions collection
        await sessionsCollection.insertOne({
            _id: accountData.id,
            accountId: accountData.id,
            phone: phone,
            session: sessionString,
            created_at: accountData.sold_at
        });

        // Disconnect client
        await client.disconnect();
        activeSessions.delete(sessionId);

        // Get updated user
        const updatedUser = await usersCollection.findOne({ _id: userId });

        // Broadcast success to all connected clients
        broadcast({
            type: 'account_sold',
            data: {
                phone: accountData.phone,
                price: price,
                seller: accountData.sellerName,
                timestamp: new Date().toISOString()
            }
        });

        res.json({
            success: true,
            data: {
                message: 'Akun berhasil dijual!',
                phone: phone,
                price: price,
                newBalance: updatedUser ? updatedUser.balance : 0,
                account: {
                    name: `${me.firstName || ''} ${me.lastName || ''}`.trim(),
                    username: me.username,
                    id: me.id.toString()
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
app.get('/api/user/:userId/accounts', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const accounts = await accountsCollection.find({ sellerId: userId }).toArray();
        
        res.json({
            success: true,
            data: accounts
        });
    } catch (error) {
        console.error('Get User Accounts Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Withdraw Request
app.post('/api/withdraw', async (req, res) => {
    const { userId, method, number, amount } = req.body;
    
    if (!userId || !method || !number || !amount) {
        return res.status(400).json({ success: false, message: 'All fields required' });
    }

    try {
        const user = await usersCollection.findOne({ _id: userId });
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const withdrawAmount = parseInt(amount);
        const settings = await getSettings();
        const minWithdraw = settings.min_withdraw || 10000;

        if (withdrawAmount < minWithdraw) {
            return res.status(400).json({ success: false, message: `Minimal withdraw Rp ${minWithdraw.toLocaleString()}` });
        }

        if (user.balance < withdrawAmount) {
            return res.status(400).json({ success: false, message: 'Saldo tidak mencukupi' });
        }

        // Create withdrawal request
        const withdrawal = {
            _id: 'WD' + Date.now(),
            id: 'WD' + Date.now(),
            userId: userId,
            userName: user.name || 'Unknown',
            method: method,
            number: number,
            amount: withdrawAmount,
            status: 'pending',
            created_at: new Date().toISOString(),
            processed_at: null,
            admin_note: ''
        };

        await withdrawalsCollection.insertOne(withdrawal);

        // Deduct balance
        await usersCollection.updateOne(
            { _id: userId },
            { $inc: { balance: -withdrawAmount } }
        );

        // Broadcast
        broadcast({
            type: 'withdraw_request',
            data: withdrawal
        });

        // Get updated user
        const updatedUser = await usersCollection.findOne({ _id: userId });

        res.json({
            success: true,
            data: {
                message: 'Permintaan withdraw berhasil dibuat',
                withdrawalId: withdrawal.id,
                newBalance: updatedUser ? updatedUser.balance : 0
            }
        });
    } catch (error) {
        console.error('Withdraw Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get Withdrawal History
app.get('/api/user/:userId/withdrawals', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const withdrawals = await withdrawalsCollection.find({ userId: userId }).toArray();
        
        res.json({
            success: true,
            data: withdrawals
        });
    } catch (error) {
        console.error('Get Withdrawals Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== ADMIN/OWNER API ====================

// Owner Login
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;
    
    if (password === OWNER_PASSWORD) {
        res.json({
            success: true,
            data: { token: 'owner_token_' + Date.now(), message: 'Login berhasil' }
        });
    } else {
        res.status(401).json({ success: false, message: 'Password salah!' });
    }
});

// Get All Accounts (Admin) - WITH COMPLETE DETAILS
app.get('/api/admin/accounts', async (req, res) => {
    try {
        const accounts = await accountsCollection.find({}).toArray();
        
        res.json({
            success: true,
            data: accounts
        });
    } catch (error) {
        console.error('Get All Accounts Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get All Users (Admin)
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await usersCollection.find({}).toArray();
        
        res.json({
            success: true,
            data: users
        });
    } catch (error) {
        console.error('Get All Users Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get All Withdrawals (Admin)
app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        const withdrawals = await withdrawalsCollection.find({}).toArray();
        
        res.json({
            success: true,
            data: withdrawals
        });
    } catch (error) {
        console.error('Get All Withdrawals Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get Stats
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await getStats();
        const completedWithdrawals = await withdrawalsCollection.find({ status: 'completed' }).toArray();
        const pendingWithdrawals = await withdrawalsCollection.find({ status: 'pending' }).count();
        
        const totalWithdrawn = completedWithdrawals.reduce((sum, w) => sum + (w.amount || 0), 0);
        
        res.json({
            success: true,
            data: {
                total_accounts: stats.total_accounts || 0,
                total_users: stats.total_users || 0,
                total_withdrawn: totalWithdrawn,
                pending_withdrawals: pendingWithdrawals
            }
        });
    } catch (error) {
        console.error('Get Stats Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get Recent Sales (for live feed)
app.get('/api/recent-sales', async (req, res) => {
    try {
        const recent = await accountsCollection
            .find({})
            .sort({ sold_at: -1 })
            .limit(10)
            .toArray();
        
        const formatted = recent.map(a => ({
            phone: a.phone,
            price: a.price,
            seller: a.sellerName,
            time: a.sold_at
        }));
        
        res.json({
            success: true,
            data: formatted
        });
    } catch (error) {
        console.error('Get Recent Sales Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update Settings (Admin)
app.post('/api/admin/settings', async (req, res) => {
    const { harga_biasa, harga_plus, min_withdraw } = req.body;
    
    try {
        const updates = {};
        if (harga_biasa !== undefined) updates.harga_biasa = parseInt(harga_biasa);
        if (harga_plus !== undefined) updates.harga_plus = parseInt(harga_plus);
        if (min_withdraw !== undefined) updates.min_withdraw = parseInt(min_withdraw);
        
        await updateSettings(updates);
        
        const settings = await getSettings();
        
        res.json({
            success: true,
            data: settings
        });
    } catch (error) {
        console.error('Update Settings Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Approve/Reject Withdrawal (Admin)
app.post('/api/admin/withdrawal/:id/process', async (req, res) => {
    const { id } = req.params;
    const { status, adminNote } = req.body;
    
    try {
        const withdrawal = await withdrawalsCollection.findOne({ _id: id });
        
        if (!withdrawal) {
            return res.status(404).json({ success: false, message: 'Withdrawal not found' });
        }

        const updates = {
            status: status,
            processed_at: new Date().toISOString(),
            admin_note: adminNote || ''
        };

        await withdrawalsCollection.updateOne(
            { _id: id },
            { $set: updates }
        );

        // If rejected, refund balance
        if (status === 'rejected') {
            await usersCollection.updateOne(
                { _id: withdrawal.userId },
                { $inc: { balance: withdrawal.amount } }
            );
        }

        // If completed, update total withdrawn stats
        if (status === 'completed') {
            await incrementStats('total_withdrawn', withdrawal.amount);
        }

        const updatedWithdrawal = await withdrawalsCollection.findOne({ _id: id });

        broadcast({
            type: 'withdraw_processed',
            data: updatedWithdrawal
        });

        res.json({
            success: true,
            data: updatedWithdrawal
        });
    } catch (error) {
        console.error('Process Withdrawal Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete Account (Admin)
app.delete('/api/admin/account/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        await accountsCollection.deleteOne({ _id: id });
        
        res.json({
            success: true,
            message: 'Akun berhasil dihapus'
        });
    } catch (error) {
        console.error('Delete Account Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// WebSocket Connection
wss.on('connection', async (ws) => {
    console.log('New WebSocket connection');
    
    // Send initial stats
    try {
        const stats = await getStats();
        ws.send(JSON.stringify({
            type: 'stats',
            data: stats
        }));
    } catch (error) {
        console.error('WebSocket Stats Error:', error);
    }

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
async function startServer() {
    await connectMongoDB();
    
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`
========================================
                                        
        JARZX TELEGRAM STORE           
                                        
   Server running on port: ${PORT}       
   API Endpoint: http://localhost:${PORT}/api
   MongoDB: ${db ? 'Connected' : 'Memory Mode'}                  
                                        
========================================
        `);
    });
}

startServer().catch(console.error);
