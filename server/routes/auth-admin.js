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

        const { locationCode, locationName } = req.body;

        if (!locationCode || !locationName) {
            return res.status(400).json({ error: '拠点コードと拠点名を入力してください' });
        }

        const sanitizedCode = locationCode.replace(/[^a-zA-Z0-9_-]/g, '_');
        const dbName = `location_${sanitizedCode}.db`;

        const result = await mainDb.run(
            'INSERT INTO locations (location_code, location_name, db_name) VALUES (?, ?, ?)',
            [locationCode, locationName, dbName]
        );

        // 拠点用のデータベースを初期化
        getLocationDatabase(locationCode);

        res.json({ success: true, locationId: result.lastID });
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

module.exports = router;
