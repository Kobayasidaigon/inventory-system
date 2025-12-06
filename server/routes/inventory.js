const express = require('express');
const { getLocationDatabase, mainDb } = require('../db/database-admin');
const { requireAuth } = require('../middleware/auth');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const path = require('path');
const fs = require('fs');
const router = express.Router();

// 在庫入力（入庫）
router.post('/in', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { productId, quantity, note } = req.body;

    try {
        // 在庫履歴に記録
        await db.run(
            `INSERT INTO inventory_history (product_id, type, quantity, note, user_id)
             VALUES (?, 'in', ?, ?, ?)`,
            [productId, quantity, note || '', req.session.userId]
        );

        // 現在庫を更新
        await db.run(
            'UPDATE products SET current_stock = current_stock + ? WHERE id = ?',
            [quantity, productId]
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '入庫処理に失敗しました' });
    }
});

// 在庫出力（出庫）- 日付指定対応
router.post('/out', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { productId, quantity, date, note } = req.body;

    try {
        // 在庫履歴に記録（日付を指定）
        await db.run(
            `INSERT INTO inventory_history (product_id, type, quantity, date, note, user_id)
             VALUES (?, 'out', ?, ?, ?, ?)`,
            [productId, quantity, date, note || '', req.session.userId]
        );

        // 現在庫を更新
        await db.run(
            'UPDATE products SET current_stock = current_stock - ? WHERE id = ?',
            [quantity, productId]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('出庫処理エラー:', err);
        res.status(500).json({ error: '出庫処理に失敗しました' });
    }
});

// 週次在庫入力（出庫）- 日付別対応
router.post('/weekly', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { weekStart, weekEnd, dailyItems } = req.body;

    try {
        // 週次入力記録を作成
        const entryResult = await db.run(
            `INSERT INTO weekly_entries (week_start, week_end, user_id)
             VALUES (?, ?, ?)`,
            [weekStart, weekEnd, req.session.userId]
        );

        const entryId = entryResult.lastID;

        // 日付ごとの出庫処理
        for (const date of Object.keys(dailyItems)) {
            const items = dailyItems[date];
            for (const item of items) {
                if (item.quantity > 0) {
                    await db.run(
                        `INSERT INTO inventory_history (product_id, type, quantity, date, note, user_id)
                         VALUES (?, 'out', ?, ?, ?, ?)`,
                        [item.productId, item.quantity, date, `日次出庫`, req.session.userId]
                    );
                    await db.run(
                        'UPDATE products SET current_stock = current_stock - ? WHERE id = ?',
                        [item.quantity, item.productId]
                    );
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '週次入力の記録に失敗しました' });
    }
});

// 在庫履歴取得（日付フィールド対応）
router.get('/history', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { productId, limit = 50, startDate, endDate } = req.query;

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
    const { quantity, note } = req.body;
    const historyId = req.params.id;

    try {
        // 元の履歴を取得
        const original = await db.get(
            'SELECT * FROM inventory_history WHERE id = ?',
            [historyId]
        );

        if (!original) {
            return res.status(404).json({ error: '履歴が見つかりません' });
        }

        const diff = quantity - original.quantity;
        const updateType = original.type === 'in' ? diff : -diff;

        // 履歴を更新
        await db.run(
            'UPDATE inventory_history SET quantity = ?, note = ? WHERE id = ?',
            [quantity, note, historyId]
        );

        // 在庫数を調整
        await db.run(
            'UPDATE products SET current_stock = current_stock + ? WHERE id = ?',
            [updateType, original.product_id]
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '履歴修正に失敗しました' });
    }
});

// CSVエクスポート
router.get('/export', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { type = 'current' } = req.query;

    try {
        if (type === 'current') {
            // 現在在庫をエクスポート
            const products = await db.all('SELECT * FROM products ORDER BY category, name');

            const csvData = products.map(p => ({
                ID: p.id,
                商品名: p.name,
                カテゴリ: p.category || '',
                現在庫: p.current_stock,
                発注点: p.reorder_point,
                発注要否: p.current_stock <= p.reorder_point ? '要発注' : ''
            }));

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');

            // BOM付きでUTF-8を出力（Excelで文字化けしないように）
            const BOM = '\uFEFF';
            const headers = Object.keys(csvData[0]).join(',');
            const rows = csvData.map(row => Object.values(row).join(','));
            const csv = BOM + headers + '\n' + rows.join('\n');

            res.send(csv);
        } else if (type === 'history') {
            // 在庫履歴をエクスポート
            const query = `
                SELECT h.*, p.name as product_name
                FROM inventory_history h
                JOIN products p ON h.product_id = p.id
                ORDER BY h.created_at DESC
            `;

            const history = await db.all(query);

            // ユーザー名をメインDBから取得して追加
            for (let item of history) {
                const user = await mainDb.get('SELECT user_name FROM users WHERE id = ?', [item.user_id]);
                item.username = user ? user.user_name : '不明';
            }

            const csvData = history.map(h => ({
                ID: h.id,
                日時: h.created_at,
                商品名: h.product_name,
                種別: h.type === 'in' ? '入庫' : h.type === 'out' ? '出庫' : '調整',
                数量: h.quantity,
                備考: h.note || '',
                担当者: h.username
            }));

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="inventory_history.csv"');

            const BOM = '\uFEFF';
            const headers = Object.keys(csvData[0]).join(',');
            const rows = csvData.map(row => Object.values(row).join(','));
            const csv = BOM + headers + '\n' + rows.join('\n');

            res.send(csv);
        }
    } catch (error) {
        res.status(500).json({ error: 'エクスポートエラー' });
    }
});

// 在庫推移グラフデータ取得
router.get('/chart', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { productId, days = 30 } = req.query;

    if (!productId) {
        return res.status(400).json({ error: '商品IDが必要です' });
    }

    try {
        // 商品名を取得
        const product = await db.get('SELECT name FROM products WHERE id = ?', [productId]);

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
            labels: labels,
            stocks: stocks
        });
    } catch (err) {
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

module.exports = router;