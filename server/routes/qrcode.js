const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { mainDb } = require('../db/database-admin');

const router = express.Router();

// QRトークンを生成
function generateQRToken() {
    return crypto.randomBytes(32).toString('hex');
}

// 出庫ページへのQRコード生成
router.get('/out-stock', requireAuth, async (req, res) => {
    try {
        // QRトークンを生成
        const token = generateQRToken();
        const expiresAt = new Date();
        expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1年間有効

        // トークンをDBに保存
        await mainDb.run(
            'INSERT INTO qr_tokens (user_id, product_id, token, expires_at) VALUES (?, ?, ?, ?)',
            [req.session.userId, 0, token, expiresAt.toISOString()]
        );

        // 現在のホストを取得
        const protocol = req.protocol;
        const host = req.get('host');

        // 出庫ページへのURLを生成（トークン付き）
        const url = `${protocol}://${host}/?page=out&qr_token=${token}`;

        // QRコードを生成（Data URL形式）
        const qrCodeDataUrl = await QRCode.toDataURL(url, {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            width: 300,
            margin: 2
        });

        res.json({
            success: true,
            qrCodeUrl: qrCodeDataUrl,
            targetUrl: url
        });
    } catch (error) {
        console.error('QRコード生成エラー:', error);
        res.status(500).json({ error: 'QRコードの生成に失敗しました' });
    }
});

module.exports = router;
