const express = require('express');
const { getLocationDatabase, mainDb } = require('../db/database-admin');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// 発注依頼作成
router.post('/', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { productId, quantity, note } = req.body;

    try {
        const result = await db.run(
            `INSERT INTO order_requests (product_id, requested_quantity, user_id, note)
             VALUES (?, ?, ?, ?)`,
            [productId, quantity, req.session.userId, note || '']
        );

        res.json({ success: true, orderId: result.lastID });
    } catch (err) {
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

// 発注依頼ステータス更新
router.put('/:id', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const { status } = req.body;
    const orderId = req.params.id;

    try {
        await db.run(
            'UPDATE order_requests SET status = ? WHERE id = ?',
            [status, orderId]
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'ステータス更新に失敗しました' });
    }
});

// 商品ごとの発注分析（期間指定可能な消費トレンド）
router.get('/analysis/:productId', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);
    const productId = req.params.productId;
    // 期間パラメータ（デフォルト90日）
    const days = parseInt(req.query.days) || 90;

    try {
        // 商品情報を取得
        const product = await db.get('SELECT * FROM products WHERE id = ?', [productId]);

        if (!product) {
            return res.status(404).json({ error: '商品が見つかりません' });
        }

        // 指定期間の出庫履歴を取得
        const query = `
            SELECT
                COALESCE(h.date, DATE(h.created_at)) as date,
                strftime('%w', COALESCE(h.date, DATE(h.created_at))) as day_of_week,
                SUM(CASE WHEN h.type = 'out' THEN h.quantity ELSE 0 END) as out_quantity
            FROM inventory_history h
            WHERE h.product_id = ?
            AND DATE(COALESCE(h.date, h.created_at)) >= DATE('now', '-' || ? || ' days')
            GROUP BY date
            ORDER BY date ASC
        `;

        const history = await db.all(query, [productId, days]);

        if (history.length === 0) {
            return res.json({
                hasData: false,
                message: '分析に十分なデータがありません'
            });
        }

        // 全体の平均消費量を計算（指定期間の実日数で割る）
        const totalDays = days;
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

        // 発注点を自動計算（発注リードタイム7日分 + 安全在庫3日分）
        const leadTimeDays = 7; // 発注から納品までの日数
        const safetyStockDays = 3; // 安全在庫の日数
        const calculatedReorderPoint = Math.ceil(avgDailyConsumption * (leadTimeDays + safetyStockDays));

        // 自動調整された発注点を使用（最小値は現在の発注点の50%）
        const minReorderPoint = Math.floor(product.reorder_point * 0.5);
        const optimizedReorderPoint = Math.max(calculatedReorderPoint, minReorderPoint);

        // 発注点を更新すべきかチェック（現在の発注点と20%以上差がある場合）
        const shouldUpdateReorderPoint = product.reorder_point > 0 &&
            Math.abs(optimizedReorderPoint - product.reorder_point) / product.reorder_point > 0.2;

        // 発注が必要かどうか（最適化された発注点を使用）
        const needsOrder = product.current_stock <= optimizedReorderPoint;

        // 推奨発注量を計算（最適化された発注点の2倍 - 現在庫）
        const recommendedOrderQty = needsOrder
            ? Math.max(0, (optimizedReorderPoint * 2) - product.current_stock)
            : 0;

        // 最近の消費トレンド（直近7日間 vs 全期間の比較）
        const recentHistory = history.slice(-7);
        const recentConsumption = recentHistory.reduce((sum, item) => sum + item.out_quantity, 0);
        const recentAvg = recentHistory.length > 0 ? recentConsumption / recentHistory.length : 0;
        const trendChange = avgDailyConsumption > 0
            ? ((recentAvg - avgDailyConsumption) / avgDailyConsumption * 100)
            : 0;

        // 発注点の自動更新
        if (shouldUpdateReorderPoint) {
            try {
                await db.run(
                    'UPDATE products SET reorder_point = ? WHERE id = ?',
                    [optimizedReorderPoint, productId]
                );
                console.log(`商品ID ${productId} の発注点を ${product.reorder_point} → ${optimizedReorderPoint} に自動更新しました`);
            } catch (updateErr) {
                console.error('発注点の自動更新エラー:', updateErr);
            }
        }

        res.json({
            hasData: true,
            productName: product.name,
            currentStock: product.current_stock,
            reorderPoint: product.reorder_point,
            optimizedReorderPoint: optimizedReorderPoint,
            reorderPointUpdated: shouldUpdateReorderPoint,
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
                    : '消費量は安定しています'
        });
    } catch (err) {
        res.status(500).json({ error: 'データ取得エラー' });
    }
});

module.exports = router;
