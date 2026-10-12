// 在庫履歴の一覧・CSV で共通に使う、絞り込みと書式。
//
// 利用者画面の「履歴確認」と、管理画面の「出庫記録」の両方から使う。
// 別々に書くと、同じ条件で出したはずの画面と CSV の行が食い違う。

const { parseProductId, parseTransactionDate } = require('./stock');
const { sanitizeHtml, unescapeHtml } = require('./xss-protection');

// 履歴の一覧と CSV で共通の SELECT。transaction_date は取引日（無ければ登録日）
const HISTORY_SELECT = `
    SELECT h.*, p.name as product_name, p.category,
           CASE
               WHEN h.date IS NOT NULL THEN h.date
               ELSE DATE(h.created_at)
           END as transaction_date
    FROM inventory_history h
    JOIN products p ON h.product_id = p.id
`;

/**
 * 履歴の絞り込み条件（商品・カテゴリ・期間）を SQL の条件にする。
 *
 * 画面の一覧と CSV 出力で同じものを使う。別々に書くと、画面に出ている行と
 * CSV の行が食い違う。期間は取引日（date、無ければ登録日）で見る。
 *
 * 条件を足したいとき（出庫記録の「出した人」など）は、conditions と params の
 * 後ろに足して WHERE を組み直す。
 *
 * @returns {{where: string, conditions: string[], params: Array, filter: object}}
 */
function buildHistoryFilter(query) {
    const conditions = [];
    const params = [];
    const filter = {
        productId: query.productId ? parseProductId(query.productId) : null,
        category: query.category ? String(query.category) : null,
        startDate: parseTransactionDate(query.startDate),
        endDate: parseTransactionDate(query.endDate)
    };

    if (filter.productId) {
        conditions.push('h.product_id = ?');
        params.push(filter.productId);
    }

    if (filter.category) {
        // カテゴリは保存時にエスケープしてある（sanitizeHtml）。画面の選択肢は
        // 元の文字で届くので、保存されている形にそろえた値でも比べる
        conditions.push('(p.category = ? OR p.category = ?)');
        params.push(filter.category, sanitizeHtml(filter.category));
    }

    if (filter.startDate) {
        conditions.push('DATE(COALESCE(h.date, h.created_at)) >= ?');
        params.push(filter.startDate);
    }

    if (filter.endDate) {
        conditions.push('DATE(COALESCE(h.date, h.created_at)) <= ?');
        params.push(filter.endDate);
    }

    return {
        where: toWhere(conditions),
        conditions,
        params,
        filter
    };
}

/** 条件の配列を WHERE 句にする。条件が無ければ空 */
function toWhere(conditions) {
    return conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
}

/**
 * 履歴 CSV の「日時」。画面の一覧と同じく、取引日と登録した時刻（日本時間）を並べる。
 *
 * 期間の絞り込みは取引日で見ているので、日付も取引日にしておかないと、期間の外の
 * 日付に見える行が混ざる（週次入力は後日まとめて登録するため）。created_at は UTC で
 * 保存されているので、時刻は日本時間に直す。
 */
function formatHistoryDateTime(row) {
    const date = String(row.transaction_date || '').replace(/-/g, '/');
    const createdAt = new Date(String(row.created_at).replace(' ', 'T') + 'Z');

    if (Number.isNaN(createdAt.getTime())) {
        return date;
    }

    const time = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).format(createdAt);

    return `${date} ${time}`;
}

/** ファイル名に使えない文字を _ に置き換える */
function safeFileNamePart(text) {
    return String(text).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
}

/**
 * CSV のファイル名。何を絞って出したものか、名前で分かるようにする。
 * 例: 入出庫履歴_掃除用ゴム手袋 Mサイズ_20250801-20260930.csv
 *     出庫記録_本店_田中_全商品_20250801-20250930.csv（出した人で絞ったとき）
 *
 * @param {object} db - 拠点データベース（商品名を引くため）
 * @param {object} filter - buildHistoryFilter の filter。出庫記録では takenBy・unrecorded も見る
 * @param {string} prefix - 先頭に付ける名前（例: 入出庫履歴）
 */
async function exportFileName(db, filter, prefix) {
    let target = '全商品';

    if (filter.productId) {
        const product = await db.get('SELECT name FROM products WHERE id = ?', [filter.productId]);
        target = product ? unescapeHtml(product.name) : `商品${filter.productId}`;
    } else if (filter.category) {
        target = unescapeHtml(filter.category);
    }

    const period = filter.startDate || filter.endDate
        ? `_${(filter.startDate || '').replace(/-/g, '')}-${(filter.endDate || '').replace(/-/g, '')}`
        : '';

    // 出した人で絞ったときは、その人の名前を先頭に付ける
    if (filter.takenBy) {
        target = `${filter.takenBy}_${target}`;
    } else if (filter.unrecorded) {
        target = `未記入_${target}`;
    }

    // 長すぎる商品名は切る
    return `${safeFileNamePart(prefix)}_${safeFileNamePart(target).slice(0, 60)}${period}.csv`;
}

module.exports = {
    HISTORY_SELECT,
    buildHistoryFilter,
    toWhere,
    formatHistoryDateTime,
    exportFileName
};
