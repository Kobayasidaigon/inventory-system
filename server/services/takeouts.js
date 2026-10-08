// 出庫の記録（誰が何個出したか）と、補充が早すぎないかの見張り。
//
// 拠点のアカウントは店で共用しているので、ログインしている名前だけでは
// 誰が備品を出したのか分からない。出庫のたびに「出した人」を行に残し
// （inventory_history.taken_by）、人ごとの集計と CSV で見られるようにする。
//
// あわせて、前回補充した量がいつもよりずっと早くなくなり、また補充した商品を拾う。
// 出庫の登録漏れや持ち出しがあると、記録とは関係なく棚から物が減るので、
// 補充の間隔が縮む。

const { StockError } = require('../utils/stock');

/** 出した人の名前の長さの上限。入場リンクの操作者名（by）と同じにしている。 */
const TAKER_MAX_LENGTH = 40;

/**
 * 出した人の名前に使わせない文字。入場リンクの操作者名と同じ決まり。
 *
 * 名前は一覧の表になって CSV にも出る。表はテンプレート文字列で組み立てているので、
 * HTML として読める文字は受け取らない。& は `&#60;` のような書き方を防ぐため。
 */
const TAKER_FORBIDDEN = /[<>"'&\\]|[\u0000-\u001f\u007f]/;

/**
 * ダッシュボードの +1 / +5 ボタンの備考。誤操作を戻すためのもので、補充ではない。
 * 画面（public/js/app.js）が送る文字と同じにしておくこと。
 */
const QUICK_OPERATION_NOTE = 'クイック操作';

/**
 * 「補充が早すぎる」とみなす割合。前回補充した量が、いつもの消費のペースなら
 * もつはずの日数の、この割合以下でなくなったら拾う（0.5 = 半分以下）。
 * 「明らかに短い」ものだけを拾いたいので、ばらつきで引っかからない程度に低くしてある。
 */
const QUICK_RESTOCK_RATIO = 0.5;

/** いつものペースを決めるのに使う、直前の補充間隔の数（多すぎると季節の変化に追いつかない）。 */
const BASELINE_CYCLES = 6;

/** いつものペースを決めるのに最低限要る補充間隔の数。1 回だけでは、たまたまの長さに引きずられる。 */
const MIN_BASELINE_CYCLES = 2;

/**
 * 出した人の名前を検証して整える。
 *
 * 前後の空白を落とし、途中の空白（全角を含む）は半角 1 つにそろえる。
 * 「田中　花子」と「田中 花子」が別の人として集計されないようにするため。
 *
 * @returns {string|null} 名前。空なら null
 */
function parseTakerName(value) {
    if (value === null || value === undefined) {
        return null;
    }

    const name = String(value).replace(/\s+/g, ' ').trim();

    if (name === '') {
        return null;
    }
    if (name.length > TAKER_MAX_LENGTH) {
        throw new StockError(`出した人の名前は ${TAKER_MAX_LENGTH} 文字以内で入力してください`);
    }
    if (TAKER_FORBIDDEN.test(name)) {
        throw new StockError('出した人の名前に使えない文字が入っています（< > " \' & \\ など）');
    }

    return name;
}

/** YYYY-MM-DD どうしの日数の差（b - a） */
function daysBetween(a, b) {
    const toTime = text => Date.parse(`${text}T00:00:00Z`);
    return Math.round((toTime(b) - toTime(a)) / (24 * 60 * 60 * 1000));
}

function median(values) {
    const sorted = [...values].sort((x, y) => x - y);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 補充の記録から、早すぎる補充を拾う。データベースに触らない計算だけの部分。
 *
 * 1 回の補充から次の補充までを 1 区間とし、「前回補充した量 ÷ 日数」をその区間の
 * 消費のペースとみなす。発注点で補充しているなら、区間のあいだに減った量は
 * ほぼ前回補充した量になるため。日数ではなくペースで比べるのは、少しだけ補充した
 * あとに早く次が来るのを拾わないようにするため。
 *
 * 直前の区間（最大 BASELINE_CYCLES 個）のペースの中央値を「いつものペース」とし、
 * そのペースならもつはずの日数の QUICK_RESTOCK_RATIO 以下で次の補充が来たら拾う。
 *
 * @param {Array<{product_id: number, date: string, quantity: number}>} restocks
 *        商品ごと・日付ごとにまとめた補充。商品 → 日付の順に並んでいること
 * @returns {Array<object>} 早すぎる補充
 */
function detectQuickRestocks(restocks) {
    const byProduct = new Map();

    for (const row of restocks) {
        if (!byProduct.has(row.product_id)) {
            byProduct.set(row.product_id, []);
        }
        byProduct.get(row.product_id).push({ date: row.date, quantity: Number(row.quantity) || 0 });
    }

    const flagged = [];

    for (const [productId, list] of byProduct) {
        const cycles = [];

        for (let i = 1; i < list.length; i++) {
            const previous = list[i - 1];
            const current = list[i];
            const days = daysBetween(previous.date, current.date);

            // 同じ日の補充はまとめてあるので 0 日にはならないはずだが、念のため
            if (days <= 0 || previous.quantity <= 0) {
                continue;
            }

            const cycle = {
                productId,
                previousDate: previous.date,
                previousQuantity: previous.quantity,
                date: current.date,
                quantity: current.quantity,
                days,
                pace: previous.quantity / days
            };

            const baseline = cycles.slice(-BASELINE_CYCLES);

            if (baseline.length >= MIN_BASELINE_CYCLES) {
                const usualPace = median(baseline.map(c => c.pace));
                const expectedDays = previous.quantity / usualPace;

                if (days <= expectedDays * QUICK_RESTOCK_RATIO) {
                    flagged.push({
                        productId,
                        previousDate: cycle.previousDate,
                        previousQuantity: cycle.previousQuantity,
                        date: cycle.date,
                        quantity: cycle.quantity,
                        days,
                        // 表示用。「いつものペースなら約 14 日もつ量」
                        expectedDays: Math.round(expectedDays)
                    });
                }
            }

            // 拾った区間もいつものペースの計算に入れる。消費が本当に増えたときに、
            // いつまでも拾い続けないようにするため（数回で新しいペースに追いつく）。
            cycles.push(cycle);
        }
    }

    return flagged;
}

/** 在庫履歴の取引日。無ければ登録日（履歴の一覧・CSV と同じ決まり）。 */
const TRANSACTION_DATE_SQL = 'COALESCE(h.date, DATE(h.created_at))';

/**
 * 早すぎる補充を、商品名と「その間に誰が何個出したか」を付けて返す。
 *
 * 補充は入庫のうち、+1 / +5 ボタン（誤操作の修正用）を除いたもの。
 * 同じ商品の同じ日の入庫は 1 回の補充としてまとめる。
 *
 * @param {object} db - 拠点データベース
 * @returns {Promise<Array<object>>} 補充日の新しい順
 */
async function findQuickRestocks(db) {
    const restocks = await db.all(`
        SELECT h.product_id, ${TRANSACTION_DATE_SQL} AS date, SUM(h.quantity) AS quantity
        FROM inventory_history h
        WHERE h.type = 'in' AND COALESCE(h.note, '') <> ?
        GROUP BY h.product_id, ${TRANSACTION_DATE_SQL}
        ORDER BY h.product_id ASC, date ASC
    `, [QUICK_OPERATION_NOTE]);

    const flagged = detectQuickRestocks(restocks);

    for (const item of flagged) {
        const product = await db.get(
            'SELECT name, category FROM products WHERE id = ?',
            [item.productId]
        );
        item.productName = product ? product.name : `商品${item.productId}`;
        item.category = product ? product.category : null;

        // 前回の補充日から今回の補充日まで（両端を含む）の出庫。
        // 日付単位なので、境目の日の出庫は前後どちらの区間にも数える
        const takers = await db.all(`
            SELECT h.taken_by, SUM(h.quantity) AS quantity, COUNT(*) AS count
            FROM inventory_history h
            WHERE h.product_id = ? AND h.type = 'out'
            AND ${TRANSACTION_DATE_SQL} BETWEEN ? AND ?
            GROUP BY h.taken_by
            ORDER BY quantity DESC
        `, [item.productId, item.previousDate, item.date]);

        item.takers = takers.map(t => ({
            name: t.taken_by || null,
            quantity: Number(t.quantity) || 0,
            count: Number(t.count) || 0
        }));
        item.recordedOut = item.takers.reduce((sum, t) => sum + t.quantity, 0);
    }

    flagged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return flagged;
}

/**
 * 出庫の行を、出した人ごとにまとめる。名前の無い出庫（この機能より前の記録など）は
 * name: null の 1 行にまとめる。
 *
 * @param {Array<object>} rows - taken_by・quantity・product_name を持つ出庫の行
 * @returns {Array<{name: string|null, count: number, quantity: number, products: Array}>}
 *          合計個数の多い順
 */
function summarizeByTaker(rows) {
    const people = new Map();

    for (const row of rows) {
        const name = row.taken_by || null;

        if (!people.has(name)) {
            people.set(name, { name, count: 0, quantity: 0, products: new Map() });
        }

        const person = people.get(name);
        const quantity = Number(row.quantity) || 0;
        person.count += 1;
        person.quantity += quantity;
        person.products.set(row.product_name, (person.products.get(row.product_name) || 0) + quantity);
    }

    return [...people.values()]
        .map(person => ({
            ...person,
            products: [...person.products.entries()]
                .map(([name, quantity]) => ({ name, quantity }))
                .sort((a, b) => b.quantity - a.quantity)
        }))
        .sort((a, b) => b.quantity - a.quantity);
}

/** 日本時間の今日（YYYY-MM-DD）。サーバーの TZ に左右されないよう明示する。 */
function tokyoToday() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
}

/**
 * 出庫のダイアログで選べるようにする名前の候補。
 *
 * - scheduledToday: ジョブカンの勤務予定で、今日この拠点に入っている人
 * - recent: 最近（90 日）出庫で使われた名前。新しく使われた順
 * - all: これまでに使われた名前すべて（出庫記録の絞り込み用）
 *
 * 毎回打つより選ぶ方が速く、同じ人の名前の書き方もそろう。
 */
async function listTakerCandidates(db, mainDb, locationId) {
    const recent = await db.all(`
        SELECT taken_by AS name, MAX(created_at) AS last_used
        FROM inventory_history
        WHERE type = 'out' AND taken_by IS NOT NULL
        AND created_at >= datetime('now', '-90 days')
        GROUP BY taken_by
        ORDER BY last_used DESC
        LIMIT 30
    `);

    const all = await db.all(`
        SELECT DISTINCT taken_by AS name
        FROM inventory_history
        WHERE type = 'out' AND taken_by IS NOT NULL
        ORDER BY taken_by
    `);

    let scheduledToday = [];
    if (locationId) {
        scheduledToday = await mainDb.all(`
            SELECT st.name
            FROM staff_schedules s
            JOIN staff st ON s.staff_id = st.id
            WHERE s.location_id = ? AND s.date = ? AND st.is_active = 1
            GROUP BY st.name
            ORDER BY MIN(s.start_time), st.name
        `, [locationId, tokyoToday()]);
    }

    return {
        scheduledToday: scheduledToday.map(row => row.name),
        recent: recent.map(row => row.name),
        all: all.map(row => row.name)
    };
}

module.exports = {
    TAKER_MAX_LENGTH,
    QUICK_OPERATION_NOTE,
    QUICK_RESTOCK_RATIO,
    parseTakerName,
    detectQuickRestocks,
    findQuickRestocks,
    summarizeByTaker,
    listTakerCandidates
};
