// 現在庫と履歴のズレを埋める。
//
// 在庫の更新と履歴の追記が別々のクエリだった頃のデータには、
// 「現在庫 = 履歴の増減の合計」が成り立たない商品がある。
//   - 商品登録時の初期在庫が履歴に残っていなかった
//   - 商品編集での在庫変更が履歴に残っていなかった
//   - 履歴だけ書けて在庫の更新が落ちた（またはその逆）
//
// どちらを正とするかは、現在庫を正とする。
// 店の人が毎日見て、必要なら直してきたのは現在庫の方で、
// 履歴の合計は「記録が抜けた分だけ足りない数」でしかない。
//
// そのため現在庫は動かさず、差分を説明する調整履歴を 1 件足す。

const { withTransaction } = require('../utils/stock');

// 調整履歴に残す備考。あとから検索して見分けられるようにしておく。
const RECONCILE_NOTE = '整合調整（過去の記録漏れ分）';

/**
 * 履歴 1 件が在庫に与えた増減量。
 * adjust は符号付きの増減量として保存されている。
 */
function historyDelta(row) {
    const quantity = Number(row.quantity) || 0;
    return row.type === 'out' ? -quantity : quantity;
}

/**
 * 調整履歴を入れる日付を決める。
 *
 * 「今日」にすると、在庫推移グラフの直近に大きな段差が出て、
 * 実際には起きていない在庫の動きがあったように見えてしまう。
 * ズレは過去に積み重なったものなので、その商品の最初の記録の日に置く。
 */
function pickAdjustDate(firstHistoryDate, productCreatedAt) {
    if (firstHistoryDate) {
        return String(firstHistoryDate).slice(0, 10);
    }
    if (productCreatedAt) {
        return String(productCreatedAt).slice(0, 10);
    }
    return null;
}

/**
 * 1 つの拠点のズレを調べる。書き換えはしない。
 *
 * @param {object} db - 拠点データベース
 * @returns {Promise<Array>} ズレのある商品の一覧
 */
async function findDiscrepancies(db) {
    const products = await db.all('SELECT * FROM products ORDER BY id');
    const discrepancies = [];

    for (const product of products) {
        const rows = await db.all(
            `SELECT type, quantity, date, created_at
             FROM inventory_history
             WHERE product_id = ?
             ORDER BY COALESCE(date, DATE(created_at)) ASC, created_at ASC`,
            [product.id]
        );

        const historyTotal = rows.reduce((sum, row) => sum + historyDelta(row), 0);
        const currentStock = Number(product.current_stock) || 0;
        const diff = currentStock - historyTotal;

        if (diff === 0) {
            continue;
        }

        const first = rows[0];
        discrepancies.push({
            productId: product.id,
            productName: product.name,
            currentStock,
            historyTotal,
            diff,
            historyCount: rows.length,
            adjustDate: pickAdjustDate(
                first ? first.date || first.created_at : null,
                product.created_at
            )
        });
    }

    return discrepancies;
}

/**
 * 見つかったズレを調整履歴として記録する。
 *
 * 現在庫は動かさない。ここで applyStockChange を使うと在庫まで動いてしまい、
 * 直したいズレが倍になる。履歴だけを足すのが正しい。
 *
 * @param {object} db - 拠点データベース
 * @param {Array} discrepancies - findDiscrepancies() の結果
 * @param {number} userId - 記録に残す操作者
 * @returns {Promise<number>} 追加した件数
 */
async function applyReconciliation(db, discrepancies, userId) {
    if (discrepancies.length === 0) {
        return 0;
    }

    return withTransaction(db, async () => {
        for (const item of discrepancies) {
            await db.run(
                `INSERT INTO inventory_history (product_id, type, quantity, date, note, user_id)
                 VALUES (?, 'adjust', ?, ?, ?, ?)`,
                [item.productId, item.diff, item.adjustDate, RECONCILE_NOTE, userId]
            );
        }

        return discrepancies.length;
    });
}

/**
 * 調べて、必要なら直す。
 *
 * @param {object} db - 拠点データベース
 * @param {object} options
 * @param {boolean} [options.apply] - true のときだけ書き換える
 * @param {number} [options.userId] - 記録に残す操作者（既定 0 = システム）
 */
async function reconcileLocation(db, { apply = false, userId = 0 } = {}) {
    const discrepancies = await findDiscrepancies(db);
    const applied = apply ? await applyReconciliation(db, discrepancies, userId) : 0;

    return { discrepancies, applied };
}

module.exports = {
    RECONCILE_NOTE,
    historyDelta,
    findDiscrepancies,
    applyReconciliation,
    reconcileLocation
};
