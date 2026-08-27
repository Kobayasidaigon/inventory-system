// 在庫計算の共通処理。
//
// 在庫は「products.current_stock（現在庫）」と「inventory_history（増減の履歴）」の
// 2 か所に書かれる。この 2 つが食い違うと、どちらが正しいのか誰にも分からなくなる。
// そのため在庫を動かす処理は必ずこのファイルの applyStockChange() を通し、
// 履歴の追記と現在庫の更新を 1 つのトランザクションにまとめる。

// 1 回の入出庫で扱える数量の上限。桁を打ち間違えたときの被害を抑えるための値で、
// 業務上の制約ではない。実運用でこれを超える入力が必要になったら引き上げてよい。
const MAX_QUANTITY = 1000000;

/**
 * 在庫操作の失敗。HTTP ステータスを持たせて、呼び出し側がそのまま返せるようにする。
 */
class StockError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'StockError';
        this.status = status;
    }
}

/**
 * リクエストボディの数量を検証して整数に変換する。
 *
 * JSON からは文字列・小数・null・NaN・巨大値が何でも飛んでくる。検証せずに
 * SQL へ渡すと、たとえば 'abc' は SQLite で NULL に化けて current_stock を
 * NULL にしてしまい、以降その商品の在庫計算がすべて壊れる。
 *
 * @param {*} value - 検証する値
 * @param {string} label - エラーメッセージに出す項目名
 * @returns {number} 1 以上の整数
 */
function parseQuantity(value, label = '数量') {
    if (value === null || value === undefined || value === '') {
        throw new StockError(`${label}を入力してください`);
    }

    const num = typeof value === 'number' ? value : Number(String(value).trim());

    if (!Number.isFinite(num)) {
        throw new StockError(`${label}は数値で入力してください`);
    }
    if (!Number.isInteger(num)) {
        throw new StockError(`${label}は整数で入力してください`);
    }
    if (num <= 0) {
        throw new StockError(`${label}は 1 以上で入力してください`);
    }
    if (num > MAX_QUANTITY) {
        throw new StockError(`${label}が大きすぎます（上限 ${MAX_QUANTITY.toLocaleString()}）`);
    }

    return num;
}

/**
 * ID などの正の整数を検証して返す。
 */
function parsePositiveInt(value, label) {
    const num = typeof value === 'number' ? value : Number(String(value ?? '').trim());

    if (!Number.isInteger(num) || num <= 0) {
        throw new StockError(`${label}が正しくありません`);
    }

    return num;
}

/**
 * 商品 ID を検証して整数に変換する。
 */
function parseProductId(value) {
    const num = typeof value === 'number' ? value : Number(String(value ?? '').trim());

    if (!Number.isInteger(num) || num <= 0) {
        throw new StockError('商品を指定してください');
    }

    return num;
}

/**
 * 在庫数そのもの（初期在庫・実在庫）を検証する。
 *
 * 数量と違って 0 を許す。「今この商品は 0 個」は正当な入力のため。
 *
 * @returns {number} 0 以上の整数
 */
function parseStockLevel(value, label = '在庫数') {
    if (value === null || value === undefined || value === '') {
        throw new StockError(`${label}を入力してください`);
    }

    const num = typeof value === 'number' ? value : Number(String(value).trim());

    if (!Number.isFinite(num)) {
        throw new StockError(`${label}は数値で入力してください`);
    }
    if (!Number.isInteger(num)) {
        throw new StockError(`${label}は整数で入力してください`);
    }
    if (num < 0) {
        throw new StockError(`${label}は 0 以上で入力してください`);
    }
    if (num > MAX_QUANTITY) {
        throw new StockError(`${label}が大きすぎます（上限 ${MAX_QUANTITY.toLocaleString()}）`);
    }

    return num;
}

/**
 * 取引日を検証する。
 *
 * 未指定なら null を返す（履歴側は date が null のとき created_at で代用する）。
 * 「2026-08-32」のような存在しない日付も弾く。
 *
 * @returns {string|null} YYYY-MM-DD
 */
function parseTransactionDate(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const text = String(value).trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        throw new StockError('日付は YYYY-MM-DD 形式で指定してください');
    }

    // Date は 2 月 30 日のような日付を 3 月 2 日へ繰り上げてしまうので、
    // 変換して戻したものが元と一致するかで存在しない日付を判定する
    const parsed = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
        throw new StockError('存在しない日付が指定されています');
    }

    return text;
}

// 接続ごとの実行キュー。
//
// 拠点ごとに sqlite3 の接続を 1 本だけ共有しているため、2 つのリクエストが同時に
// BEGIN すると SQLite が "cannot start a transaction within a transaction" を返し、
// 片方の更新が別のトランザクションに巻き込まれて一緒に ROLLBACK される。
// 接続単位で直列化してこれを防ぐ。
const queues = new WeakMap();

function runExclusive(db, task) {
    const prev = queues.get(db) || Promise.resolve();
    // 前の処理が失敗しても順番は進める（失敗は呼び出し元にだけ返す）
    const run = prev.then(task, task);
    queues.set(db, run.then(noop, noop));
    return run;
}

function noop() {}

/**
 * トランザクションの中で fn を実行する。同じ接続に対する呼び出しは直列化される。
 *
 * @param {object} db - 拠点データベース
 * @param {Function} fn - トランザクション内で実行する処理
 */
async function withTransaction(db, fn) {
    return runExclusive(db, async () => {
        // テーブル作成・マイグレーションが終わる前に走らないように待つ
        if (db.ready) {
            await db.ready;
        }

        // BEGIN IMMEDIATE: 書き込みロックを最初に取る。読み取りから書き込みへ
        // 昇格しようとして SQLITE_BUSY になるのを避ける。
        await db.run('BEGIN IMMEDIATE');
        try {
            const result = await fn();
            await db.run('COMMIT');
            return result;
        } catch (err) {
            try {
                await db.run('ROLLBACK');
            } catch (rollbackErr) {
                console.error('ROLLBACK に失敗しました:', rollbackErr);
            }
            throw err;
        }
    });
}

/**
 * 在庫を増減し、同じトランザクションで履歴に記録する。
 *
 * 必ず withTransaction() の中から呼ぶこと。
 *
 * @param {object} db - 拠点データベース
 * @param {object} params
 * @param {number} params.productId - 商品 ID（検証済みの整数）
 * @param {'in'|'out'|'adjust'} params.type - 入庫 / 出庫 / 調整
 * @param {number} params.quantity - in・out は 1 以上、adjust は符号付きの増減量
 * @param {string|null} [params.date] - 取引日（省略時は created_at を使う）
 * @param {string} [params.note] - 備考
 * @param {number} params.userId - 操作者
 * @param {boolean} [params.allowNegative] - 在庫がマイナスになるのを許すか
 * @returns {Promise<object>} 更新後の商品行
 */
async function applyStockChange(db, params) {
    const { productId, type, quantity, date = null, note = '', userId, allowNegative = false } = params;

    const product = await db.get('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) {
        throw new StockError('商品が見つかりません', 404);
    }

    const delta = type === 'out' ? -quantity : quantity;
    const currentStock = Number(product.current_stock) || 0;
    const nextStock = currentStock + delta;

    if (!allowNegative && nextStock < 0) {
        throw new StockError(
            `在庫が不足しています（${product.name}: 現在庫 ${currentStock} / 出庫 ${quantity}）`
        );
    }

    await db.run(
        `INSERT INTO inventory_history (product_id, type, quantity, date, note, user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [productId, type, quantity, date, note, userId]
    );

    await db.run('UPDATE products SET current_stock = ? WHERE id = ?', [nextStock, productId]);

    return { ...product, current_stock: nextStock };
}

/**
 * 自動発注する数量を求める。
 *
 * 発注点の 2 倍まで戻すのが基本。ただし在庫が発注点を大きく超えて余っている
 * ような場合でも、最低 1 回の発注点ぶんは頼む。
 */
function calcOrderQuantity(product) {
    const reorderPoint = Number(product.reorder_point) || 0;
    const currentStock = Number(product.current_stock) || 0;

    return Math.max(reorderPoint * 2 - currentStock, reorderPoint);
}

// 在庫を確保済みとみなす発注ステータス。
// この状態の依頼があるあいだは、同じ商品の自動発注を重ねて作らない。
const ACTIVE_ORDER_STATUSES = ['pending', 'ordered'];

/**
 * 在庫が発注点を下回っていれば自動で発注依頼を作る。
 *
 * すでに未入荷の依頼がある商品には作らない。作った場合だけ依頼の内容を返す。
 *
 * @returns {Promise<{orderQuantity: number}|null>}
 */
async function createAutoOrderIfNeeded(db, { product, userId }) {
    const currentStock = Number(product.current_stock) || 0;
    const reorderPoint = Number(product.reorder_point) || 0;

    if (currentStock > reorderPoint) {
        return null;
    }

    const placeholders = ACTIVE_ORDER_STATUSES.map(() => '?').join(', ');
    const existingOrder = await db.get(
        `SELECT id FROM order_requests
         WHERE product_id = ? AND status IN (${placeholders})`,
        [product.id, ...ACTIVE_ORDER_STATUSES]
    );

    if (existingOrder) {
        return null;
    }

    const orderQuantity = calcOrderQuantity(product);

    await db.run(
        `INSERT INTO order_requests (product_id, requested_quantity, user_id, note, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [product.id, orderQuantity, userId, '在庫が発注点を下回ったため自動発注']
    );

    return { orderQuantity };
}

/**
 * Date をローカル時刻のまま YYYY-MM-DD にする。
 *
 * toISOString() は UTC に変換してしまうので、日本時間の朝 9 時より前は
 * 前日の日付になる。履歴の date は利用者の端末のローカル日付で入るため、
 * ここで UTC に寄せるとグラフの目盛りと履歴が 1 日ずれる。
 */
function toDateString(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * 履歴 1 件が在庫に与えた増減量を返す。
 *
 * adjust（棚卸調整・初期在庫）の quantity は符号付きの増減量として保存されている。
 */
function historyDelta(item) {
    const quantity = Number(item.quantity) || 0;
    return item.type === 'out' ? -quantity : quantity;
}

/**
 * 在庫推移グラフのデータを組み立てる。
 *
 * 現在庫を起点に履歴を遡って各日の在庫を復元する。利用者画面と管理画面の
 * どちらからも呼ぶので、計算はここ 1 か所に置く。
 *
 * @param {object} db - 拠点データベース
 * @param {number} productId - 商品 ID
 * @param {number} days - 何日分さかのぼるか
 * @returns {Promise<{labels: string[], stocks: number[], dailyConsumption: number[]}>}
 */
async function buildStockChartData(db, productId, days) {
    const product = await db.get('SELECT current_stock FROM products WHERE id = ?', [productId]);

    if (!product) {
        throw new StockError('商品が見つかりません', 404);
    }

    // 並び順は登録日時ではなく取引日。週次入力や棚卸調整は数日前の日付で
    // 後から登録されるので、登録順に遡ると過去の日に在庫が誤って積み上がる。
    const history = await db.all(`
        SELECT
            COALESCE(h.date, DATE(h.created_at)) as date,
            h.type,
            h.quantity,
            h.created_at
        FROM inventory_history h
        WHERE h.product_id = ?
        AND DATE(COALESCE(h.date, h.created_at)) >= DATE('now', '-' || ? || ' days')
        ORDER BY COALESCE(h.date, DATE(h.created_at)) ASC, h.created_at ASC
    `, [productId, days]);

    // 各日の消費量（出庫量）を集計
    const consumptionMap = {};
    for (const item of history) {
        if (item.type === 'out') {
            consumptionMap[item.date] = (consumptionMap[item.date] || 0) + (Number(item.quantity) || 0);
        }
    }

    // 現在庫から遡って、各日の「その日の最後の取引が終わった時点」の在庫を復元する
    const dateMap = {};
    let stock = Number(product.current_stock) || 0;

    for (let i = history.length - 1; i >= 0; i--) {
        const item = history[i];

        // 遡っている途中なので、同じ日付で最初に来るのがその日の最後の取引になる。
        // 在庫 0 の日を上書きしないよう undefined で判定する。
        if (dateMap[item.date] === undefined) {
            dateMap[item.date] = stock;
        }

        stock -= historyDelta(item);
    }
    // ここでの stock は、取得した履歴より前（グラフ期間の開始時点）の在庫

    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - days);

    const labels = [];
    const stocks = [];
    const dailyConsumption = [];

    for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
        const dateStr = toDateString(d);
        labels.push(dateStr);

        // 取引があった日はその日の終わりの在庫、なければ前日から据え置き
        if (dateMap[dateStr] !== undefined) {
            stock = dateMap[dateStr];
        }
        stocks.push(stock);

        dailyConsumption.push(consumptionMap[dateStr] || 0);
    }

    // 復元した在庫がマイナスになったら、履歴に記録漏れがある。
    // 「実際にあった数より多く出庫している」ことになり、現実には起こりえない。
    // グラフの過去の部分が実際とずれているので、画面で断りを出せるように返す。
    const hasNegative = stocks.some(value => value < 0);

    return { labels, stocks, dailyConsumption, hasNegative };
}

/**
 * グラフの日数指定を検証する。1〜365 日に収める。
 */
function parseChartDays(value) {
    const num = parseInt(value, 10);
    return Math.min(Math.max(Number.isFinite(num) ? num : 30, 1), 365);
}

/**
 * 在庫操作のエラーをレスポンスに変換する。
 *
 * StockError（入力ミスや在庫不足）はそのまま利用者に見せる。それ以外は
 * 想定外なのでログに残し、汎用メッセージだけ返す。
 */
function respondWithStockError(res, err, fallbackMessage) {
    if (err instanceof StockError) {
        return res.status(err.status).json({ error: err.message });
    }

    console.error(`${fallbackMessage}:`, err);
    return res.status(500).json({ error: fallbackMessage });
}

module.exports = {
    MAX_QUANTITY,
    ACTIVE_ORDER_STATUSES,
    StockError,
    parseQuantity,
    parseStockLevel,
    parsePositiveInt,
    parseProductId,
    parseTransactionDate,
    withTransaction,
    applyStockChange,
    calcOrderQuantity,
    createAutoOrderIfNeeded,
    buildStockChartData,
    parseChartDays,
    respondWithStockError
};
