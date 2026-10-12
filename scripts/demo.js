/**
 * 手元で画面を確かめるためのデモ。
 *
 * 1 コマンドで、デモ用のデータベースを作ってサーバーを起動する。
 * 出庫記録（誰が何個出したか）と「補充が早すぎる商品」がすぐ見られるよう、
 * 商品と、ここ 2 か月ほどの入出庫の記録を入れておく。
 *
 * 使い方:
 *   npm run demo               # demo-db/ に作って http://localhost:3000 で起動
 *   npm run demo -- --reset    # demo-db/ を消して、今日の日付で作り直す
 *
 * 本物のデータには触らない。データベースは常にリポジトリ直下の demo-db/ に作る
 * （環境変数や .env の DB_DIR は使わない）。LINE などの通知も送らない。
 */

const fs = require('fs');
const path = require('path');

if (process.env.NODE_ENV === 'production') {
    console.error('本番（NODE_ENV=production）ではデモを動かしません');
    process.exit(1);
}

const DEMO_DIR = path.join(__dirname, '..', 'demo-db');

if (process.argv.includes('--reset')) {
    fs.rmSync(DEMO_DIR, { recursive: true, force: true });
}

// .env を読む前に決めておく。dotenv はすでにある値を上書きしないので、
// .env に本番の DB_DIR や通知の設定が書いてあっても、こちらが勝つ
process.env.DB_DIR = DEMO_DIR;
process.env.NOTIFICATIONS_ENABLED = 'false';
process.env.SHIFT_MONITOR = 'off';
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { mainDb, getLocationDatabase } = require('../server/db/database-admin');
const { withTransaction, applyStockChange } = require('../server/utils/stock');
const { findQuickRestocks } = require('../server/services/takeouts');

const ADMIN = { username: 'admin', password: 'demo-admin' };
const STORE = {
    locationCode: '1',
    locationName: 'デモ店',
    userId: 'demo',
    userName: '店の端末',
    password: 'demo-store'
};

/** 今日から days 日前の日付（端末の日付、YYYY-MM-DD） */
function daysAgo(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

const PRODUCTS = [
    { key: 'paper', name: 'トイレットペーパー', category: '衛生用品', reorderPoint: 5 },
    { key: 'glove', name: 'ニトリルグローブ(Ｍサイズ)', category: '衛生用品', reorderPoint: 5 },
    { key: 'tissue', name: 'ティッシュ', category: '衛生用品', reorderPoint: 3 },
    { key: 'detergent', name: '食器用洗剤', category: '洗剤', reorderPoint: 1 }
];

/**
 * 入出庫の記録。[何日前, 商品, 'in' | 'out', 個数, 出した人]
 *
 * トイレットペーパーは 2 週間おきに 20 個ずつ補充していたのに、最後だけ 5 日で
 * 次の補充になった（田中 花子さんが 12 個出している）。これが「補充が早すぎる商品」に出る。
 * ゴム手袋はいつも通りの 2 週間おきなので出ない。
 */
function buildEvents() {
    const events = [];
    const add = (ago, key, type, quantity, takenBy = null) => events.push({ ago, key, type, quantity, takenBy });

    // トイレットペーパー: いつもの 14 日の区間
    for (const start of [57, 43, 29]) {
        add(start, 'paper', 'in', 20);
        add(start - 2, 'paper', 'out', 4, '田中 花子');
        add(start - 5, 'paper', 'out', 3, '佐藤 健');
        add(start - 7, 'paper', 'out', 5, '鈴木 一郎');
        add(start - 10, 'paper', 'out', 3, '田中 花子');
        add(start - 12, 'paper', 'out', 3, '佐藤 健');
    }
    // 15 日前に補充した 20 個が、5 日で足りなくなった
    add(15, 'paper', 'in', 20);
    add(14, 'paper', 'out', 7, '田中 花子');
    add(12, 'paper', 'out', 5, '田中 花子');
    add(11, 'paper', 'out', 3, '佐藤 健');
    add(10, 'paper', 'in', 20);
    add(8, 'paper', 'out', 2, '鈴木 一郎');
    add(4, 'paper', 'out', 3, '佐藤 健');

    // ゴム手袋: いつも通り 14 日おき
    for (const start of [50, 36, 22, 8]) {
        add(start, 'glove', 'in', 20);
        add(start - 1, 'glove', 'out', 6, '鈴木 一郎');
        add(start - 4, 'glove', 'out', 6, '佐藤 健');
        if (start > 8) {
            add(start - 9, 'glove', 'out', 6, '鈴木 一郎');
        }
    }

    // ティッシュ・洗剤: 補充は 1 回だけ。出した人が無い出庫（この機能より前の記録の例）も入れる
    add(40, 'tissue', 'in', 30);
    add(25, 'tissue', 'out', 4, '田中 花子');
    add(6, 'tissue', 'out', 2);
    add(30, 'detergent', 'in', 6);
    add(9, 'detergent', 'out', 1, '鈴木 一郎');
    add(2, 'detergent', 'out', 1);

    // 古い順に入れる（途中で在庫がマイナスにならないように）
    return events.sort((a, b) => b.ago - a.ago);
}

async function seed() {
    const existing = await mainDb.get('SELECT COUNT(*) AS count FROM users');
    if (existing.count > 0) {
        console.log('demo-db/ はもうできています（作り直すときは npm run demo -- --reset）');
        return;
    }

    console.log('demo-db/ にデモのデータを作ります...');

    await mainDb.run(
        'INSERT INTO users (location_id, user_id, user_name, password, is_admin) VALUES (0, ?, ?, ?, 1)',
        [ADMIN.username, ADMIN.username, bcrypt.hashSync(ADMIN.password, 10)]
    );

    const location = await mainDb.run(
        'INSERT INTO locations (location_code, location_name, db_name) VALUES (?, ?, ?)',
        [STORE.locationCode, STORE.locationName, `location_${STORE.locationCode}.db`]
    );

    const user = await mainDb.run(
        'INSERT INTO users (location_id, user_id, user_name, password, is_admin) VALUES (?, ?, ?, ?, 0)',
        [location.lastID, STORE.userId, STORE.userName, bcrypt.hashSync(STORE.password, 10)]
    );

    // 今日の勤務予定（出庫のダイアログで、名前のボタンの先頭に並ぶ）
    for (const [name, start, end] of [['早番 一郎', '09:00', '14:00'], ['遅番 二郎', '17:00', '22:00']]) {
        const staff = await mainDb.run('INSERT INTO staff (name) VALUES (?)', [name]);
        await mainDb.run(
            `INSERT INTO staff_schedules (staff_id, location_id, date, start_time, end_time, source)
             VALUES (?, ?, ?, ?, ?, 'demo')`,
            [staff.lastID, location.lastID, daysAgo(0), start, end]
        );
    }

    const db = getLocationDatabase(STORE.locationCode);
    const productIds = {};

    for (const product of PRODUCTS) {
        const result = await db.run(
            'INSERT INTO products (name, category, reorder_point, current_stock) VALUES (?, ?, ?, 0)',
            [product.name, product.category, product.reorderPoint]
        );
        productIds[product.key] = result.lastID;
    }

    // 在庫は必ず applyStockChange を通して動かす（履歴と現在庫を一致させるため）
    await withTransaction(db, async () => {
        for (const event of buildEvents()) {
            await applyStockChange(db, {
                productId: productIds[event.key],
                type: event.type,
                quantity: event.quantity,
                date: daysAgo(event.ago),
                note: event.type === 'in' ? '発注依頼による入荷' : '',
                userId: user.lastID,
                takenBy: event.takenBy
            });
        }
    });

    // 登録した時刻をその日の昼（日本時間）にする。全部「今」のままだと、
    // ダッシュボードの区切りの確認に、今日の登録として数えられてしまう
    await db.run(`UPDATE inventory_history SET created_at = date || ' 03:00:00' WHERE date IS NOT NULL`);

    const flagged = await findQuickRestocks(db);
    console.log(`  商品 ${PRODUCTS.length} 件・入出庫 ${buildEvents().length} 件・補充が早すぎる商品 ${flagged.length} 件`);
}

(async () => {
    try {
        await seed();
    } catch (err) {
        console.error('デモのデータを作れませんでした:', err);
        process.exit(1);
    }

    const port = process.env.PORT || 3000;

    console.log(`
========================================
デモを起動します: http://localhost:${port}

店の画面（出庫の登録）
  拠点「${STORE.locationName}」/ ユーザーID ${STORE.userId} / パスワード ${STORE.password}
  在庫カードの「-1」「-5」で、誰が何個出したかを登録

管理画面（出庫記録・人ごとの集計・補充が早すぎる商品）
  「管理者ログイン」のタブで 管理者ID ${ADMIN.username} / パスワード ${ADMIN.password}
  「出庫記録」タブ

同じブラウザだとログインが入れ替わるので、片方はシークレットウィンドウで開くと楽です。
止めるときは Ctrl+C。データは demo-db/ に残ります。
========================================
`);

    require('../server/app');
})();
