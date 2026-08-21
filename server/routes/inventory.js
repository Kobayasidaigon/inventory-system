const express = require('express');
const { getLocationDatabase, mainDb } = require('../db/database-admin');
const { requireAuth } = require('../middleware/auth');
const { sendOrderNotification } = require('../services/line-notify');
const { sanitizeHtml } = require('../utils/xss-protection');
const {
    StockError,
    parseQuantity,
    parsePositiveInt,
    parseProductId,
    parseTransactionDate,
    withTransaction,
    applyStockChange,
    createAutoOrderIfNeeded,
    buildStockChartData,
    parseChartDays,
    respondWithStockError
} = require('../utils/stock');
const router = express.Router();

/**
 * 自動発注が作られたことを LINE へ通知する。
 *
 * 必ずトランザクションの外から呼ぶこと。LINE は外部 API なので、応答を待つあいだ
 * SQLite の書き込みロックを握り続けると他の入力が止まる。通知の失敗で在庫登録を
 * 巻き戻したくはないので、エラーはログに残すだけにする。
 */
async function notifyAutoOrder({ locationCode, product, orderQuantity }) {
    try {
        const location = await mainDb.get(
            'SELECT location_name, location_code FROM locations WHERE location_code = ?',
            [locationCode]
        );

        const groupId = await mainDb.get("SELECT value FROM settings WHERE key = 'line_group_id'");

        if (!groupId || !groupId.value) {
            return;
        }

        await sendOrderNotification(groupId.value, {
            locationName: location ? location.location_name : '不明',
            locationCode: locationCode,
            productName: product.name,
            currentStock: product.current_stock,
            reorderPoint: product.reorder_point,
            orderQuantity: orderQuantity
        });
    } catch (lineError) {
        console.error('LINE通知エラー:', lineError);
    }
}

/**
 * 入庫と出庫の処理。在庫が動く向き以外は同じなのでまとめている。
 */
async function handleStockChange(req, res, type) {
    const db = getLocationDatabase(req.session.locationCode);
    const failureMessage = type === 'in' ? '入庫処理に失敗しました' : '出庫処理に失敗しました';

    try {
        const productId = parseProductId(req.body.productId);
        const quantity = parseQuantity(req.body.quantity);
        const date = parseTransactionDate(req.body.date);
        const note = sanitizeHtml(req.body.note || '');

        const { product, autoOrder } = await withTransaction(db, async () => {
            const updated = await applyStockChange(db, {
                productId,
                type,
                quantity,
                date,
                note,
                userId: req.session.userId
            });

            // 発注依頼済みの商品には自動発注を作らない（createAutoOrderIfNeeded が
            // 未入荷の依頼を見て判断する）。届いた商品を入庫したタイミングで
            // 同じ依頼をもう一度作ってしまうのを防ぐため。
            const order = await createAutoOrderIfNeeded(db, {
                product: updated,
                userId: req.session.userId
            });

            return { product: updated, autoOrder: order };
        });

        if (autoOrder) {
            console.log(
                `商品ID ${product.id} (${product.name}) の在庫が発注点を下回りました。自動発注依頼を作成しました。`
            );
            await notifyAutoOrder({
                locationCode: req.session.locationCode,
                product,
                orderQuantity: autoOrder.orderQuantity
            });
        }

        res.json({ success: true, currentStock: product.current_stock });
    } catch (err) {
        respondWithStockError(res, err, failureMessage);
    }
}

// 在庫入力（入庫）
router.post('/in', requireAuth, (req, res) => handleStockChange(req, res, 'in'));

// 在庫出力（出庫）- 日付指定対応
router.post('/out', requireAuth, (req, res) => handleStockChange(req, res, 'out'));

// 週次在庫入力（出庫）- 日付別対応
router.post('/weekly', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { weekStart, weekEnd, dailyItems } = req.body;

    try {
        const start = parseTransactionDate(weekStart);
        const end = parseTransactionDate(weekEnd);

        if (!start || !end) {
            throw new StockError('対象期間を指定してください');
        }
        if (start > end) {
            throw new StockError('対象期間の開始日が終了日より後になっています');
        }
        if (!dailyItems || typeof dailyItems !== 'object') {
            throw new StockError('入力内容が正しくありません');
        }

        // 先に全件を検証する。1 件でも不正なら 1 件も登録しない。
        // 途中まで登録された状態で 500 を返すと、利用者が再送したときに
        // 前半が二重計上される。
        const entries = [];
        for (const [rawDate, items] of Object.entries(dailyItems)) {
            const date = parseTransactionDate(rawDate);

            if (!Array.isArray(items)) {
                throw new StockError(`${rawDate} の入力内容が正しくありません`);
            }

            for (const item of items) {
                // 空欄と 0 は「その日は出庫なし」の意味なので読み飛ばす
                if (item.quantity === '' || item.quantity === null || item.quantity === undefined) {
                    continue;
                }
                if (Number(item.quantity) === 0) {
                    continue;
                }

                entries.push({
                    productId: parseProductId(item.productId),
                    quantity: parseQuantity(item.quantity),
                    date
                });
            }
        }

        if (entries.length === 0) {
            throw new StockError('登録する出庫がありません');
        }

        const autoOrders = await withTransaction(db, async () => {
            await db.run(
                `INSERT INTO weekly_entries (week_start, week_end, user_id)
                 VALUES (?, ?, ?)`,
                [start, end, req.session.userId]
            );

            const updatedProducts = new Map();

            for (const entry of entries) {
                const updated = await applyStockChange(db, {
                    productId: entry.productId,
                    type: 'out',
                    quantity: entry.quantity,
                    date: entry.date,
                    note: '日次出庫',
                    userId: req.session.userId
                });
                updatedProducts.set(entry.productId, updated);
            }

            // 同じ商品を何日ぶんも入力するので、発注判定は全部反映してから 1 回だけ行う
            const created = [];
            for (const product of updatedProducts.values()) {
                const order = await createAutoOrderIfNeeded(db, {
                    product,
                    userId: req.session.userId
                });

                if (order) {
                    created.push({ product, orderQuantity: order.orderQuantity });
                }
            }

            return created;
        });

        for (const { product, orderQuantity } of autoOrders) {
            console.log(
                `商品ID ${product.id} (${product.name}) の在庫が発注点を下回りました。自動発注依頼を作成しました。`
            );
            await notifyAutoOrder({
                locationCode: req.session.locationCode,
                product,
                orderQuantity
            });
        }

        res.json({ success: true, registered: entries.length });
    } catch (err) {
        respondWithStockError(res, err, '週次入力の記録に失敗しました');
    }
});

// 在庫履歴取得（日付フィールド対応）
router.get('/history', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { productId, startDate, endDate } = req.query;
    // 件数は 1〜1000 に収める。文字列がそのまま LIMIT に渡ると 500 になる。
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 1000);

    let query = `
        SELECT h.*, p.name as product_name, p.category,
               CASE
                   WHEN h.date IS NOT NULL THEN h.date
                   ELSE DATE(h.created_at)
               END as transaction_date
        FROM inventory_history h
        JOIN products p ON h.product_id = p.id
    `;

    const params = [];
    const conditions = [];

    if (productId) {
        conditions.push('h.product_id = ?');
        params.push(productId);
    }

    if (startDate) {
        conditions.push('DATE(COALESCE(h.date, h.created_at)) >= ?');
        params.push(startDate);
    }

    if (endDate) {
        conditions.push('DATE(COALESCE(h.date, h.created_at)) <= ?');
        params.push(endDate);
    }

    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY h.created_at DESC LIMIT ?';
    params.push(limit);

    try {
        const history = await db.all(query, params);

        // ユーザー名をメインDBから取得して追加
        for (let item of history) {
            const user = await mainDb.get('SELECT user_name FROM users WHERE id = ?', [item.user_id]);
            item.username = user ? user.user_name : '不明';
        }

        res.json(history);
    } catch (err) {
        console.error('History error:', err);
        res.status(500).json({ error: '履歴取得エラー' });
    }
});

// 履歴修正
router.put('/history/:id', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);

    try {
        const historyId = parsePositiveInt(req.params.id, '履歴ID');
        const quantity = parseQuantity(req.body.quantity);
        const note = sanitizeHtml(req.body.note || '');

        await withTransaction(db, async () => {
            const original = await db.get(
                'SELECT * FROM inventory_history WHERE id = ?',
                [historyId]
            );

            if (!original) {
                throw new StockError('履歴が見つかりません', 404);
            }

            // 調整（棚卸・初期在庫）の quantity は符号付きの増減量で、入出庫とは
            // 意味が違う。ここで入出庫と同じ扱いをすると在庫が逆方向に動くため、
            // 修正は受け付けず棚卸でやり直してもらう。
            if (original.type === 'adjust') {
                throw new StockError(
                    '調整履歴はここでは修正できません。棚卸で実在庫を登録し直してください'
                );
            }

            const product = await db.get(
                'SELECT * FROM products WHERE id = ?',
                [original.product_id]
            );

            if (!product) {
                throw new StockError('商品が見つかりません', 404);
            }

            const diff = quantity - original.quantity;
            const delta = original.type === 'in' ? diff : -diff;
            const currentStock = Number(product.current_stock) || 0;
            const nextStock = currentStock + delta;

            if (nextStock < 0) {
                throw new StockError(
                    `この数量に修正すると在庫がマイナスになります（${product.name}: 現在庫 ${currentStock}）`
                );
            }

            await db.run(
                'UPDATE inventory_history SET quantity = ?, note = ? WHERE id = ?',
                [quantity, note, historyId]
            );

            await db.run(
                'UPDATE products SET current_stock = ? WHERE id = ?',
                [nextStock, original.product_id]
            );
        });

        res.json({ success: true });
    } catch (err) {
        respondWithStockError(res, err, '履歴修正に失敗しました');
    }
});

/**
 * 行の配列を CSV 文字列にする。
 *
 * 商品名に「,」や「"」が入っていても列がずれないようにエスケープする。
 * Excel で開いたときに文字化けしないよう BOM を付ける。
 *
 * @param {string[]} headers - 見出し行
 * @param {Array<Array<*>>} rows - 各行の値（headers と同じ順序）
 */
function toCsv(headers, rows) {
    const escape = (value) => {
        const text = value === null || value === undefined ? '' : String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [headers.map(escape).join(',')];
    for (const row of rows) {
        lines.push(row.map(escape).join(','));
    }

    return '﻿' + lines.join('\n');
}

// CSVエクスポート
router.get('/export', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { type = 'current', sort = 'id' } = req.query;

    try {
        if (type === 'current') {
            // 現在在庫をエクスポート
            // sort: 'id' (ID順) または 'category' (カテゴリ順)
            const orderBy = sort === 'category' ? 'category, id' : 'id';
            const products = await db.all(`SELECT * FROM products ORDER BY ${orderBy}`);

            // 朝・昼・晩は紙に手書きするための空欄
            const csv = toCsv(
                ['ID', '商品名', '朝', '昼', '晩'],
                products.map(p => [p.id, p.name, '', '', ''])
            );

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
            res.send(csv);
        } else if (type === 'history') {
            // 在庫履歴をエクスポート
            const history = await db.all(`
                SELECT h.*, p.name as product_name
                FROM inventory_history h
                JOIN products p ON h.product_id = p.id
                ORDER BY h.created_at DESC
            `);

            // ユーザー名をメインDBから取得して追加
            for (let item of history) {
                const user = await mainDb.get('SELECT user_name FROM users WHERE id = ?', [item.user_id]);
                item.username = user ? user.user_name : '不明';
            }

            const typeLabel = (t) => (t === 'in' ? '入庫' : t === 'out' ? '出庫' : '調整');

            const csv = toCsv(
                ['ID', '日時', '商品名', '種別', '数量', '備考', '担当者'],
                history.map(h => [
                    h.id,
                    h.created_at,
                    h.product_name,
                    typeLabel(h.type),
                    h.quantity,
                    h.note || '',
                    h.username
                ])
            );

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="inventory_history.csv"');
            res.send(csv);
        } else {
            res.status(400).json({ error: '不明なエクスポート種別です' });
        }
    } catch (error) {
        console.error('エクスポートエラー:', error);
        res.status(500).json({ error: 'エクスポートエラー' });
    }
});

// 在庫推移グラフデータ取得
router.get('/chart', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);

    try {
        const productId = parseProductId(req.query.productId);
        const days = parseChartDays(req.query.days);

        const product = await db.get('SELECT name FROM products WHERE id = ?', [productId]);

        if (!product) {
            throw new StockError('商品が見つかりません', 404);
        }

        const chart = await buildStockChartData(db, productId, days);

        res.json({
            productName: product.name,
            labels: chart.labels,
            stocks: chart.stocks,
            dailyConsumption: chart.dailyConsumption
        });
    } catch (err) {
        respondWithStockError(res, err, 'データ取得エラー');
    }
});

module.exports = router;
