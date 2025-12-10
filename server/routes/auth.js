const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/index');
const { requireAdmin } = require('../middleware/auth');
const router = express.Router();

// ログイン
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log('Login request body:', req.body);
        console.log('Username:', username);
        console.log('Password exists:', !!password);

        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);

        console.log('User from DB:', user);
        console.log('User password from DB:', user ? user.password : 'user not found');

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
        req.session.userRole = user.role || 'user';
        res.json({ success: true, username: user.username, role: req.session.userRole });
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
        res.json({
            loggedIn: true,
            username: req.session.username,
            role: req.session.userRole || 'user'
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// ユーザー登録（管理者のみ）
router.post('/register', requireAdmin, async (req, res) => {
    try {
        const { username, password, role } = req.body;
        const hashedPassword = bcrypt.hashSync(password, 10);
        const userRole = role || 'user';

        const result = await db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
            [username, hashedPassword, userRole]
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