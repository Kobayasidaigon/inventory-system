const express = require('express');
const session = require('express-session');
const path = require('path');
const initDatabase = require('./db/init-db');

const app = express();
const PORT = process.env.PORT || 3000;

// アップロードディレクトリのパス（環境変数または既定値）
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session設定
app.use(session({
    secret: process.env.SESSION_SECRET || 'inventory-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24時間
}));

// Routes
const authRoutes = require('./routes/auth-admin');
const publicRoutes = require('./routes/public');
const productRoutes = require('./routes/products');
const inventoryRoutes = require('./routes/inventory');
const orderRoutes = require('./routes/orders');

app.use('/api/auth', authRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/products', productRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/orders', orderRoutes);

// 静的ファイルの提供（CSS, JS, 画像）
app.use('/css', express.static(path.join(__dirname, '../public/css')));
app.use('/js', express.static(path.join(__dirname, '../public/js')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ルートパス
app.get('/', (req, res) => {
    if (!req.session.userId) {
        return res.sendFile(path.join(__dirname, '../public/login.html'));
    }
    // 管理者の場合は管理画面へ
    if (req.session.isAdmin) {
        return res.sendFile(path.join(__dirname, '../public/admin.html'));
    }
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 初期セットアップ画面（管理者が存在しない場合のみアクセス可能）
app.get('/setup.html', async (req, res) => {
    try {
        const { mainDb } = require('./db/database-admin');
        const existingAdmin = await mainDb.get('SELECT * FROM users WHERE is_admin = 1');

        if (existingAdmin) {
            // 管理者が既に存在する場合はアクセス拒否
            return res.status(403).send('管理者アカウントは既に作成されています');
        }

        res.sendFile(path.join(__dirname, '../public/setup.html'));
    } catch (err) {
        console.error('Setup page access error:', err);
        res.status(500).send('サーバーエラー');
    }
});

// 管理画面
app.get('/admin.html', (req, res) => {
    if (!req.session.isAdmin) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// その他のHTMLファイルへの直接アクセスを防ぐ
app.get('/login.html', (req, res) => {
    res.redirect('/');
});

app.get('/index.html', (req, res) => {
    res.redirect('/');
});

// エラーハンドリング
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
});

// サーバー起動
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`サーバーが起動しました: http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('データベース初期化エラー:', err);
});