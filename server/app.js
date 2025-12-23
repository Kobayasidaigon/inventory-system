// 環境変数を最初に読み込む
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { startScheduledBackup } = require('./services/backup');
const { generateCsrfToken, verifyCsrfToken, getCsrfToken } = require('./middleware/csrf');

const app = express();
const PORT = process.env.PORT || 3000;

// API全体のレート制限（1分間に100リクエストまで）
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1分
    max: 100, // 最大100リクエスト
    message: {
        success: false,
        error: 'リクエストが多すぎます。しばらく待ってから再試行してください。'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// API全体にレート制限を適用
app.use('/api/', apiLimiter);

// Session設定
app.use(session({
    secret: 'inventory-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30日間
        httpOnly: true,
        secure: false // 本番環境ではtrueに設定
    }
}));

// CSRF対策ミドルウェア
app.use(generateCsrfToken);

// Routes
const authRoutes = require('./routes/auth-admin');
const publicRoutes = require('./routes/public');
const productRoutes = require('./routes/products');
const inventoryRoutes = require('./routes/inventory');
const orderRoutes = require('./routes/orders');
const qrcodeRoutes = require('./routes/qrcode');
const feedbackRoutes = require('./routes/feedback');
const { getLocationDatabase } = require('./db/database-admin');
const { requireAuth } = require('./middleware/auth');
const inventoryCountRoutes = require('./routes/inventory-count');

// CSRFトークン取得エンドポイント（検証前に設定）
app.get('/api/csrf-token', getCsrfToken);

// CSRF検証を全てのAPIに適用（GETとwebhookは除外）
app.use('/api/', verifyCsrfToken);

app.use('/api/auth', authRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/products', productRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/qrcode', qrcodeRoutes);
app.use('/api', feedbackRoutes);
app.use('/api/inventory-count', requireAuth, (req, res, next) => {
    const db = getLocationDatabase(req.session.locationCode);
    inventoryCountRoutes(db)(req, res, next);
});

// 静的ファイルの提供（CSS, JS, 画像）
app.use('/css', express.static(path.join(__dirname, '../public/css')));
app.use('/js', express.static(path.join(__dirname, '../public/js')));

// アップロード画像のパス（本番環境では /data/uploads を使用）
const uploadsPath = process.env.NODE_ENV === 'production'
    ? '/data/uploads'
    : path.join(__dirname, '../uploads');
app.use('/uploads', express.static(uploadsPath));

// ルートパス
app.get('/', async (req, res) => {
    try {
        // QRトークンによる自動ログイン
        const qrToken = req.query.qr_token;
        if (qrToken && !req.session.userId) {
            const { mainDb } = require('./db/database-admin');

            // トークンを検証
            const tokenData = await mainDb.get(
                'SELECT * FROM qr_tokens WHERE token = ? AND expires_at > datetime("now")',
                [qrToken]
            );

            if (tokenData) {
                // ユーザー情報を取得
                const user = await mainDb.get('SELECT * FROM users WHERE id = ?', [tokenData.user_id]);

                if (user) {
                    // セッションを設定
                    req.session.userId = user.id;
                    req.session.userName = user.user_name;
                    req.session.isAdmin = user.is_admin === 1;

                    // 一般ユーザーの場合は拠点情報も取得
                    if (!req.session.isAdmin) {
                        const location = await mainDb.get(
                            'SELECT * FROM locations WHERE id = ?',
                            [user.location_id]
                        );
                        if (location) {
                            req.session.locationId = location.id;
                            req.session.locationCode = location.location_code;
                        }
                    }

                    console.log(`QRトークンで自動ログイン: ${user.user_name}`);
                }
            }
        }

        if (!req.session.userId) {
            return res.sendFile(path.join(__dirname, '../public/login.html'));
        }
        // 管理者の場合は管理画面へ
        if (req.session.isAdmin) {
            return res.sendFile(path.join(__dirname, '../public/admin.html'));
        }
        res.sendFile(path.join(__dirname, '../public/index.html'));
    } catch (error) {
        console.error('Route error:', error);
        res.sendFile(path.join(__dirname, '../public/login.html'));
    }
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
app.listen(PORT, () => {
    console.log(`サーバーが起動しました: http://localhost:${PORT}`);

    // 定期バックアップを開始（24時間ごと）
    // 環境変数で間隔を設定可能（時間単位）
    const backupInterval = parseInt(process.env.BACKUP_INTERVAL_HOURS) || 24;
    startScheduledBackup(backupInterval);
});