const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { mainDb, getLocationDatabase } = require('../db/database-admin');
const { backupDatabase, listBackups, restoreDatabase, BACKUP_DIR } = require('../services/backup');
const path = require('path');
const router = express.Router();

// Remember Meトークンを生成
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Remember Meトークンを保存
async function saveRememberToken(userId) {
    const token = generateToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 365); // 1年後

    await mainDb.run(
        'INSERT INTO remember_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
        [userId, token, expiresAt.toISOString()]
    );

    return token;
}

// Remember Meトークンで認証
async function authenticateByToken(token) {
    const tokenData = await mainDb.get(
        'SELECT * FROM remember_tokens WHERE token = ? AND expires_at > datetime("now")',
        [token]
    );

    if (!tokenData) {
        return null;
    }

    const user = await mainDb.get(
        'SELECT * FROM users WHERE id = ?',
        [tokenData.user_id]
    );

    return user;
}

// 管理者ログイン
router.post('/admin/login', async (req, res) => {
    try {
        const { username, password, rememberMe } = req.body;

        // 管理者ユーザーを確認（is_admin = 1）
        const user = await mainDb.get(
            'SELECT * FROM users WHERE user_id = ? AND is_admin = 1',
            [username]
        );

        if (!user) {
            return res.status(401).json({ error: '管理者権限がありません' });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ error: 'パスワードが間違っています' });
        }

        req.session.userId = user.id;
        req.session.userName = user.user_name;
        req.session.isAdmin = true;

        // Remember Me処理
        if (rememberMe) {
            const token = await saveRememberToken(user.id);
            res.cookie('remember_token', token, {
                maxAge: 365 * 24 * 60 * 60 * 1000, // 1年
                httpOnly: true,
                secure: false // 本番環境ではtrueに設定
            });
        }

        res.json({ success: true, userName: user.user_name, isAdmin: true });
    } catch (err) {
        console.error('Admin login error:', err);
        res.status(500).json({ error: 'ログインエラー' });
    }
});

// 一般ユーザーログイン
router.post('/login', async (req, res) => {
    try {
        const { locationCode, userId, password, rememberMe } = req.body;

        if (!locationCode || !userId || !password) {
            return res.status(400).json({ error: '拠点コード、ユーザーID、パスワードを入力してください' });
        }

        // 拠点を確認
        const location = await mainDb.get(
            'SELECT * FROM locations WHERE location_code = ?',
            [locationCode]
        );

        if (!location) {
            return res.status(401).json({ error: '拠点が見つかりません' });
        }

        // ユーザーを確認
        const user = await mainDb.get(
            'SELECT * FROM users WHERE location_id = ? AND user_id = ?',
            [location.id, userId]
        );

        if (!user) {
            return res.status(401).json({ error: 'ユーザーが見つかりません' });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ error: 'パスワードが間違っています' });
        }

        req.session.userId = user.id;
        req.session.userName = user.user_name;
        req.session.locationId = location.id;
        req.session.locationCode = location.location_code;
        req.session.isAdmin = false;

        // Remember Me処理
        if (rememberMe) {
            const token = await saveRememberToken(user.id);
            res.cookie('remember_token', token, {
                maxAge: 365 * 24 * 60 * 60 * 1000, // 1年
                httpOnly: true,
                secure: false // 本番環境ではtrueに設定
            });
        }

        res.json({
            success: true,
            userName: user.user_name,
            locationName: location.location_name
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'ログインエラー' });
    }
});

// ログアウト
router.post('/logout', async (req, res) => {
    try {
        const token = req.cookies.remember_token;

        // Remember Meトークンを削除
        if (token) {
            await mainDb.run('DELETE FROM remember_tokens WHERE token = ?', [token]);
            res.clearCookie('remember_token');
        }

        req.session.destroy((err) => {
            if (err) {
                return res.status(500).json({ error: 'ログアウトに失敗しました' });
            }
            res.json({ success: true });
        });
    } catch (err) {
        console.error('Logout error:', err);
        res.status(500).json({ error: 'ログアウトに失敗しました' });
    }
});

// ログイン状態確認
router.get('/check', async (req, res) => {
    try {
        // セッションがあればそのまま返す
        if (req.session.userId) {
            return res.json({
                loggedIn: true,
                userName: req.session.userName,
                isAdmin: req.session.isAdmin || false,
                locationCode: req.session.locationCode
            });
        }

        // セッションがない場合、Remember Meトークンをチェック
        const token = req.cookies.remember_token;
        if (token) {
            const user = await authenticateByToken(token);
            if (user) {
                // ユーザーが見つかった場合、セッションを再作成
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

                return res.json({
                    loggedIn: true,
                    userName: user.user_name,
                    isAdmin: req.session.isAdmin,
                    locationCode: req.session.locationCode
                });
            }
        }

        res.json({ loggedIn: false });
    } catch (err) {
        console.error('Auth check error:', err);
        res.json({ loggedIn: false });
    }
});

// 拠点登録（管理者のみ）
router.post('/admin/locations', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const { locationName } = req.body;

        if (!locationName) {
            return res.status(400).json({ error: '拠点名を入力してください' });
        }

        // 次の拠点コードを自動生成（数値オートインクリメント）
        const maxLocation = await mainDb.get('SELECT MAX(CAST(location_code AS INTEGER)) as max_code FROM locations WHERE location_code GLOB "[0-9]*"');
        const nextCode = (maxLocation && maxLocation.max_code ? parseInt(maxLocation.max_code) + 1 : 1).toString();

        const dbName = `location_${nextCode}.db`;

        const result = await mainDb.run(
            'INSERT INTO locations (location_code, location_name, db_name) VALUES (?, ?, ?)',
            [nextCode, locationName, dbName]
        );

        // 拠点用のデータベースを初期化
        getLocationDatabase(nextCode);

        res.json({ success: true, locationId: result.lastID, locationCode: nextCode });
    } catch (err) {
        console.error('Location registration error:', err);
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'この拠点コードは既に使用されています' });
        }
        res.status(500).json({ error: '拠点登録に失敗しました' });
    }
});

// 拠点一覧取得（管理者のみ）
router.get('/admin/locations', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const locations = await mainDb.all(
            'SELECT id, location_code, location_name, created_at FROM locations ORDER BY location_code'
        );

        res.json(locations);
    } catch (err) {
        console.error('Get locations error:', err);
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

// 拠点編集（管理者のみ）
router.put('/admin/locations/:id', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const { id } = req.params;
        const { locationName } = req.body;

        if (!locationName) {
            return res.status(400).json({ error: '拠点名を入力してください' });
        }

        await mainDb.run(
            'UPDATE locations SET location_name = ? WHERE id = ?',
            [locationName, id]
        );

        res.json({ success: true, message: '拠点を更新しました' });
    } catch (err) {
        console.error('Location update error:', err);
        res.status(500).json({ error: '拠点の更新に失敗しました' });
    }
});

// 拠点削除（管理者のみ）
router.delete('/admin/locations/:id', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const { id } = req.params;

        console.log('Attempting to delete location with id:', id);

        // 拠点に紐づくユーザーが存在するか確認
        const users = await mainDb.all(
            'SELECT id FROM users WHERE location_id = ?',
            [id]
        );

        if (users.length > 0) {
            return res.status(400).json({
                error: 'この拠点にはユーザーが登録されています。先にユーザーを削除してください。'
            });
        }

        const result = await mainDb.run('DELETE FROM locations WHERE id = ?', [id]);

        console.log('Delete location result:', result);

        if (result.changes === 0) {
            return res.status(404).json({ error: '拠点が見つかりませんでした' });
        }

        res.json({ success: true, message: '拠点を削除しました' });
    } catch (err) {
        console.error('Location delete error:', err);
        res.status(500).json({ error: '拠点の削除に失敗しました: ' + err.message });
    }
});

// ユーザー登録（管理者のみ）
router.post('/admin/users', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const { locationId, userId, userName, password } = req.body;

        if (!locationId || !userId || !userName || !password) {
            return res.status(400).json({ error: 'すべての項目を入力してください' });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);

        const result = await mainDb.run(
            'INSERT INTO users (location_id, user_id, user_name, password, is_admin) VALUES (?, ?, ?, ?, 0)',
            [locationId, userId, userName, hashedPassword]
        );

        res.json({ success: true, userId: result.lastID });
    } catch (err) {
        console.error('User registration error:', err);
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'このユーザーIDは既に使用されています' });
        }
        res.status(500).json({ error: 'ユーザー登録に失敗しました' });
    }
});

// 拠点別ユーザー一覧取得（管理者のみ）
router.get('/admin/locations/:locationId/users', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const locationId = req.params.locationId;

        const users = await mainDb.all(
            'SELECT id, user_id, user_name, created_at FROM users WHERE location_id = ? AND is_admin = 0 ORDER BY user_id',
            [locationId]
        );

        res.json(users);
    } catch (err) {
        console.error('Get users error:', err);
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

// ユーザー編集（管理者のみ）
router.put('/admin/users/:id', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const { id } = req.params;
        const { userId, userName, password } = req.body;

        if (!userName) {
            return res.status(400).json({ error: 'ユーザー名を入力してください' });
        }

        // ユーザーIDとユーザー名、パスワードを更新
        if (password) {
            const hashedPassword = bcrypt.hashSync(password, 10);
            if (userId) {
                await mainDb.run(
                    'UPDATE users SET user_id = ?, user_name = ?, password = ? WHERE id = ?',
                    [userId, userName, hashedPassword, id]
                );
            } else {
                await mainDb.run(
                    'UPDATE users SET user_name = ?, password = ? WHERE id = ?',
                    [userName, hashedPassword, id]
                );
            }
        } else {
            if (userId) {
                await mainDb.run(
                    'UPDATE users SET user_id = ?, user_name = ? WHERE id = ?',
                    [userId, userName, id]
                );
            } else {
                await mainDb.run(
                    'UPDATE users SET user_name = ? WHERE id = ?',
                    [userName, id]
                );
            }
        }

        res.json({ success: true, message: 'ユーザーを更新しました' });
    } catch (err) {
        console.error('User update error:', err);
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'このユーザーIDは既に使用されています' });
        }
        res.status(500).json({ error: 'ユーザーの更新に失敗しました' });
    }
});

// ユーザー削除（管理者のみ）
router.delete('/admin/users/:id', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const { id } = req.params;

        console.log('Attempting to delete user with id:', id);

        const result = await mainDb.run('DELETE FROM users WHERE id = ? AND is_admin = 0', [id]);

        console.log('Delete result:', result);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'ユーザーが見つかりませんでした' });
        }

        res.json({ success: true, message: 'ユーザーを削除しました' });
    } catch (err) {
        console.error('User delete error:', err);
        res.status(500).json({ error: 'ユーザーの削除に失敗しました: ' + err.message });
    }
});

// 管理者ユーザー初期作成（初回のみ実行）
router.post('/admin/init', async (req, res) => {
    try {
        const { username, password } = req.body;

        // 既に管理者が存在するかチェック
        const existingAdmin = await mainDb.get('SELECT * FROM users WHERE is_admin = 1');

        if (existingAdmin) {
            return res.status(400).json({ error: '管理者は既に登録されています' });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);

        const result = await mainDb.run(
            'INSERT INTO users (location_id, user_id, user_name, password, is_admin) VALUES (0, ?, ?, ?, 1)',
            [username, username, hashedPassword]
        );

        res.json({ success: true, message: '管理者アカウントを作成しました' });
    } catch (err) {
        console.error('Admin init error:', err);
        res.status(500).json({ error: '管理者アカウント作成に失敗しました' });
    }
});

// 拠点の在庫データ取得（管理者のみ）
router.get('/admin/locations/:locationId/inventory', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const locationId = req.params.locationId;

        // 拠点情報を取得
        const location = await mainDb.get('SELECT * FROM locations WHERE id = ?', [locationId]);

        if (!location) {
            return res.status(404).json({ error: '拠点が見つかりません' });
        }

        // 拠点のデータベースを取得
        const db = getLocationDatabase(location.location_code);

        // 在庫データを取得
        const products = await db.all(`
            SELECT id, name, category, current_stock, reorder_point, created_at, updated_at
            FROM products
            ORDER BY category, name
        `);

        res.json({
            locationName: location.location_name,
            locationCode: location.location_code,
            products: products
        });
    } catch (err) {
        console.error('Get inventory error:', err);
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

// 拠点の発注データ取得（管理者のみ）
router.get('/admin/locations/:locationId/orders', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const locationId = req.params.locationId;

        // 拠点情報を取得
        const location = await mainDb.get('SELECT * FROM locations WHERE id = ?', [locationId]);

        if (!location) {
            return res.status(404).json({ error: '拠点が見つかりません' });
        }

        // 拠点のデータベースを取得
        const db = getLocationDatabase(location.location_code);

        // 発注データを取得
        const orders = await db.all(`
            SELECT o.*, p.name as product_name, p.current_stock, p.reorder_point
            FROM order_requests o
            JOIN products p ON o.product_id = p.id
            ORDER BY o.requested_at DESC
        `);

        // ユーザー名をメインDBから取得して追加
        for (let order of orders) {
            const user = await mainDb.get('SELECT user_name FROM users WHERE id = ?', [order.user_id]);
            order.username = user ? user.user_name : '不明';
        }

        res.json({
            locationName: location.location_name,
            locationCode: location.location_code,
            orders: orders
        });
    } catch (err) {
        console.error('Get orders error:', err);
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

// 拠点の在庫推移グラフデータ取得（管理者のみ）
router.get('/admin/locations/:locationId/chart/:productId', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const locationId = req.params.locationId;
        const productId = req.params.productId;
        const { days = 30 } = req.query;

        // 拠点情報を取得
        const location = await mainDb.get('SELECT * FROM locations WHERE id = ?', [locationId]);

        if (!location) {
            return res.status(404).json({ error: '拠点が見つかりません' });
        }

        // 拠点のデータベースを取得
        const db = getLocationDatabase(location.location_code);

        // 商品名を取得
        const product = await db.get('SELECT name, reorder_point FROM products WHERE id = ?', [productId]);

        if (!product) {
            return res.status(404).json({ error: '商品が見つかりません' });
        }

        // 指定日数分の在庫履歴を取得
        const query = `
            SELECT
                COALESCE(h.date, DATE(h.created_at)) as date,
                h.type,
                h.quantity,
                h.created_at
            FROM inventory_history h
            WHERE h.product_id = ?
            AND DATE(COALESCE(h.date, h.created_at)) >= DATE('now', '-' || ? || ' days')
            ORDER BY h.created_at ASC
        `;

        const history = await db.all(query, [productId, days]);

        // 現在の在庫を取得
        const currentProduct = await db.get('SELECT current_stock FROM products WHERE id = ?', [productId]);

        // 日付ごとに在庫を計算
        const today = new Date();
        const startDate = new Date(today);
        startDate.setDate(today.getDate() - days);

        const dateMap = {};
        let stock = currentProduct.current_stock;

        // 履歴を逆順に処理して各日の在庫を復元
        for (let i = history.length - 1; i >= 0; i--) {
            const item = history[i];
            const date = item.date;

            if (!dateMap[date]) {
                dateMap[date] = stock;
            }

            // 履歴を遡って在庫を戻す
            if (item.type === 'in') {
                stock -= item.quantity;
            } else if (item.type === 'out') {
                stock += item.quantity;
            }
        }

        // 日付配列とデータを生成
        const labels = [];
        const stocks = [];

        for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
            labels.push(dateStr);

            if (dateMap[dateStr] !== undefined) {
                stocks.push(dateMap[dateStr]);
                stock = dateMap[dateStr];
            } else {
                stocks.push(stock);
            }
        }

        res.json({
            productName: product.name,
            reorderPoint: product.reorder_point,
            labels: labels,
            stocks: stocks
        });
    } catch (err) {
        console.error('Get chart error:', err);
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

// 発注ステータス更新（管理者のみ）
router.put('/admin/locations/:locationId/orders/:orderId/status', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const { locationId, orderId } = req.params;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({ error: 'ステータスを指定してください' });
        }

        // 有効なステータスかチェック
        const validStatuses = ['pending', 'ordered', 'received', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: '無効なステータスです' });
        }

        // 拠点情報を取得
        const location = await mainDb.get('SELECT * FROM locations WHERE id = ?', [locationId]);

        if (!location) {
            return res.status(404).json({ error: '拠点が見つかりません' });
        }

        // 拠点のデータベースを取得
        const db = getLocationDatabase(location.location_code);

        // 発注を更新
        const result = await db.run(
            'UPDATE order_requests SET status = ? WHERE id = ?',
            [status, orderId]
        );

        if (result.changes === 0) {
            return res.status(404).json({ error: '発注が見つかりませんでした' });
        }

        res.json({ success: true, message: 'ステータスを更新しました' });
    } catch (err) {
        console.error('Update order status error:', err);
        res.status(500).json({ error: 'ステータスの更新に失敗しました' });
    }
});

// 全拠点の在庫データ取得（管理者のみ）
router.get('/admin/all-inventory', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        // すべての拠点を取得
        const locations = await mainDb.all('SELECT * FROM locations ORDER BY location_code');

        const allProducts = [];

        // 各拠点の在庫データを取得
        for (const location of locations) {
            const db = getLocationDatabase(location.location_code);

            const products = await db.all(`
                SELECT id, name, category, current_stock, reorder_point, created_at, updated_at
                FROM products
                ORDER BY category, name
            `);

            // 各商品に拠点情報と発注状況を追加
            for (const product of products) {
                // 未処理の発注依頼があるかチェック
                const pendingOrder = await db.get(
                    `SELECT id, requested_quantity, requested_at
                     FROM order_requests
                     WHERE product_id = ? AND status = 'pending'
                     ORDER BY requested_at DESC
                     LIMIT 1`,
                    [product.id]
                );

                allProducts.push({
                    ...product,
                    location_id: location.id,
                    location_name: location.location_name,
                    location_code: location.location_code,
                    has_pending_order: !!pendingOrder,
                    pending_order_quantity: pendingOrder ? pendingOrder.requested_quantity : null
                });
            }
        }

        res.json({
            products: allProducts
        });
    } catch (err) {
        console.error('Get all inventory error:', err);
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

// 全拠点の発注データ取得（管理者のみ）
router.get('/admin/all-orders', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        // すべての拠点を取得
        const locations = await mainDb.all('SELECT * FROM locations ORDER BY location_code');

        const allOrders = [];

        // 各拠点の発注データを取得
        for (const location of locations) {
            const db = getLocationDatabase(location.location_code);

            const orders = await db.all(`
                SELECT o.*, p.name as product_name, p.current_stock, p.reorder_point
                FROM order_requests o
                JOIN products p ON o.product_id = p.id
                ORDER BY o.requested_at DESC
            `);

            // ユーザー名をメインDBから取得して追加
            for (const order of orders) {
                const user = await mainDb.get('SELECT user_name FROM users WHERE id = ?', [order.user_id]);
                allOrders.push({
                    ...order,
                    username: user ? user.user_name : '不明',
                    location_id: location.id,
                    location_name: location.location_name,
                    location_code: location.location_code
                });
            }
        }

        res.json({
            orders: allOrders
        });
    } catch (err) {
        console.error('Get all orders error:', err);
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

// データベースバックアップ（管理者のみ）
router.post('/admin/backup', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        console.log('管理者によるバックアップ要求');
        const result = await backupDatabase();

        if (result.success) {
            res.json({
                success: true,
                message: result.message,
                backupFile: result.backupFile,
                size: result.size
            });
        } else {
            res.status(500).json({ error: result.message });
        }
    } catch (err) {
        console.error('Backup error:', err);
        res.status(500).json({ error: 'バックアップに失敗しました' });
    }
});

// バックアップ一覧取得（管理者のみ）
router.get('/admin/backups', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const backups = listBackups();
        res.json({ backups });
    } catch (err) {
        console.error('Get backups error:', err);
        res.status(500).json({ error: 'バックアップ一覧の取得に失敗しました' });
    }
});

// バックアップダウンロード（管理者のみ）
router.get('/admin/backup/:filename', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const { filename } = req.params;

        // セキュリティチェック: ファイル名にパストラバーサルがないか確認
        if (filename.includes('..') || filename.includes('/')) {
            return res.status(400).json({ error: '不正なファイル名です' });
        }

        // バックアップファイル名のフォーマットチェック
        if (!filename.startsWith('backup_') || !filename.endsWith('.tar.gz')) {
            return res.status(400).json({ error: '不正なファイル名です' });
        }

        const filePath = path.join(BACKUP_DIR, filename);

        // ファイルの存在確認
        const fs = require('fs');
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'バックアップファイルが見つかりません' });
        }

        // ファイルをダウンロード
        res.download(filePath, filename, (err) => {
            if (err) {
                console.error('Download error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'ダウンロードに失敗しました' });
                }
            }
        });
    } catch (err) {
        console.error('Backup download error:', err);
        res.status(500).json({ error: 'ダウンロードに失敗しました' });
    }
});

// バックアップから復元（管理者のみ）
router.post('/admin/restore/:filename', async (req, res) => {
    try {
        if (!req.session.isAdmin) {
            return res.status(403).json({ error: '管理者権限が必要です' });
        }

        const { filename } = req.params;

        console.log(`管理者によるリストア要求: ${filename}`);
        const result = await restoreDatabase(filename);

        if (result.success) {
            res.json({
                success: true,
                message: result.message
            });
        } else {
            res.status(500).json({ error: result.message });
        }
    } catch (err) {
        console.error('Restore error:', err);
        res.status(500).json({ error: 'リストアに失敗しました' });
    }
});

module.exports = router;
