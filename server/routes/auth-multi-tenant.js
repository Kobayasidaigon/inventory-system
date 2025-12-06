const express = require('express');
const bcrypt = require('bcryptjs');
const { mainDb } = require('../db/database-multi-tenant');
const router = express.Router();

// ログイン
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        const user = await mainDb.get('SELECT * FROM users WHERE username = ?', [username]);

        if (!user) {
            return res.status(401).json({ error: 'ユーザー名またはパスワードが間違っています' });
        }

        if (!user.password) {
            console.error('User password is undefined in database!');
            return res.status(500).json({ error: 'データベースエラー: パスワードが見つかりません' });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ error: 'ユーザー名またはパスワードが間違っています' });
        }

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.dbName = user.db_name;

        res.json({ success: true, username: user.username });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'データベースエラー' });
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
        res.json({ loggedIn: true, username: req.session.username });
    } else {
        res.json({ loggedIn: false });
    }
});

// ユーザー登録
router.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);
        const sanitizedUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
        const dbName = `inventory_${sanitizedUsername}.db`;

        const result = await mainDb.run(
            'INSERT INTO users (username, password, db_name) VALUES (?, ?, ?)',
            [username, hashedPassword, dbName]
        );

        res.json({ success: true, userId: result.lastID });
    } catch (err) {
        console.error('Register error:', err);
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'このユーザー名は既に使用されています' });
        }
        res.status(500).json({ error: 'ユーザー登録に失敗しました' });
    }
});

module.exports = router;
