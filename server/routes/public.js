const express = require('express');
const { mainDb } = require('../db/database-admin');
const router = express.Router();

// 拠点一覧取得（公開API - ログイン不要）
router.get('/locations', async (req, res) => {
    try {
        const locations = await mainDb.all(
            'SELECT id, location_code, location_name FROM locations ORDER BY location_code'
        );
        res.json(locations);
    } catch (err) {
        console.error('Get locations error:', err);
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

module.exports = router;
