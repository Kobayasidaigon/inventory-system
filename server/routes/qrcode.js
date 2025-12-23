const express = require('express');
const QRCode = require('qrcode');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// 出庫ページへのQRコード生成
router.get('/out-stock', requireAuth, async (req, res) => {
    try {
        // 現在のホストを取得
        const protocol = req.protocol;
        const host = req.get('host');

        // 出庫ページへのURLを生成（ページパラメータ付き）
        const url = `${protocol}://${host}/?page=out`;

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
