/**
 * 在庫計算テストスクリプト
 *
 * 在庫は products.current_stock と inventory_history の 2 か所に書かれる。
 * この 2 つが食い違わないこと、そして不正な入力で在庫が壊れないことを確認する。
 *
 * 使い方: node test-stock.js
 * 一時ディレクトリに専用のデータベースを作り、サーバーを別プロセスで起動して
 * 実際の HTTP API を叩く。既存のデータには一切触れない。
 */

const fs = require('fs');
const {
    createResults,
    createTempDbDir,
    createClient,
    startServer,
    setupLocationUser
} = require('./test-helpers');

const PORT = 3987;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = createTempDbDir('inventory-test');
const MIGRATION_DIR = createTempDbDir('inventory-migration');

const { results, addResult, printSummary } = createResults();

const client = createClient(BASE_URL);
const { request, refreshCsrfToken } = client;

// ---------------------------------------------------------------------------
// マイグレーション（稼働中のデータベースへの列追加）
// ---------------------------------------------------------------------------

/**
 * 運用中のデータベースには CREATE TABLE IF NOT EXISTS で列が増えない。
 * 古い形のテーブルを用意して、起動時に列が追加されることを確かめる。
 */
async function testMigration() {
    const sqlite3 = require('sqlite3');

    // 列が足りない状態の拠点データベースを作る
    const oldDbPath = require('path').join(MIGRATION_DIR, 'location_9.db');
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(oldDbPath);
        db.run(`CREATE TABLE products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT,
            reorder_point INTEGER DEFAULT 0,
            current_stock INTEGER DEFAULT 0,
            image_url TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) return reject(err);
            db.run(
                "INSERT INTO products (name, category, current_stock) VALUES ('既存商品', '既存', 7)",
                (insertErr) => {
                    db.close();
                    if (insertErr) return reject(insertErr);
                    resolve();
                }
            );
        });
    });

    process.env.DB_DIR = MIGRATION_DIR;
    const admin = require('./server/db/database-admin');
    await admin.mainDb.ready;
    const db = admin.getLocationDatabase('9');
    await db.ready;

    const columns = await db.all('PRAGMA table_info(products)');
    const names = columns.map(c => c.name);

    addResult(
        'マイグレーション: 既存DBに include_in_count が追加される',
        names.includes('include_in_count'),
        `列: ${names.join(', ')}`
    );
    addResult(
        'マイグレーション: 既存DBに unit_price が追加される',
        names.includes('unit_price'),
        `列: ${names.join(', ')}`
    );

    const existing = await db.get('SELECT * FROM products WHERE name = ?', ['既存商品']);
    addResult(
        'マイグレーション: 既存データが壊れない',
        existing && existing.current_stock === 7 && existing.include_in_count === 1,
        `現在庫 ${existing && existing.current_stock} / 棚卸対象 ${existing && existing.include_in_count}`
    );

    // 接続は閉じない。require 時に走る初期化がまだ流れている途中で閉じると
    // SQLITE_MISUSE になる。プロセス終了時にまとめて解放される。
    return admin;
}

// ---------------------------------------------------------------------------
// 現在庫と履歴のズレを埋める（過去データの手当て）
// ---------------------------------------------------------------------------

/**
 * 在庫の更新と履歴の追記が別々だった頃のデータを再現して、
 * 調整スクリプトがズレを埋められるか確かめる。
 *
 * testMigration() のあとに呼ぶこと（DB_DIR の設定を引き継ぐ）。
 */
async function testReconcile(admin) {
    const { findDiscrepancies, reconcileLocation, RECONCILE_NOTE } =
        require('./server/services/stock-reconcile');

    const db = admin.getLocationDatabase('8');
    await db.ready;

    // 1) 履歴のない商品（昔は商品登録時の初期在庫が履歴に残らなかった）
    const noHistory = await db.run(
        "INSERT INTO products (name, category, current_stock) VALUES ('履歴なし商品', '旧データ', 50)"
    );

    // 2) 履歴が一部しかない商品（在庫だけ書き換えられた分がある）
    const partial = await db.run(
        "INSERT INTO products (name, category, current_stock) VALUES ('履歴不足商品', '旧データ', 10)"
    );
    await db.run(
        `INSERT INTO inventory_history (product_id, type, quantity, date, note, user_id)
         VALUES (?, 'out', 5, '2026-01-10', '旧データ', 1)`,
        [partial.lastID]
    );

    // 3) すでに辻褄が合っている商品（触ってはいけない）
    const consistent = await db.run(
        "INSERT INTO products (name, category, current_stock) VALUES ('整合済み商品', '旧データ', 7)"
    );
    await db.run(
        `INSERT INTO inventory_history (product_id, type, quantity, date, note, user_id)
         VALUES (?, 'adjust', 7, '2026-01-10', '初期在庫', 1)`,
        [consistent.lastID]
    );

    const found = await findDiscrepancies(db);
    const foundIds = found.map(f => f.productId);

    addResult(
        '整合調整: ズレのある商品だけを見つける',
        found.length === 2 &&
            foundIds.includes(noHistory.lastID) &&
            foundIds.includes(partial.lastID) &&
            !foundIds.includes(consistent.lastID),
        `検出 ${found.length} 件（${found.map(f => `${f.productName}:${f.diff}`).join(', ')}）`
    );

    const partialItem = found.find(f => f.productId === partial.lastID);
    addResult(
        '整合調整: 調整履歴を過去の日付に置く',
        partialItem && partialItem.adjustDate === '2026-01-10',
        `調整日 ${partialItem && partialItem.adjustDate}（最初の履歴と同じ日）`
    );

    // 確認だけのモードでは書き換えない
    const dryRun = await reconcileLocation(db, { apply: false });
    const afterDryRun = await findDiscrepancies(db);
    addResult(
        '整合調整: --apply なしでは書き換えない',
        dryRun.applied === 0 && afterDryRun.length === 2,
        `適用 ${dryRun.applied} 件 / 残るズレ ${afterDryRun.length} 件`
    );

    // 実行する
    const applied = await reconcileLocation(db, { apply: true });
    addResult(
        '整合調整: ズレの件数ぶん調整履歴を追加する',
        applied.applied === 2,
        `追加 ${applied.applied} 件`
    );

    // 現在庫は動かさない
    const afterStock = await db.all(
        'SELECT id, current_stock FROM products WHERE id IN (?, ?, ?)',
        [noHistory.lastID, partial.lastID, consistent.lastID]
    );
    const stockById = {};
    for (const row of afterStock) {
        stockById[row.id] = row.current_stock;
    }
    addResult(
        '整合調整: 現在庫は動かさない',
        stockById[noHistory.lastID] === 50 &&
            stockById[partial.lastID] === 10 &&
            stockById[consistent.lastID] === 7,
        `50→${stockById[noHistory.lastID]} / 10→${stockById[partial.lastID]} / 7→${stockById[consistent.lastID]}`
    );

    // 「現在庫 = 履歴の合計」が成り立つようになる
    const remaining = await findDiscrepancies(db);
    addResult(
        '整合調整: 実行後は現在庫と履歴が一致する',
        remaining.length === 0,
        `残るズレ ${remaining.length} 件`
    );

    // 二度実行しても増えない
    const secondRun = await reconcileLocation(db, { apply: true });
    const notes = await db.all(
        'SELECT COUNT(*) as count FROM inventory_history WHERE note = ?',
        [RECONCILE_NOTE]
    );
    addResult(
        '整合調整: 二度実行しても重ねて記録しない',
        secondRun.applied === 0 && notes[0].count === 2,
        `2 回目の適用 ${secondRun.applied} 件 / 調整履歴の総数 ${notes[0].count} 件`
    );
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

/** 商品の現在庫と、履歴を足し上げた在庫が一致するか確かめる */
async function assertStockMatchesHistory(productId, productName, label) {
    const products = await request('GET', '/api/products');
    const product = products.body.find(p => p.id === productId);

    const history = await request('GET', `/api/inventory/history?productId=${productId}&limit=1000`);
    const total = history.body.reduce((sum, h) => {
        const quantity = Number(h.quantity) || 0;
        return sum + (h.type === 'out' ? -quantity : quantity);
    }, 0);

    addResult(
        label,
        product.current_stock === total,
        `現在庫 ${product.current_stock} / 履歴の合計 ${total}（${productName}）`
    );
}

async function run() {
    // --- 準備: 管理者 → 拠点 → 一般ユーザー → ログイン ---
    const location = await setupLocationUser(client);

    // --- 商品を用意 ---
    const created = await request('POST', '/api/products', {
        name: 'テスト用トイレットペーパー',
        category: '衛生用品',
        reorder_point: 10,
        current_stock: 100,
        unit_price: 88.5,
        include_in_count: 1
    });
    if (created.status !== 200 || !created.body.productId) {
        throw new Error(`商品の登録に失敗しました: status ${created.status} / ${JSON.stringify(created.body)}`);
    }
    const productId = created.body.productId;

    // --- 1. 単価と棚卸対象フラグが保存されるか ---
    const afterCreate = await request('GET', '/api/products');
    const createdProduct = afterCreate.body.find(p => p.id === productId);
    addResult(
        '商品登録: 単価が保存される',
        Number(createdProduct.unit_price) === 88.5,
        `unit_price = ${createdProduct.unit_price}（期待値 88.5）`
    );
    addResult(
        '商品登録: 棚卸対象フラグが保存される',
        Number(createdProduct.include_in_count) === 1,
        `include_in_count = ${createdProduct.include_in_count}`
    );

    // --- 2. 不正な数量を弾く ---
    const invalidQuantities = [
        ['文字列', 'abc'],
        ['負数', -5],
        ['小数', 1.5],
        ['ゼロ', 0],
        ['null', null],
        ['巨大な数', 99999999]
    ];

    for (const [label, quantity] of invalidQuantities) {
        const res = await request('POST', '/api/inventory/out', { productId, quantity, note: 'テスト' });
        addResult(
            `入力検証: 数量に ${label} を渡すと拒否される`,
            res.status === 400,
            `status ${res.status} / ${res.body.error || ''}`
        );
    }

    const afterInvalid = await request('GET', '/api/products');
    const untouched = afterInvalid.body.find(p => p.id === productId);
    addResult(
        '入力検証: 拒否された入力で在庫が動いていない',
        untouched.current_stock === 100,
        `現在庫 ${untouched.current_stock}（期待値 100）`
    );

    // --- 3. 出庫・入庫が履歴と一致する ---
    await request('POST', '/api/inventory/out', { productId, quantity: 30, date: '2026-08-01', note: '出庫テスト' });
    await request('POST', '/api/inventory/in', { productId, quantity: 5, date: '2026-08-02', note: '入庫テスト' });
    await assertStockMatchesHistory(productId, 'テスト用トイレットペーパー', '整合性: 入出庫の後で現在庫と履歴が一致する');

    // --- 4. 在庫を超える出庫を拒否する ---
    const tooMuch = await request('POST', '/api/inventory/out', { productId, quantity: 1000, note: '在庫超過' });
    addResult(
        '在庫ガード: 在庫を超える出庫を拒否する',
        tooMuch.status === 400 && String(tooMuch.body.error).includes('在庫が不足'),
        `status ${tooMuch.status} / ${tooMuch.body.error || ''}`
    );
    await assertStockMatchesHistory(productId, 'テスト用トイレットペーパー', '在庫ガード: 拒否後も現在庫と履歴が一致する');

    // --- 5. 同時に大量の出庫を投げても数が合う ---
    const concurrentProduct = await request('POST', '/api/products', {
        name: '同時実行テスト商品',
        category: 'テスト',
        reorder_point: 0,
        current_stock: 200
    });
    const concurrentId = concurrentProduct.body.productId;

    await Promise.all(
        Array.from({ length: 40 }, () =>
            request('POST', '/api/inventory/out', { productId: concurrentId, quantity: 1, note: '同時実行' })
        )
    );

    const afterConcurrent = await request('GET', '/api/products');
    const concurrentAfter = afterConcurrent.body.find(p => p.id === concurrentId);
    addResult(
        '同時実行: 40 件の同時出庫が 1 件も欠けない',
        concurrentAfter.current_stock === 160,
        `現在庫 ${concurrentAfter.current_stock}（期待値 160）`
    );
    await assertStockMatchesHistory(concurrentId, '同時実行テスト商品', '同時実行: 現在庫と履歴が一致する');

    // --- 6. 商品編集で在庫を書き換えても履歴に残る ---
    const beforeEdit = await request('GET', `/api/inventory/history?productId=${concurrentId}&limit=1000`);
    await request('POST', '/api/products/initialize', { productId: concurrentId, initialStock: 50 });
    const afterEdit = await request('GET', `/api/inventory/history?productId=${concurrentId}&limit=1000`);
    addResult(
        '履歴: 初期在庫設定が履歴に残る',
        afterEdit.body.length === beforeEdit.body.length + 1,
        `履歴件数 ${beforeEdit.body.length} → ${afterEdit.body.length}`
    );
    await assertStockMatchesHistory(concurrentId, '同時実行テスト商品', '履歴: 初期在庫設定の後も現在庫と履歴が一致する');

    // --- 7. 調整履歴は履歴修正から触らせない ---
    const adjustRow = afterEdit.body.find(h => h.type === 'adjust');
    const editAdjust = await request('PUT', `/api/inventory/history/${adjustRow.id}`, { quantity: 5, note: '書き換え' });
    addResult(
        '履歴修正: 調整履歴の修正を拒否する',
        editAdjust.status === 400,
        `status ${editAdjust.status} / ${editAdjust.body.error || ''}`
    );

    // --- 8. 出庫履歴の修正が在庫に正しく反映される ---
    const outRow = afterEdit.body.find(h => h.type === 'out');
    await request('PUT', `/api/inventory/history/${outRow.id}`, { quantity: 3, note: '数量を修正' });
    await assertStockMatchesHistory(concurrentId, '同時実行テスト商品', '履歴修正: 修正後も現在庫と履歴が一致する');

    // --- 9. 自動発注が重複しない ---
    const orderProduct = await request('POST', '/api/products', {
        name: '発注テスト商品',
        category: 'テスト',
        reorder_point: 10,
        current_stock: 12
    });
    const orderProductId = orderProduct.body.productId;

    await request('POST', '/api/inventory/out', { productId: orderProductId, quantity: 5, note: '発注点割れ' });
    await request('POST', '/api/inventory/out', { productId: orderProductId, quantity: 1, note: 'さらに減らす' });

    const orders = await request('GET', '/api/orders');
    const autoOrders = orders.body.filter(
        o => o.product_id === orderProductId && o.status === 'pending'
    );
    addResult(
        '自動発注: 発注点を下回っても依頼は 1 件だけ',
        autoOrders.length === 1,
        `発注依頼 ${autoOrders.length} 件（期待値 1）`
    );

    // --- 10. 棚卸で期間中の入出庫が消えない ---
    const countCreate = await request('POST', '/api/inventory-count/create', { count_date: '2026-08-10' });
    addResult(
        '棚卸: 棚卸を開始できる',
        countCreate.status === 200,
        `status ${countCreate.status} / ${countCreate.body.error || countCreate.body.message || ''}`
    );

    if (countCreate.status === 200) {
        const countId = countCreate.body.count_id;
        const detail = await request('GET', `/api/inventory-count/${countId}`);

        // 全商品の実在庫を「システム上の数 + 1」として入力する
        for (const item of detail.body.items) {
            await request('POST', `/api/inventory-count/${countId}/items/${item.id}/count`, {
                actual_quantity: item.system_quantity + 1,
                note: 'テスト'
            });
        }

        // 棚卸してから承認するまでのあいだに 1 個出庫する
        const countedItem = detail.body.items.find(i => i.product_id === concurrentId);
        const stockBeforeOut = (await request('GET', '/api/products')).body
            .find(p => p.id === concurrentId).current_stock;
        await request('POST', '/api/inventory/out', { productId: concurrentId, quantity: 1, note: '棚卸中の出庫' });

        await request('POST', `/api/inventory-count/${countId}/complete`);
        const approve = await request('POST', `/api/inventory-count/${countId}/approve`);

        const afterApprove = (await request('GET', '/api/products')).body
            .find(p => p.id === concurrentId).current_stock;

        // 棚卸の差異 +1、途中の出庫 -1 の両方が反映されているはず
        addResult(
            '棚卸: 承認までのあいだの出庫が消えない',
            afterApprove === stockBeforeOut + 1 - 1,
            `承認後の在庫 ${afterApprove}（棚卸前 ${stockBeforeOut} + 差異 1 - 出庫 1 = ${stockBeforeOut}）`
                + ` / status ${approve.status}`
        );
        await assertStockMatchesHistory(concurrentId, '同時実行テスト商品', '棚卸: 承認後も現在庫と履歴が一致する');
        addResult(
            '棚卸: 明細に含まれる商品がある',
            countedItem !== undefined,
            `棚卸対象 ${detail.body.items.length} 件`
        );
    }

    // --- 11. 商品が 0 件でも CSV 出力が落ちない ---
    const emptyExport = await fetch(`${BASE_URL}/api/inventory/export?type=history`, {
        headers: { Cookie: client.state.cookie }
    });
    addResult(
        'CSV: 履歴のエクスポートが成功する',
        emptyExport.status === 200,
        `status ${emptyExport.status}`
    );

    // --- 12. 在庫推移グラフが調整も含めて計算される ---
    const chart = await request('GET', `/api/inventory/chart?productId=${concurrentId}&days=30`);
    const currentStock = (await request('GET', '/api/products')).body
        .find(p => p.id === concurrentId).current_stock;
    addResult(
        'グラフ: 最終日の在庫が現在庫と一致する',
        chart.body.stocks[chart.body.stocks.length - 1] === currentStock,
        `グラフ最終日 ${chart.body.stocks[chart.body.stocks.length - 1]} / 現在庫 ${currentStock}`
    );

    // --- 13. 管理画面のグラフも同じ値になる ---
    await request('POST', '/api/auth/logout');
    client.resetSession();
    await refreshCsrfToken();
    await request('POST', '/api/auth/admin/login', { username: 'admin', password: 'test-password-1234' });
    await refreshCsrfToken();

    const adminChart = await request(
        'GET',
        `/api/auth/admin/locations/${location.locationId}/chart/${concurrentId}?days=30`
    );

    addResult(
        'グラフ: 管理画面のグラフが利用者画面と一致する',
        adminChart.status === 200 &&
            JSON.stringify(adminChart.body.stocks) === JSON.stringify(chart.body.stocks),
        `status ${adminChart.status} / 最終日 ${adminChart.body.stocks && adminChart.body.stocks[adminChart.body.stocks.length - 1]}`
    );
}

// ---------------------------------------------------------------------------

(async () => {
    console.log('========================================');
    console.log('在庫計算テスト開始');
    console.log('========================================\n');

    const { server, waitUntilReady } = startServer({ port: PORT, dbDir: DB_DIR });

    try {
        const admin = await testMigration();
        await testReconcile(admin);
        await waitUntilReady(BASE_URL);
        await run();
    } catch (err) {
        results.failed++;
        console.error('\n❌ テストの実行中にエラーが発生しました:', err.message);
    } finally {
        server.kill();
        fs.rmSync(DB_DIR, { recursive: true, force: true });
        fs.rmSync(MIGRATION_DIR, { recursive: true, force: true });
    }

    printSummary();
    process.exit(results.failed > 0 ? 1 : 0);
})();
