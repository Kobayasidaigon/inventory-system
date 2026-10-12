const express = require('express');
const { getLocationDatabase, mainDb } = require('../db/database-admin');
const { requireAuth } = require('../middleware/auth');
const { sendOrderNotification } = require('../services/line-notify');
const { sanitizeHtml, unescapeHtml } = require('../utils/xss-protection');
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
const { attachOperatorNames } = require('../utils/operator-name');
const { toCsv, attachmentHeader } = require('../utils/csv');
const {
    HISTORY_SELECT,
    buildHistoryFilter,
    formatHistoryDateTime,
    exportFileName
} = require('../utils/history-query');
const { parseTakerName, listTakerCandidates } = require('../services/takeouts');
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
        // 出庫では「出した人」を残す。画面では必ず入れてもらうが、API では省略を許す。
        // 開きっぱなしの古い画面（名前を送らない）から出庫できなくなるのを避けるため。
        // 省略されたら入場リンクの操作者名を使い、それも無ければ空（出庫記録で「未記入」）。
        const takenBy = type === 'out'
            ? parseTakerName(req.body.takenBy) || req.session.operatorName || null
            : null;

        const { product, autoOrder } = await withTransaction(db, async () => {
            const updated = await applyStockChange(db, {
                productId,
                type,
                quantity,
                date,
                note,
                userId: req.session.userId,
                operatorName: req.session.operatorName,
                takenBy
            });

            // 発注依頼済みの商品には自動発注を作らない（createAutoOrderIfNeeded が
            // 未入荷の依頼を見て判断する）。届いた商品を入庫したタイミングで
            // 同じ依頼をもう一度作ってしまうのを防ぐため。
            const order = await createAutoOrderIfNeeded(db, {
                product: updated,
                userId: req.session.userId,
                operatorName: req.session.operatorName
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
                    userId: req.session.userId,
                    operatorName: req.session.operatorName
                });
                updatedProducts.set(entry.productId, updated);
            }

            // 同じ商品を何日ぶんも入力するので、発注判定は全部反映してから 1 回だけ行う
            const created = [];
            for (const product of updatedProducts.values()) {
                const order = await createAutoOrderIfNeeded(db, {
                    product,
                    userId: req.session.userId,
                    operatorName: req.session.operatorName
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
    // 件数は 1〜1000 に収める。文字列がそのまま LIMIT に渡ると 500 になる。
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 1000);

    try {
        const { where, params } = buildHistoryFilter(req.query);
        const history = await db.all(
            `${HISTORY_SELECT}${where} ORDER BY h.created_at DESC LIMIT ?`,
            [...params, limit]
        );

        await attachOperatorNames(mainDb, history);

        res.json(history);
    } catch (err) {
        respondWithStockError(res, err, '履歴取得エラー');
    }
});

// 出庫のダイアログで選べる名前の候補（今日の勤務予定・最近使われた名前）。
// 誰が何個出したかの集計は、ここ（利用者画面）には出さない。管理画面だけで見る
// （server/routes/auth-admin.js の /admin/locations/:locationId/takeouts）
router.get('/takers', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);

    try {
        const candidates = await listTakerCandidates(db, mainDb, req.session.locationId);

        // 入場リンクで名前が分かっているときは、ダイアログに最初から入れておく
        res.json({ ...candidates, operatorName: req.session.operatorName || null });
    } catch (err) {
        respondWithStockError(res, err, '名前の候補の取得に失敗しました');
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
            // 在庫履歴をエクスポート。画面で選んでいる条件（商品・カテゴリ・期間）で絞る。
            // 画面の一覧は新しい順に 50 件までだが、CSV は条件に合うものを全件出す
            const { where, params, filter } = buildHistoryFilter(req.query);
            const history = await db.all(
                `${HISTORY_SELECT}${where} ORDER BY h.created_at DESC`,
                params
            );

            await attachOperatorNames(mainDb, history);

            const typeLabel = (t) => (t === 'in' ? '入庫' : t === 'out' ? '出庫' : '調整');

            // 商品名・備考・名前は保存時に HTML 用にエスケープしてあるので戻す
            // （画面では元の文字に見えるが、CSV には「&#x2F;」などがそのまま出てしまう）
            const csv = toCsv(
                ['ID', '日時', '商品名', '種別', '数量', '備考', '担当者', '出した人'],
                history.map(h => [
                    h.id,
                    formatHistoryDateTime(h),
                    unescapeHtml(h.product_name),
                    typeLabel(h.type),
                    h.quantity,
                    unescapeHtml(h.note || ''),
                    unescapeHtml(h.username),
                    h.taken_by || ''
                ])
            );

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader(
                'Content-Disposition',
                attachmentHeader(await exportFileName(db, filter, '入出庫履歴'), 'inventory_history.csv')
            );
            res.send(csv);
        } else {
            res.status(400).json({ error: '不明なエクスポート種別です' });
        }
    } catch (error) {
        respondWithStockError(res, error, 'エクスポートエラー');
    }
});

// 在庫推移グラフデータ取得
router.get('/chart', requireAuth, async (req, res) => {
    const db = getLocationDatabase(req.session.locationCode);

    try {
        const productId = parseProductId(req.query.productId);
        const days = parseChartDays(req.query.days);

        const product = await db.get(
            'SELECT name, reorder_point FROM products WHERE id = ?',
            [productId]
        );

        if (!product) {
            throw new StockError('商品が見つかりません', 404);
        }

        const chart = await buildStockChartData(db, productId, days);

        res.json({
            productName: product.name,
            reorderPoint: Number(product.reorder_point) || 0,
            labels: chart.labels,
            stocks: chart.stocks,
            dailyConsumption: chart.dailyConsumption,
            // 過去の在庫がマイナスに復元された = 履歴に記録漏れがある
            hasNegative: chart.hasNegative
        });
    } catch (err) {
        respondWithStockError(res, err, 'データ取得エラー');
    }
});

module.exports = router;
