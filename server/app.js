const express = require('express');
const session = require('express-session');
const path = require('path');
const initDatabase = require('./db/init-db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session設定
app.use(session({
    secret: 'inventory-secret-key-2024',
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
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

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

// 初期セットアップ画面
app.get('/setup.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/setup.html'));
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