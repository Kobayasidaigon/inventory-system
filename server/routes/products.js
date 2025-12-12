const express = require('express');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const { getLocationDatabase } = require('../db/database-admin');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// Multer設定（画像アップロード）
const fs = require('fs');
const uploadsDir = process.env.NODE_ENV === 'production'
    ? '/data/uploads'
    : path.join(__dirname, '../../uploads');

// アップロードディレクトリが存在しない場合は作成
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// 一時フォルダを使用
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb(new Error('画像ファイルのみアップロード可能です'));
    }
};

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB制限（圧縮前）
    fileFilter: fileFilter
});

// 画像を圧縮・リサイズする関数
async function optimizeImage(buffer, filename) {
    const outputPath = path.join(uploadsDir, filename);

    await sharp(buffer)
        .rotate() // EXIFの回転情報を自動適用
        .resize(800, 800, {
            fit: 'inside',
            withoutEnlargement: true
        })
        .jpeg({ quality: 80 })
        .toFile(outputPath);

    return filename;
}

// 商品一覧取得
router.get('/', requireAuth, async (req, res) => {
    try {
        const db = getLocationDatabase(req.session.locationCode);
        const products = await db.all('SELECT * FROM products ORDER BY category, name', []);
        res.json(products);
    } catch (err) {
        console.error('Get products error:', err);
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

// 商品追加（画像アップロード対応）
router.post('/', requireAuth, upload.single('image'), async (req, res) => {
    try {
        const db = getLocationDatabase(req.session.locationCode);
        const { name, category, reorder_point, current_stock } = req.body;

        let imageUrl = null;
        if (req.file) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const filename = 'product-' + uniqueSuffix + '.jpg';
            await optimizeImage(req.file.buffer, filename);
            imageUrl = `/uploads/${filename}`;
        }

        const result = await db.run(
            `INSERT INTO products (name, category, reorder_point, current_stock, image_url)
             VALUES (?, ?, ?, ?, ?)`,
            [name, category || '', reorder_point || 0, current_stock || 0, imageUrl]
        );

        res.json({ success: true, productId: result.lastID });
    } catch (err) {
        console.error('商品登録エラー:', err);
        res.status(500).json({ error: '商品登録に失敗しました: ' + err.message });
    }
});

// 商品更新（画像アップロード対応）
router.put('/:id', requireAuth, upload.single('image'), async (req, res) => {
    try {
        const db = getLocationDatabase(req.session.locationCode);
        const { name, category, reorder_point, current_stock } = req.body;
        const productId = req.params.id;

        let imageUrl = undefined;
        if (req.file) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const filename = 'product-' + uniqueSuffix + '.jpg';
            await optimizeImage(req.file.buffer, filename);
            imageUrl = `/uploads/${filename}`;
        }

        let query, params;
        if (imageUrl) {
            query = `UPDATE products
                     SET name = ?, category = ?, reorder_point = ?, current_stock = ?, image_url = ?,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`;
            params = [name, category, reorder_point, current_stock, imageUrl, productId];
        } else {
            query = `UPDATE products
                     SET name = ?, category = ?, reorder_point = ?, current_stock = ?,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`;
            params = [name, category, reorder_point, current_stock, productId];
        }

        await db.run(query, params);
        res.json({ success: true });
    } catch (err) {
        console.error('商品更新エラー:', err);
        res.status(500).json({ error: '商品更新に失敗しました: ' + err.message });
    }
});

// 商品削除
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const db = getLocationDatabase(req.session.locationCode);
        const productId = req.params.id;

        // 在庫履歴があるか確認
        const row = await db.get('SELECT COUNT(*) as count FROM inventory_history WHERE product_id = ?',
            [productId]
        );

        if (row.count > 0) {
            return res.status(400).json({ error: '在庫履歴がある商品は削除できません' });
        }

        await db.run('DELETE FROM products WHERE id = ?', [productId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete product error:', err);
        res.status(500).json({ error: '商品削除に失敗しました' });
    }
});

// 在庫初期値設定
router.post('/initialize', requireAuth, async (req, res) => {
    try {
        const db = getLocationDatabase(req.session.locationCode);
        const { productId, initialStock } = req.body;

        // 現在庫を更新
        await db.run(
            'UPDATE products SET current_stock = ? WHERE id = ?',
            [initialStock, productId]
        );

        // 調整履歴を記録
        await db.run(
            `INSERT INTO inventory_history (product_id, type, quantity, note, user_id)
             VALUES (?, 'adjust', ?, '初期在庫設定', ?)`,
            [productId, initialStock, req.session.userId]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Initialize stock error:', err);
        res.status(500).json({ error: '初期在庫設定に失敗しました' });
    }
});

module.exports = router;