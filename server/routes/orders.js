const express = require('express');
const { getLocationDatabase, mainDb } = require('../db/database-admin');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// 発注依頼作成
router.post('/', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { productId, quantity, requestedBy, note } = req.body;

    try {
        const result = await db.run(
            `INSERT INTO order_requests (product_id, requested_quantity, requested_by, user_id, note)
             VALUES (?, ?, ?, ?, ?)`,
            [productId, quantity, requestedBy || req.session.username, req.session.userId, note || '']
        );

        res.json({ success: true, orderId: result.lastID });
    } catch (err) {
        console.error('Order creation error:', err);
        res.status(500).json({ error: '発注依頼の登録に失敗しました' });
    }
});

// 発注依頼一覧取得
router.get('/', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const query = `
        SELECT o.*, p.name as product_name, p.current_stock, p.reorder_point
        FROM order_requests o
        JOIN products p ON o.product_id = p.id
        ORDER BY o.requested_at DESC
    `;

    try {
        const orders = await db.all(query);

        // ユーザー名をメインDBから取得して追加
        for (let order of orders) {
            const user = await mainDb.get('SELECT user_name FROM users WHERE id = ?', [order.user_id]);
            order.username = user ? user.user_name : '不明';
        }

        res.json(orders);
    } catch (err) {
        console.error('Orders error:', err);
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

// 発注依頼の承認・却下（管理者のみ）
router.put('/:id/approve', requireAdmin, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { approvedQuantity, note } = req.body;
    const orderId = req.params.id;

    try {
        await db.run(
            `UPDATE order_requests
             SET status = 'approved',
                 approved_quantity = ?,
                 approved_by = ?,
                 approved_at = CURRENT_TIMESTAMP,
                 note = ?
             WHERE id = ?`,
            [approvedQuantity, req.session.username, note || '', orderId]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Approve error:', err);
        res.status(500).json({ error: '承認に失敗しました' });
    }
});

router.put('/:id/reject', requireAdmin, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { note } = req.body;
    const orderId = req.params.id;

    try {
        await db.run(
            `UPDATE order_requests
             SET status = 'rejected',
                 approved_by = ?,
                 approved_at = CURRENT_TIMESTAMP,
                 note = ?
             WHERE id = ?`,
            [req.session.username, note || '', orderId]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Reject error:', err);
        res.status(500).json({ error: '却下に失敗しました' });
    }
});

// 発注依頼の編集（管理者のみ）
router.put('/:id', requireAdmin, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { quantity, note } = req.body;
    const orderId = req.params.id;

    try {
        // pending状態の発注依頼のみ編集可能
        const order = await db.get('SELECT * FROM order_requests WHERE id = ?', [orderId]);

        if (!order) {
            return res.status(404).json({ error: '発注依頼が見つかりません' });
        }

        if (order.status !== 'pending' && order.status !== 'approved') {
            return res.status(400).json({ error: 'この発注依頼は編集できません' });
        }

        const updates = [];
        const params = [];

        if (quantity !== undefined) {
            if (order.status === 'approved') {
                updates.push('approved_quantity = ?');
                params.push(quantity);
            } else {
                updates.push('requested_quantity = ?');
                params.push(quantity);
            }
        }

        if (note !== undefined) {
            updates.push('note = ?');
            params.push(note);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: '更新する項目がありません' });
        }

        params.push(orderId);

        await db.run(
            `UPDATE order_requests SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Update error:', err);
        res.status(500).json({ error: '更新に失敗しました' });
    }
});

// 発注依頼のキャンセル
router.delete('/:id', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const orderId = req.params.id;

    try {
        const order = await db.get('SELECT * FROM order_requests WHERE id = ?', [orderId]);

        if (!order) {
            return res.status(404).json({ error: '発注依頼が見つかりません' });
        }

        // 一般ユーザーは自分の発注のみキャンセル可能、管理者はすべてキャンセル可能
        if (req.session.userRole !== 'admin' && order.user_id !== req.session.userId) {
            return res.status(403).json({ error: '権限がありません' });
        }

        await db.run(
            'UPDATE order_requests SET status = ? WHERE id = ?',
            ['cancelled', orderId]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Cancel error:', err);
        res.status(500).json({ error: 'キャンセルに失敗しました' });
    }
});

// 商品ごとの発注分析（過去30日間の消費トレンド）
router.get('/analysis/:productId', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const productId = req.params.productId;

    try {
        // 商品情報を取得
        const product = await db.get('SELECT * FROM products WHERE id = ?', [productId]);

        if (!product) {
            return res.status(404).json({ error: '商品が見つかりません' });
        }

        // 過去30日間の出庫履歴を取得
        const query = `
            SELECT
                COALESCE(h.date, DATE(h.created_at)) as date,
                strftime('%w', COALESCE(h.date, DATE(h.created_at))) as day_of_week,
                SUM(CASE WHEN h.type = 'out' THEN h.quantity ELSE 0 END) as out_quantity
            FROM inventory_history h
            WHERE h.product_id = ?
            AND DATE(COALESCE(h.date, h.created_at)) >= DATE('now', '-30 days')
            GROUP BY date
            ORDER BY date ASC
        `;

        const history = await db.all(query, [productId]);

        // データが少なくても分析を実行（最低3日分のデータがあれば分析）
        if (history.length < 3) {
            return res.json({
                hasData: false,
                message: '分析に十分なデータがありません（最低3日分の出庫データが必要です）',
                dataCount: history.length
            });
        }

        // 全体の平均消費量を計算
        const totalDays = history.length;
        const totalConsumption = history.reduce((sum, item) => sum + item.out_quantity, 0);
        const avgDailyConsumption = totalConsumption / totalDays;

        // 曜日別の平均消費量を計算
        const dayOfWeekData = {};
        for (let i = 0; i < 7; i++) {
            dayOfWeekData[i] = { total: 0, count: 0 };
        }

        history.forEach(item => {
            const dow = parseInt(item.day_of_week);
            dayOfWeekData[dow].total += item.out_quantity;
            dayOfWeekData[dow].count += 1;
        });

        const dayOfWeekAvg = {};
        let hasWeeklyPattern = false;
        const weeklyAvgArray = [];

        for (let i = 0; i < 7; i++) {
            if (dayOfWeekData[i].count > 0) {
                dayOfWeekAvg[i] = dayOfWeekData[i].total / dayOfWeekData[i].count;
                weeklyAvgArray.push(dayOfWeekAvg[i]);
            } else {
                dayOfWeekAvg[i] = avgDailyConsumption;
            }
        }

        // 曜日別のばらつきをチェック（標準偏差が平均の30%以上なら曜日パターンあり）
        if (weeklyAvgArray.length > 0) {
            const weeklyMean = weeklyAvgArray.reduce((a, b) => a + b, 0) / weeklyAvgArray.length;
            const variance = weeklyAvgArray.reduce((sum, val) => sum + Math.pow(val - weeklyMean, 2), 0) / weeklyAvgArray.length;
            const stdDev = Math.sqrt(variance);
            hasWeeklyPattern = stdDev > weeklyMean * 0.3;
        }

        // 在庫切れまでの日数を計算
        const daysUntilStockout = avgDailyConsumption > 0
            ? Math.floor(product.current_stock / avgDailyConsumption)
            : 999;

        // 推奨発注点を計算（発注リードタイム7日分 + 安全在庫3日分）
        const leadTimeDays = 7; // 発注から納品までの日数
        const safetyStockDays = 3; // 安全在庫の日数
        const recommendedReorderPoint = Math.ceil(avgDailyConsumption * (leadTimeDays + safetyStockDays));

        // 発注が必要かどうか（現在の発注点を使用）
        const needsOrder = product.current_stock <= product.reorder_point;

        // 推奨発注量を計算（推奨発注点の2倍 - 現在庫）
        const recommendedOrderQty = needsOrder
            ? Math.max(0, (Math.max(recommendedReorderPoint, product.reorder_point) * 2) - product.current_stock)
            : 0;

        // 最近の消費トレンド（直近7日間 vs 全期間の比較）
        // データが少ない場合は直近の半分を使用
        const recentDays = Math.min(7, Math.floor(history.length / 2));
        const recentHistory = history.slice(-recentDays);
        const recentConsumption = recentHistory.reduce((sum, item) => sum + item.out_quantity, 0);
        const recentAvg = recentHistory.length > 0 ? recentConsumption / recentHistory.length : 0;
        const trendChange = avgDailyConsumption > 0
            ? ((recentAvg - avgDailyConsumption) / avgDailyConsumption * 100)
            : 0;

        res.json({
            hasData: true,
            productName: product.name,
            currentStock: product.current_stock,
            reorderPoint: product.reorder_point,
            recommendedReorderPoint: recommendedReorderPoint,
            avgDailyConsumption: Math.round(avgDailyConsumption * 100) / 100,
            daysUntilStockout: daysUntilStockout,
            needsOrder: needsOrder,
            recommendedOrderQty: recommendedOrderQty,
            hasWeeklyPattern: hasWeeklyPattern,
            dayOfWeekAvg: dayOfWeekAvg,
            trendChange: Math.round(trendChange * 100) / 100,
            analysisNote: trendChange > 20
                ? '消費量が増加傾向です'
                : trendChange < -20
                    ? '消費量が減少傾向です'
                    : '消費量は安定しています',
            analysisPeriod: `過去${totalDays}日間`,
            dataCount: totalDays
        });
    } catch (err) {
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

module.exports = router;
