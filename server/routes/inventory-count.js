const express = require('express');
const router = express.Router();
const { mainDb } = require('../db/database-admin');
const {
    StockError,
    parseStockLevel,
    parseTransactionDate,
    withTransaction,
    applyStockChange,
    respondWithStockError
} = require('../utils/stock');

module.exports = (db) => {
    // 新規棚卸作成
    router.post('/create', async (req, res) => {
        try {
            const userId = req.session.userId;
            const count_date = parseTransactionDate(req.body.count_date);

            if (!count_date) {
                return res.status(400).json({ error: '棚卸日を指定してください' });
            }

            // 同じ日付の棚卸が既に存在するかチェック
            const existing = await db.get(
                'SELECT * FROM inventory_counts WHERE count_date = ? AND status != ?',
                [count_date, 'cancelled']
            );

            if (existing) {
                return res.status(400).json({ error: 'この日付の棚卸は既に存在します' });
            }

            // 棚卸を作成
            const result = await db.run(
                'INSERT INTO inventory_counts (count_date, user_id) VALUES (?, ?)',
                [count_date, userId]
            );

            const countId = result.lastID;

            // 棚卸対象商品の現在庫を取得して棚卸明細を作成
            const products = await db.all('SELECT id, current_stock FROM products WHERE include_in_count = 1 ORDER BY id');

            for (const product of products) {
                await db.run(
                    `INSERT INTO inventory_count_items
                    (count_id, product_id, system_quantity)
                    VALUES (?, ?, ?)`,
                    [countId, product.id, product.current_stock]
                );
            }

            res.json({
                success: true,
                count_id: countId,
                message: '棚卸を開始しました'
            });
        } catch (err) {
            console.error('Error creating inventory count:', err);
            res.status(500).json({ error: 'サーバーエラーが発生しました' });
        }
    });

    // 棚卸一覧取得
    router.get('/list', async (req, res) => {
        try {
            const counts = await db.all(`
                SELECT
                    ic.*,
                    COUNT(ici.id) as item_count,
                    SUM(CASE WHEN ici.actual_quantity IS NOT NULL THEN 1 ELSE 0 END) as counted_items
                FROM inventory_counts ic
                LEFT JOIN inventory_count_items ici ON ic.id = ici.count_id
                GROUP BY ic.id
                ORDER BY ic.count_date DESC
            `);

            // ユーザー名をメインDBから取得して追加
            for (let count of counts) {
                const user = await mainDb.get('SELECT user_name FROM users WHERE id = ?', [count.user_id]);
                count.created_by = user ? user.user_name : '不明';

                if (count.approved_by) {
                    const approver = await mainDb.get('SELECT user_name FROM users WHERE id = ?', [count.approved_by]);
                    count.approved_by_username = approver ? approver.user_name : '不明';
                }
            }

            res.json(counts);
        } catch (err) {
            console.error('Error fetching inventory counts:', err);
            res.status(500).json({ error: 'サーバーエラーが発生しました' });
        }
    });

    // 棚卸詳細取得
    router.get('/:id', async (req, res) => {
        try {
            const countId = req.params.id;

            const count = await db.get(
                'SELECT * FROM inventory_counts WHERE id = ?',
                [countId]
            );

            if (!count) {
                return res.status(404).json({ error: '棚卸が見つかりません' });
            }

            const items = await db.all(`
                SELECT
                    ici.*,
                    p.name as product_name,
                    p.category,
                    p.image_url
                FROM inventory_count_items ici
                JOIN products p ON ici.product_id = p.id
                WHERE ici.count_id = ?
                ORDER BY p.category, p.name
            `, [countId]);

            res.json({
                count,
                items
            });
        } catch (err) {
            console.error('Error fetching inventory count details:', err);
            res.status(500).json({ error: 'サーバーエラーが発生しました' });
        }
    });

    // 実在庫数を入力
    router.post('/:id/items/:itemId/count', async (req, res) => {
        try {
            const { itemId } = req.params;
            const { note } = req.body;

            // 文字列や小数がそのまま入ると差異が NaN になり、
            // 承認時に在庫を壊すのでここで弾く
            const actual_quantity = parseStockLevel(req.body.actual_quantity, '実在庫数');

            // 棚卸明細を取得
            const item = await db.get(
                'SELECT * FROM inventory_count_items WHERE id = ?',
                [itemId]
            );

            if (!item) {
                return res.status(404).json({ error: '棚卸明細が見つかりません' });
            }

            // 差異を計算
            const difference = actual_quantity - (Number(item.system_quantity) || 0);

            // 更新
            await db.run(`
                UPDATE inventory_count_items
                SET actual_quantity = ?, difference = ?, note = ?
                WHERE id = ?
            `, [actual_quantity, difference, note || null, itemId]);

            res.json({ success: true });
        } catch (err) {
            respondWithStockError(res, err, '実在庫数の登録に失敗しました');
        }
    });

    // 差異理由を入力
    router.post('/:id/items/:itemId/reason', async (req, res) => {
        try {
            const { itemId } = req.params;
            const { reason } = req.body;

            await db.run(
                'UPDATE inventory_count_items SET reason = ? WHERE id = ?',
                [reason, itemId]
            );

            res.json({ success: true });
        } catch (err) {
            console.error('Error updating reason:', err);
            res.status(500).json({ error: 'サーバーエラーが発生しました' });
        }
    });

    // 棚卸完了
    router.post('/:id/complete', async (req, res) => {
        try {
            const countId = req.params.id;

            // すべての商品がカウントされているかチェック
            const uncounted = await db.get(`
                SELECT COUNT(*) as count
                FROM inventory_count_items
                WHERE count_id = ? AND actual_quantity IS NULL
            `, [countId]);

            if (uncounted.count > 0) {
                return res.status(400).json({
                    error: `未カウントの商品が${uncounted.count}件あります`
                });
            }

            await db.run(`
                UPDATE inventory_counts
                SET status = 'completed', completed_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [countId]);

            res.json({ success: true, message: '棚卸を完了しました' });
        } catch (err) {
            console.error('Error completing inventory count:', err);
            res.status(500).json({ error: 'サーバーエラーが発生しました' });
        }
    });

    // 差異を在庫に反映（承認・調整）
    router.post('/:id/approve', async (req, res) => {
        try {
            const countId = req.params.id;
            const userId = req.session.userId;

            const result = await withTransaction(db, async () => {
                // 状態の確認もトランザクションの中で行う。外で確認すると、
                // 承認ボタンを二度押ししたときに両方が確認を通過して、
                // 同じ差異が 2 回在庫に反映される。
                const count = await db.get(
                    'SELECT * FROM inventory_counts WHERE id = ?',
                    [countId]
                );

                if (!count) {
                    throw new StockError('棚卸が見つかりません', 404);
                }

                if (count.status !== 'completed') {
                    throw new StockError('棚卸が完了していません');
                }

                // 差異のある商品を取得（difference が NULL の未カウント分は対象外）
                const items = await db.all(`
                    SELECT * FROM inventory_count_items
                    WHERE count_id = ? AND difference != 0
                `, [countId]);

                const negativeStockItems = [];

                for (const item of items) {
                    // 実在庫をそのまま代入すると、棚卸してから承認するまでのあいだに
                    // 入出庫があった場合にその分が消えてしまう。差異を「増減量」として
                    // 足し込むことで、途中の入出庫を残したまま棚の実数に合わせる。
                    const updated = await applyStockChange(db, {
                        productId: item.product_id,
                        type: 'adjust',
                        quantity: item.difference,
                        date: count.count_date,
                        note: `棚卸調整: ${item.reason || '差異調整'}`,
                        userId: userId,
                        // 実際に数えた数が正なので、マイナスになっても受け入れて表に出す
                        allowNegative: true
                    });

                    if (updated.current_stock < 0) {
                        negativeStockItems.push(updated.name);
                    }
                }

                // 棚卸を承認済みに
                await db.run(`
                    UPDATE inventory_counts
                    SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [userId, countId]);

                return { adjustedItems: items.length, negativeStockItems };
            });

            const message = result.negativeStockItems.length > 0
                ? `棚卸差異を在庫に反映しました。在庫がマイナスになった商品があります（${result.negativeStockItems.join('、')}）。入出庫の記録漏れがないか確認してください`
                : '棚卸差異を在庫に反映しました';

            res.json({
                success: true,
                message: message,
                adjusted_items: result.adjustedItems,
                negative_stock_items: result.negativeStockItems
            });
        } catch (err) {
            respondWithStockError(res, err, '棚卸の承認に失敗しました');
        }
    });

    // 棚卸削除（実施中のみ）
    router.delete('/:id', async (req, res) => {
        try {
            const countId = req.params.id;

            const count = await db.get(
                'SELECT * FROM inventory_counts WHERE id = ?',
                [countId]
            );

            if (!count) {
                return res.status(404).json({ error: '棚卸が見つかりません' });
            }

            if (count.status !== 'in_progress') {
                return res.status(400).json({
                    error: '実施中の棚卸のみ削除できます'
                });
            }

            // 明細を削除
            await db.run('DELETE FROM inventory_count_items WHERE count_id = ?', [countId]);

            // 棚卸を削除
            await db.run('DELETE FROM inventory_counts WHERE id = ?', [countId]);

            res.json({ success: true, message: '棚卸を削除しました' });
        } catch (err) {
            console.error('Error deleting inventory count:', err);
            res.status(500).json({ error: 'サーバーエラーが発生しました' });
        }
    });

    // 棚卸差異レポート取得
    router.get('/:id/report', async (req, res) => {
        try {
            const countId = req.params.id;

            const count = await db.get(
                'SELECT * FROM inventory_counts WHERE id = ?',
                [countId]
            );

            if (!count) {
                return res.status(404).json({ error: '棚卸が見つかりません' });
            }

            // ユーザー名をメインDBから取得
            const user = await mainDb.get('SELECT user_name FROM users WHERE id = ?', [count.user_id]);
            count.created_by = user ? user.user_name : '不明';

            const items = await db.all(`
                SELECT
                    ici.*,
                    p.name as product_name,
                    p.category
                FROM inventory_count_items ici
                JOIN products p ON ici.product_id = p.id
                WHERE ici.count_id = ?
                ORDER BY ABS(ici.difference) DESC
            `, [countId]);

            // 統計情報
            const stats = {
                total_items: items.length,
                counted_items: items.filter(i => i.actual_quantity !== null).length,
                items_with_difference: items.filter(i => i.difference !== 0 && i.difference !== null).length,
                total_difference: items.reduce((sum, i) => sum + (i.difference || 0), 0),
                positive_difference: items.filter(i => i.difference > 0).reduce((sum, i) => sum + i.difference, 0),
                negative_difference: items.filter(i => i.difference < 0).reduce((sum, i) => sum + Math.abs(i.difference), 0)
            };

            res.json({
                count,
                items,
                stats
            });
        } catch (err) {
            console.error('Error fetching report:', err);
            res.status(500).json({ error: 'サーバーエラーが発生しました' });
        }
    });

    return router;
};
