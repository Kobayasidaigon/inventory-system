// 環境変数を最初に読み込む
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const { startScheduledBackup } = require('./services/backup');
const { startShiftMonitor } = require('./services/shift-monitor');
const { generateCsrfToken, verifyCsrfToken, getCsrfToken } = require('./middleware/csrf');
const { attachRememberedSession } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// API全体のレート制限（既定は 1 分間に 100 リクエストまで）。
// 上限は環境変数 API_RATE_LIMIT_MAX で変更できる。既定値は変えていないので、
// 設定しなければこれまでと同じ動きになる。
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1分
    max: parseInt(process.env.API_RATE_LIMIT_MAX, 10) || 100,
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

const isProduction = process.env.NODE_ENV === 'production';

// Fly.io は TLS を手前で終端し、アプリには HTTP で渡す。
// これを教えておかないと req.secure が常に false になり、
// secure なセッション Cookie が一切発行されずログインできなくなる。
if (isProduction) {
    app.set('trust proxy', 1);
}

/**
 * セッションの署名鍵を決める。
 *
 * 以前はソースに直接書いていたが、このリポジトリは公開されているため、
 * 誰でも同じ鍵でセッション Cookie を偽造して管理者になりすませる状態だった。
 * 必ず環境変数から読む。
 */
function resolveSessionSecret() {
    if (process.env.SESSION_SECRET) {
        return process.env.SESSION_SECRET;
    }

    if (isProduction) {
        // 本番で未設定のまま落とすと店の業務が止まるので、起動はさせる。
        // ただし毎回違う鍵になるため、再起動のたびに全員ログアウトになる。
        // それを警告として見せて、設定を促す。
        console.error(
            '\n[警告] SESSION_SECRET が設定されていません。\n' +
            '        起動のたびに鍵が変わるため、再起動すると全員ログアウトします。\n' +
            '        flyctl secrets set SESSION_SECRET=$(openssl rand -base64 32)\n'
        );
        return crypto.randomBytes(32).toString('hex');
    }

    // 開発用。毎回ログインし直さずに済むよう固定値にする。
    return 'development-only-session-secret';
}

// セッションの保存先。
//
// 既定のメモリ保持だと、サーバーが再起動するたびに全員のログインが切れる。
// Fly.io はアクセスが途切れるとマシンを止めるので、これが毎日のように起きる。
// 永続ディスク上の SQLite に置いて、再起動をまたいでも残るようにする。
const sessionDir = process.env.DB_DIR || path.join(__dirname, 'db');

if (!require('fs').existsSync(sessionDir)) {
    require('fs').mkdirSync(sessionDir, { recursive: true });
}

// Session設定
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: sessionDir, table: 'sessions' }),
    secret: resolveSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30日間
        httpOnly: true,
        // 本番は HTTPS 前提（fly.toml で force_https = true）
        secure: isProduction,
        sameSite: 'lax'
    }
}));

// セッションが失われていても Remember Me トークンで復帰させる。
// ルートより前に置くことで、管理画面の API も含めて全体に効かせる。
app.use(attachRememberedSession);

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
const shiftRoutes = require('./routes/shifts');
const staffRoutes = require('./routes/staff');
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
app.use('/api/shifts', shiftRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api', feedbackRoutes);
app.use('/api/inventory-count', requireAuth, (req, res, next) => {
    const db = getLocationDatabase(req.session.locationCode);
    inventoryCountRoutes(db)(req, res, next);
});

// 静的ファイルの提供（CSS, JS, 画像）
app.use('/css', express.static(path.join(__dirname, '../public/css')));
app.use('/js', express.static(path.join(__dirname, '../public/js')));

// アップロード画像のパス（本番環境では /data/uploads を使用）
// UPLOADS_DIR で差し替え可能。products.js と同じ場所を指すこと。
const uploadsPath = process.env.UPLOADS_DIR
    || (isProduction ? '/data/uploads' : path.join(__dirname, '../uploads'));
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

    // シフトの区切りが未確認のまま過ぎていないか見張る。
    // 注意: この手の定期処理は、マシンが動いている間しか走らない。
    // Fly.io では min_machines_running = 1 が必要（fly.toml のコメント参照）。
    if (process.env.SHIFT_MONITOR !== 'off') {
        // 間隔の既定値は services/shift-monitor.js 側で持つ
        startShiftMonitor(parseInt(process.env.SHIFT_CHECK_INTERVAL_MINUTES, 10) || undefined);
    }
});