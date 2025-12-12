const express = require('express');
const bcrypt = require('bcryptjs');
const { mainDb, getLocationDatabase } = require('../db/database-admin');
const router = express.Router();

// 管理者ログイン
router.post('/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;

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

        res.json({ success: true, userName: user.user_name, isAdmin: true });
    } catch (err) {
        console.error('Admin login error:', err);
        res.status(500).json({ error: 'ログインエラー' });
    }
});

// 一般ユーザーログイン
router.post('/login', async (req, res) => {
    try {
        const { locationCode, userId, password } = req.body;

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
router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'ログアウトに失敗しました' });
        }
        res.json({ success: true });
    });
});

// ログイン状態確認
router.get('/check', (req, res) => {
    if (req.session.userId) {
        res.json({
            loggedIn: true,
            userName: req.session.userName,
            isAdmin: req.session.isAdmin || false,
            locationCode: req.session.locationCode
        });
    } else {
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
        const { userName, password } = req.body;

        if (!userName) {
            return res.status(400).json({ error: 'ユーザー名を入力してください' });
        }

        // パスワードが指定されている場合のみ更新
        if (password) {
            const hashedPassword = bcrypt.hashSync(password, 10);
            await mainDb.run(
                'UPDATE users SET user_name = ?, password = ? WHERE id = ?',
                [userName, hashedPassword, id]
            );
        } else {
            await mainDb.run(
                'UPDATE users SET user_name = ? WHERE id = ?',
                [userName, id]
            );
        }

        res.json({ success: true, message: 'ユーザーを更新しました' });
    } catch (err) {
        console.error('User update error:', err);
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

module.exports = router;
