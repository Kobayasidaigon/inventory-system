const express = require('express');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const { getLocationDatabase } = require('../db/database-admin');
const { requireAuth } = require('../middleware/auth');
const { sanitizeHtml } = require('../utils/xss-protection');
const { verifyCsrfTokenManual } = require('../middleware/csrf');
const {
    StockError,
    parseProductId,
    parsePositiveInt,
    parseStockLevel,
    withTransaction,
    applyStockChange,
    respondWithStockError
} = require('../utils/stock');
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
    // 許可する画像形式
    const allowedMimeTypes = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'image/webp'
    ];

    const allowedExtensions = /jpeg|jpg|png|gif|webp/;
    const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedMimeTypes.includes(file.mimetype);

    // 拡張子とMIMEタイプの両方をチェック
    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb(new Error('画像ファイル（JPEG、PNG、GIF、WebP）のみアップロード可能です'));
    }
};

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MBに制限（セキュリティ強化）
        files: 1 // 1ファイルのみ
    },
    fileFilter: fileFilter
});

// 画像を圧縮・リサイズする関数
async function optimizeImage(buffer, filename) {
    const outputPath = path.join(uploadsDir, filename);

    await sharp(buffer)
        .rotate() // EXIFの回転情報を自動適用
        .resize(600, 600, {
            fit: 'inside',
            withoutEnlargement: true
        })
        .jpeg({ quality: 75, mozjpeg: true }) // mozjpegで高速化
        .toFile(outputPath);

    return filename;
}

/**
 * 商品フォームの任意項目を読む。未入力は 0 として扱う。
 */
function optionalStockLevel(value, label) {
    if (value === undefined || value === null || value === '') {
        return 0;
    }
    return parseStockLevel(value, label);
}

/**
 * 単価を検証する。数量と違って小数を許す（1 個 12.5 円のような仕入れ単価がある）。
 */
function parseUnitPrice(value) {
    if (value === undefined || value === null || value === '') {
        return 0;
    }

    const num = Number(String(value).trim());

    if (!Number.isFinite(num) || num < 0) {
        throw new StockError('単価は 0 以上の数値で入力してください');
    }

    return num;
}

/**
 * チェックボックスの値を 0/1 に正規化する。
 */
function parseFlag(value, defaultValue) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

/**
 * 商品名を検証する。空の商品名は一覧でどれか分からなくなるので受け付けない。
 */
function parseProductName(value) {
    const name = sanitizeHtml(String(value ?? '')).trim();

    if (!name) {
        throw new StockError('商品名を入力してください');
    }

    return name;
}

// 商品一覧取得
router.get('/', requireAuth, async (req, res) => {
    try {
        const db = getLocationDatabase(req.session.locationCode);
        // 過去30日間の出庫・入庫頻度でソート（頻度が高い順）
        const products = await db.all(`
            SELECT
                p.*,
                COALESCE(COUNT(ih.id), 0) as transaction_count
            FROM products p
            LEFT JOIN inventory_history ih ON p.id = ih.product_id
                AND ih.created_at >= datetime('now', '-30 days')
            GROUP BY p.id
            ORDER BY transaction_count DESC, p.category, p.name
        `, []);
        res.json(products);
    } catch (err) {
        console.error('Get products error:', err);
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

// 商品追加（画像アップロード対応）
router.post('/', requireAuth, upload.single('image'), async (req, res) => {
    try {
        // CSRF検証（multer処理後）
        const csrfResult = verifyCsrfTokenManual(req, res);
        if (!csrfResult.valid) {
            return res.status(403).json({ success: false, error: csrfResult.error });
        }

        const db = getLocationDatabase(req.session.locationCode);

        // XSS対策: ユーザー入力をサニタイズ
        const name = parseProductName(req.body.name);
        const category = sanitizeHtml(req.body.category || '');
        const reorderPoint = optionalStockLevel(req.body.reorder_point, '発注点');
        const currentStock = optionalStockLevel(req.body.current_stock, '現在庫');
        const unitPrice = parseUnitPrice(req.body.unit_price);
        const includeInCount = parseFlag(req.body.include_in_count, 1);

        let imageUrl = null;
        if (req.file) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const filename = 'product-' + uniqueSuffix + '.jpg';
            await optimizeImage(req.file.buffer, filename);
            imageUrl = `/uploads/${filename}`;
        }

        const productId = await withTransaction(db, async () => {
            // 在庫は 0 で作り、初期在庫は調整履歴として積む。
            // ここで current_stock に直接書き込むと、その分だけ履歴で説明できない
            // 在庫が生まれ、「現在庫 = 履歴の合計」が最初から崩れる。
            const result = await db.run(
                `INSERT INTO products (name, category, reorder_point, current_stock, unit_price, include_in_count, image_url)
                 VALUES (?, ?, ?, 0, ?, ?, ?)`,
                [name, category, reorderPoint, unitPrice, includeInCount, imageUrl]
            );

            if (currentStock !== 0) {
                await applyStockChange(db, {
                    productId: result.lastID,
                    type: 'adjust',
                    quantity: currentStock,
                    note: '初期在庫',
                    userId: req.session.userId
                });
            }

            return result.lastID;
        });

        res.json({ success: true, productId });
    } catch (err) {
        respondWithStockError(res, err, '商品登録に失敗しました');
    }
});

// 商品更新（画像アップロード対応）
router.put('/:id', requireAuth, upload.single('image'), async (req, res) => {
    try {
        // CSRF検証（multer処理後）
        const csrfResult = verifyCsrfTokenManual(req, res);
        if (!csrfResult.valid) {
            return res.status(403).json({ success: false, error: csrfResult.error });
        }

        const db = getLocationDatabase(req.session.locationCode);
        const productId = parsePositiveInt(req.params.id, '商品ID');

        // XSS対策: ユーザー入力をサニタイズ
        const name = parseProductName(req.body.name);
        const category = sanitizeHtml(req.body.category || '');
        const reorderPoint = optionalStockLevel(req.body.reorder_point, '発注点');
        const unitPrice = parseUnitPrice(req.body.unit_price);
        const includeInCount = parseFlag(req.body.include_in_count, 1);

        // 現在庫は編集画面から直接書き換えられる。未送信のときは触らない。
        const nextStock = req.body.current_stock === undefined || req.body.current_stock === ''
            ? null
            : parseStockLevel(req.body.current_stock, '現在庫');

        let imageUrl = undefined;
        if (req.file) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const filename = 'product-' + uniqueSuffix + '.jpg';
            await optimizeImage(req.file.buffer, filename);
            imageUrl = `/uploads/${filename}`;
        }

        await withTransaction(db, async () => {
            const product = await db.get('SELECT * FROM products WHERE id = ?', [productId]);

            if (!product) {
                throw new StockError('商品が見つかりません', 404);
            }

            // 在庫数はここでは更新しない。履歴を残すために applyStockChange に任せる。
            const columns = [
                'name = ?',
                'category = ?',
                'reorder_point = ?',
                'unit_price = ?',
                'include_in_count = ?',
                'updated_at = CURRENT_TIMESTAMP'
            ];
            const params = [name, category, reorderPoint, unitPrice, includeInCount];

            if (imageUrl) {
                columns.push('image_url = ?');
                params.push(imageUrl);
            }

            params.push(productId);

            await db.run(`UPDATE products SET ${columns.join(', ')} WHERE id = ?`, params);

            // 商品編集で在庫を書き換えたときも履歴に残す。
            // ここを素通りさせると、現在庫だけが動いて履歴では説明できない状態になる。
            if (nextStock !== null) {
                const delta = nextStock - (Number(product.current_stock) || 0);

                if (delta !== 0) {
                    await applyStockChange(db, {
                        productId,
                        type: 'adjust',
                        quantity: delta,
                        note: '商品編集で在庫を修正',
                        userId: req.session.userId,
                        // 画面に入力された数が実際の棚の数なので、その値を優先する
                        allowNegative: true
                    });
                }
            }
        });

        res.json({ success: true });
    } catch (err) {
        respondWithStockError(res, err, '商品更新に失敗しました');
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
    const db = getLocationDatabase(req.session.locationCode);

    try {
        const productId = parseProductId(req.body.productId);
        const initialStock = parseStockLevel(req.body.initialStock, '初期在庫');

        await withTransaction(db, async () => {
            const product = await db.get('SELECT * FROM products WHERE id = ?', [productId]);

            if (!product) {
                throw new StockError('商品が見つかりません', 404);
            }

            // adjust の quantity は「符号付きの増減量」に統一している（棚卸調整と同じ意味）。
            // ここに実在庫の絶対値を入れると、履歴を足し上げた在庫と現在庫が食い違い、
            // 在庫推移グラフが実際とずれる。
            const delta = initialStock - (Number(product.current_stock) || 0);

            await applyStockChange(db, {
                productId,
                type: 'adjust',
                quantity: delta,
                note: '初期在庫設定',
                userId: req.session.userId,
                // 初期在庫は「今ある数」の申告なので、その値を優先して受け入れる
                allowNegative: true
            });
        });

        res.json({ success: true });
    } catch (err) {
        respondWithStockError(res, err, '初期在庫設定に失敗しました');
    }
});

module.exports = router;