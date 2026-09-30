/**
 * 発注依頼のテストスクリプト
 *
 * 1. API: 依頼の作成、重複の拒否、入力の検証、管理画面の発注状況
 * 2. 画面: 「発注依頼」タブの一覧と、在庫カードの「発注依頼済み」の表示
 * 3. CSV: 「発注依頼」タブの一覧の CSV 出力
 *
 * 画面は、CI にブラウザが無いので jsdom で確かめる。実物の index.html と app.js を
 * 読み込み、fetch はログイン済みのテスト用クライアントと同じクッキーで実サーバーへ送る。
 * サーバー側が正しくても、画面の配線（タブ・一覧・表示の条件）が外れると気づけないため。
 *
 * 使い方: node test-orders.js
 * 一時ディレクトリに専用のデータベースを作り、サーバーを別プロセスで起動する。
 */

// 店の端末と同じ日本時間で動かす。依頼日時（UTC）を端末の時刻として読み違える不具合は、
// 日本時間の端末でしか表に出ない（UTC の端末ではたまたま正しく見える）。
process.env.TZ = 'Asia/Tokyo';

const fs = require('fs');
const path = require('path');
const {
    createResults,
    createTempDbDir,
    createClient,
    startServer,
    setupLocationUser,
    openUserScreen,
    waitFor
} = require('./test-helpers');

const PORT = 3995;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = createTempDbDir('inventory-orders-test');
const PASSWORD = 'test-password-1234';

const { results, addResult, printSummary } = createResults();

const client = createClient(BASE_URL);
const { request } = client;
const adminClient = createClient(BASE_URL);

// ---------------------------------------------------------------------------
// 準備
// ---------------------------------------------------------------------------

async function createProduct(name, reorderPoint, currentStock) {
    const res = await request('POST', '/api/products', {
        name,
        category: '発注テスト',
        reorder_point: reorderPoint,
        current_stock: currentStock
    });

    if (res.status !== 200 || !res.body.productId) {
        throw new Error(`商品の登録に失敗しました: ${name} / ${JSON.stringify(res.body)}`);
    }

    return res.body.productId;
}

async function allOrders() {
    return (await request('GET', '/api/orders')).body;
}

/** 未入荷（依頼中・発注済）の依頼 */
async function activeOrdersOf(productId) {
    return (await allOrders()).filter(o =>
        o.product_id === productId && (o.status === 'pending' || o.status === 'ordered')
    );
}

/**
 * 日本時間の今日と、今日の朝 8:30 を requested_at の形（UTC）で表したもの。
 * 日本時間の朝 9 時より前は、UTC ではまだ前日になっている。
 */
function tokyoToday() {
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const [year, month, day] = [jstNow.getUTCFullYear(), jstNow.getUTCMonth() + 1, jstNow.getUTCDate()];
    const morningUtc = new Date(Date.UTC(year, month - 1, day, 8, 30) - 9 * 60 * 60 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19);

    return { year, month, day, morningUtc };
}

/** 依頼日時を書き換える（API では日時を指定できないので、データベースを直接触る） */
function setRequestedAt(locationCode, orderId, requestedAt) {
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(path.join(DB_DIR, `location_${locationCode}.db`));

    return new Promise((resolve, reject) => {
        db.run('UPDATE order_requests SET requested_at = ? WHERE id = ?', [requestedAt, orderId], err => {
            db.close();
            if (err) reject(err);
            else resolve();
        });
    });
}

async function markOrdered(locationId, orderId) {
    return adminClient.request(
        'PUT',
        `/api/auth/admin/locations/${locationId}/orders/${orderId}/status`,
        { status: 'ordered' }
    );
}

// ---------------------------------------------------------------------------
// 1. API
// ---------------------------------------------------------------------------

async function testApi(location) {
    // --- 手で出した依頼が作られる ---
    const productA = await createProduct('API: 手で依頼', 5, 20);
    const created = await request('POST', '/api/orders', {
        productId: productA,
        quantity: 0,
        note: '<b>急ぎ</b>'
    });
    const [orderA] = await activeOrdersOf(productA);

    addResult(
        '依頼の作成: 手で出した依頼が作られる',
        created.status === 200 && orderA && orderA.id === created.body.orderId && orderA.status === 'pending',
        `status ${created.status} / ${orderA ? orderA.status : '依頼なし'}`
    );
    addResult(
        '依頼の作成: 備考のタグは落として保存する',
        orderA && orderA.note === '急ぎ',
        `note = ${orderA && orderA.note}`
    );

    // --- 同じ商品に未入荷の依頼があると作らない ---
    const duplicate = await request('POST', '/api/orders', { productId: productA, quantity: 0 });
    addResult(
        '重複: 依頼中の商品には新しい依頼を作らない',
        duplicate.status === 409 && (await activeOrdersOf(productA)).length === 1,
        `status ${duplicate.status} / ${duplicate.body.error || ''}`
    );

    await markOrdered(location.locationId, orderA.id);
    const afterOrdered = await request('POST', '/api/orders', { productId: productA, quantity: 0 });
    addResult(
        '重複: 発注済の商品にも新しい依頼を作らない',
        afterOrdered.status === 409 && (await activeOrdersOf(productA)).length === 1,
        `status ${afterOrdered.status}`
    );

    // --- 入力の検証 ---
    const countBefore = (await allOrders()).length;
    const invalidInputs = [
        ['商品IDが文字列', { productId: 'abc', quantity: 0 }, 400],
        ['存在しない商品', { productId: 999999, quantity: 0 }, 404],
        ['数量が負数', { productId: productA, quantity: -1 }, 400],
        ['数量が小数', { productId: productA, quantity: 1.5 }, 400],
        ['数量が文字列', { productId: productA, quantity: 'abc' }, 400]
    ];

    for (const [label, body, expected] of invalidInputs) {
        const res = await request('POST', '/api/orders', body);
        addResult(
            `入力検証: ${label}なら拒否する`,
            res.status === expected,
            `status ${res.status}（期待値 ${expected}） / ${res.body.error || ''}`
        );
    }

    addResult(
        '入力検証: 拒否した入力で依頼が増えていない',
        (await allOrders()).length === countBefore,
        `依頼 ${(await allOrders()).length} 件（期待値 ${countBefore}）`
    );

    // --- 届いたあとは、また依頼を出せる ---
    await request('PUT', `/api/orders/${orderA.id}`, { status: 'received' });
    const again = await request('POST', '/api/orders', { productId: productA, quantity: 0 });
    addResult(
        '依頼の作成: 受領済になったあとは新しい依頼を出せる',
        again.status === 200 && (await activeOrdersOf(productA)).length === 1,
        `status ${again.status}`
    );

    // --- 手の依頼があるときは、在庫が減っても自動発注を重ねない ---
    const productB = await createProduct('API: 手の依頼のあとに出庫', 5, 10);
    await request('POST', '/api/orders', { productId: productB, quantity: 0 });
    await request('POST', '/api/inventory/out', { productId: productB, quantity: 7, note: '発注点割れ' });
    addResult(
        '自動発注: 手で出した依頼があれば重ねて作らない',
        (await activeOrdersOf(productB)).length === 1,
        `未入荷の依頼 ${(await activeOrdersOf(productB)).length} 件（期待値 1）`
    );

    // --- 同時に押されても 1 件だけ ---
    const productC = await createProduct('API: 同時に依頼', 5, 10);
    const concurrent = await Promise.all(
        Array.from({ length: 10 }, () =>
            request('POST', '/api/orders', { productId: productC, quantity: 0 })
        )
    );
    const okCount = concurrent.filter(res => res.status === 200).length;
    addResult(
        '重複: 同時に 10 回送っても依頼は 1 件だけ',
        okCount === 1 && (await activeOrdersOf(productC)).length === 1,
        `成功 ${okCount} 件 / 未入荷の依頼 ${(await activeOrdersOf(productC)).length} 件`
    );

    // --- 管理画面の在庫状況: 発注済も「依頼あり」として扱う ---
    const productD = await createProduct('API: 管理画面で発注済', 5, 10);
    await request('POST', '/api/inventory/out', { productId: productD, quantity: 6, note: '発注点割れ' });
    const [orderD] = await activeOrdersOf(productD);
    await markOrdered(location.locationId, orderD.id);

    const inventory = await adminClient.request('GET', '/api/auth/admin/all-inventory');
    const rowOf = id => inventory.body.products.find(p => p.id === id && p.location_id === location.locationId);

    addResult(
        '管理画面: 発注済にした商品が「発注必要」に戻らない',
        rowOf(productD).has_pending_order === true && rowOf(productD).pending_order_status === 'ordered',
        `has_pending_order=${rowOf(productD).has_pending_order} / status=${rowOf(productD).pending_order_status}`
    );
    addResult(
        '管理画面: 依頼中の商品は依頼中として出る',
        rowOf(productB).has_pending_order === true && rowOf(productB).pending_order_status === 'pending',
        `has_pending_order=${rowOf(productB).has_pending_order} / status=${rowOf(productB).pending_order_status}`
    );
}

// ---------------------------------------------------------------------------
// 2. 画面（jsdom）
// ---------------------------------------------------------------------------

/** 表の行を [商品名, 2 列目, ...] の配列で返す */
function tableRows(window, selector) {
    return [...window.document.querySelectorAll(`${selector} tbody tr`)]
        .map(tr => [...tr.cells].map(td => td.textContent.trim().replace(/\s+/g, ' ')));
}

function rowOf(window, selector, productName) {
    return tableRows(window, selector).find(cells => cells[0] === productName);
}

/** その商品の行にあるボタンを押す */
function clickRowButton(window, selector, productName, buttonText) {
    const tr = [...window.document.querySelectorAll(`${selector} tbody tr`)]
        .find(row => row.cells[0].textContent.trim() === productName);
    const button = [...tr.querySelectorAll('button')].find(b => b.textContent.trim() === buttonText);
    button.click();
}

function cardStatuses(window) {
    const statuses = {};
    for (const card of window.document.querySelectorAll('.stock-card')) {
        const name = card.querySelector('.stock-card-name').textContent.trim();
        statuses[name] = card.querySelector('.stock-card-status').textContent.trim();
    }
    return statuses;
}

async function testScreen(location) {
    // 依頼中・依頼なし（最初から発注点以下）・在庫十分・発注済 の 4 つを用意する
    const withOrder = await createProduct('画面: 依頼中', 5, 10);
    await request('POST', '/api/inventory/out', { productId: withOrder, quantity: 6, note: '発注点割れ' });

    const withoutOrder = await createProduct('画面: 依頼なし', 5, 3);
    await createProduct('画面: 在庫十分', 2, 10);

    const ordered = await createProduct('画面: 発注済', 5, 10);
    await request('POST', '/api/inventory/out', { productId: ordered, quantity: 7, note: '発注点割れ' });
    await markOrdered(location.locationId, (await activeOrdersOf(ordered))[0].id);

    // 依頼が受領済になった商品（一覧には出さない）
    const received = await createProduct('画面: 受領済', 5, 10);
    await request('POST', '/api/inventory/out', { productId: received, quantity: 6, note: '発注点割れ' });
    await request('PUT', `/api/orders/${(await activeOrdersOf(received))[0].id}`, { status: 'received' });

    const productCount = (await request('GET', '/api/products')).body.length;
    const { window, errors, dialogs, state } = openUserScreen(client, BASE_URL);

    try {
        // --- ダッシュボードのカード ---
        await waitFor(
            () => window.document.querySelectorAll('.stock-card').length === productCount,
            'ダッシュボードのカードが並ぶ'
        );
        const cards = cardStatuses(window);

        addResult(
            'カード: 依頼が出ている商品は「発注依頼済み」',
            cards['画面: 依頼中'] === '⚠️ 発注依頼済み' && cards['画面: 発注済'] === '⚠️ 発注依頼済み',
            `依頼中「${cards['画面: 依頼中']}」 / 発注済「${cards['画面: 発注済']}」`
        );
        addResult(
            'カード: 発注点以下でも依頼が無ければ「発注依頼済み」と出さない',
            cards['画面: 依頼なし'] === '⚠️ 発注依頼なし',
            `「${cards['画面: 依頼なし']}」`
        );
        addResult(
            'カード: 在庫が発注点より多ければ「在庫十分」',
            cards['画面: 在庫十分'] === '✓ 在庫十分',
            `「${cards['画面: 在庫十分']}」`
        );

        // --- 発注依頼タブ ---
        window.document.querySelector('.nav-btn[data-page="orders"]').click();
        await waitFor(
            () => window.document.getElementById('orders').classList.contains('active') &&
                /件$/.test(window.document.getElementById('orders-active-count').textContent),
            '発注依頼タブが開く'
        );

        const activeCount = (await allOrders()).filter(o => o.status === 'pending' || o.status === 'ordered').length;
        const activeRows = tableRows(window, '#orders-active-table');
        addResult(
            'タブ: 未入荷の依頼がすべて並び、件数が合う',
            activeRows.length === activeCount &&
                window.document.getElementById('orders-active-count').textContent === `${activeCount}件`,
            `行 ${activeRows.length} / 表示「${window.document.getElementById('orders-active-count').textContent}」 / 期待値 ${activeCount}`
        );

        const pendingRow = rowOf(window, '#orders-active-table', '画面: 依頼中');
        const orderedRow = rowOf(window, '#orders-active-table', '画面: 発注済');
        addResult(
            'タブ: 依頼中と発注済を見分けられる',
            pendingRow && pendingRow[1] === '発注依頼中' && orderedRow && orderedRow[1] === '発注済',
            `依頼中「${pendingRow && pendingRow[1]}」 / 発注済「${orderedRow && orderedRow[1]}」`
        );
        addResult(
            'タブ: 受領済の依頼は並ばない',
            !rowOf(window, '#orders-active-table', '画面: 受領済'),
            `一覧: ${activeRows.map(r => r[0]).join(', ')}`
        );
        addResult(
            'タブ: 依頼が無い商品は「発注依頼が出ていない商品」に出る',
            window.document.getElementById('orders-missing-section').style.display !== 'none' &&
                !!rowOf(window, '#orders-missing-table', '画面: 依頼なし') &&
                !rowOf(window, '#orders-missing-table', '画面: 依頼中') &&
                !rowOf(window, '#orders-active-table', '画面: 依頼なし'),
            `依頼が出ていない商品: ${tableRows(window, '#orders-missing-table').map(r => r[0]).join(', ')}`
        );

        // --- 依頼日は日本時間で出す ---
        // 日本時間の今日 8:30 は、UTC では前日の 23:30。端末の時刻として読むと前日になる
        const { year, month, day, morningUtc: morning } = tokyoToday();

        addResult(
            '依頼日: 日本時間の朝の依頼が前日の日付にならない',
            window.formatOrderDate(morning) === `${month}/${day}`,
            `${morning}（UTC） → ${window.formatOrderDate(morning)}（期待値 ${month}/${day}）`
        );
        addResult(
            '依頼日: 去年の依頼には年を付ける',
            window.formatOrderDate(`${year - 1}-12-03 02:00:00`) === `${year - 1}/12/3`,
            `→ ${window.formatOrderDate(`${year - 1}-12-03 02:00:00`)}`
        );

        // --- キャンセル: 行が「依頼が出ていない商品」へ移り、タブは開いたまま ---
        clickRowButton(window, '#orders-active-table', '画面: 依頼中', 'キャンセル');
        await waitFor(
            () => !rowOf(window, '#orders-active-table', '画面: 依頼中') &&
                !!rowOf(window, '#orders-missing-table', '画面: 依頼中'),
            'キャンセルした依頼が一覧から外れる'
        );
        addResult(
            '操作: キャンセルすると「依頼が出ていない商品」へ移る',
            (await activeOrdersOf(withOrder)).length === 0 &&
                window.document.getElementById('orders').classList.contains('active'),
            `未入荷の依頼 ${(await activeOrdersOf(withOrder)).length} 件 / 開いているページ ${window.document.querySelector('.page.active').id}`
        );

        // --- 依頼が出ていない商品から依頼を出す ---
        clickRowButton(window, '#orders-missing-table', '画面: 依頼なし', '発注依頼する');
        await waitFor(() => !!window.document.getElementById('order-request-form'), '発注依頼の画面が開く');
        window.document.getElementById('order-note').value = '画面から依頼';
        window.document.querySelector('#order-request-form button[type="submit"]').click();
        await waitFor(
            () => !!rowOf(window, '#orders-active-table', '画面: 依頼なし'),
            '出した依頼が一覧に入る'
        );
        const requestedRow = rowOf(window, '#orders-active-table', '画面: 依頼なし');
        addResult(
            '操作: 「発注依頼する」で依頼が一覧に入る',
            (await activeOrdersOf(withoutOrder)).length === 1 &&
                requestedRow[1] === '発注依頼中' && requestedRow.includes('画面から依頼') &&
                !rowOf(window, '#orders-missing-table', '画面: 依頼なし'),
            `行: ${requestedRow.slice(0, 7).join(' | ')}`
        );

        // --- 入荷完了: 在庫が増え、依頼は受領済になる ---
        state.promptAnswer = '6';
        clickRowButton(window, '#orders-active-table', '画面: 発注済', '入荷完了');
        await waitFor(
            () => !rowOf(window, '#orders-active-table', '画面: 発注済'),
            '入荷完了した依頼が一覧から外れる'
        );
        const receivedProduct = (await request('GET', '/api/products')).body.find(p => p.id === ordered);
        const receivedOrder = (await allOrders()).find(o => o.product_id === ordered);
        addResult(
            '操作: 入荷完了で在庫が増え、依頼が受領済になる',
            receivedProduct.current_stock === 9 && receivedOrder.status === 'received',
            `現在庫 ${receivedProduct.current_stock}（期待値 9） / ${receivedOrder.status}`
        );

        // --- 0 件でも欄は消さず、「ありません」と出す ---
        for (const order of await allOrders()) {
            if (order.status === 'pending' || order.status === 'ordered') {
                await request('PUT', `/api/orders/${order.id}`, { status: 'cancelled' });
            }
        }
        window.document.querySelector('.nav-btn[data-page="orders"]').click();
        await waitFor(
            () => window.document.getElementById('orders-active-count').textContent === '0件',
            '0 件の表示になる'
        );
        addResult(
            'タブ: 依頼が 0 件なら「ありません」と出す',
            window.document.getElementById('orders-active-empty').style.display === 'block' &&
                window.document.getElementById('orders-active-table').style.display === 'none',
            `件数「${window.document.getElementById('orders-active-count').textContent}」`
        );

        addResult(
            '画面: 操作中にエラーが出ていない',
            errors.length === 0,
            errors.length === 0 ? 'エラーなし' : errors.join(' / ')
        );
        console.log(`   （出たダイアログ: ${dialogs.length} 件）`);
    } finally {
        window.close();
    }
}

// ---------------------------------------------------------------------------
// 3. CSV 出力
// ---------------------------------------------------------------------------

/**
 * CSV を取ってくる。ヘッダーも見たいので request() ではなく fetch を直接使う。
 * res.text() は先頭の BOM を黙って取り除くので、バイト列のまま受け取って確かめる。
 */
async function fetchCsv(cookie) {
    const res = await fetch(`${BASE_URL}/api/orders/export`, { headers: cookie ? { Cookie: cookie } : {} });
    const bytes = Buffer.from(await res.arrayBuffer());

    return {
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        disposition: res.headers.get('content-disposition') || '',
        hasBom: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
        text: bytes.toString('utf8').replace(/^﻿/, '')
    };
}

async function testCsv(location) {
    // 画面のテストの最後で未入荷の依頼はすべて片付けてある。ここで作り直す
    const escaped = await createProduct('CSV: P&G ジョイ 1/2', 5, 10);
    await request('POST', '/api/inventory/out', { productId: escaped, quantity: 6, note: '発注点割れ' });

    const ordered = await createProduct('CSV: 発注済', 5, 10);
    await request('POST', '/api/inventory/out', { productId: ordered, quantity: 7, note: '発注点割れ' });
    await markOrdered(location.locationId, (await activeOrdersOf(ordered))[0].id);

    const manual = await createProduct('CSV: 手で依頼', 5, 20);
    const manualOrder = await request('POST', '/api/orders', { productId: manual, quantity: 0, note: 'A社, "至急"/2箱' });
    // 日本時間の朝に出した依頼にする（UTC では前日）。CSV でも日本時間の日付で出るか見る
    const { year, month, day, morningUtc } = tokyoToday();
    await setRequestedAt(location.locationCode, manualOrder.body.orderId, morningUtc);

    const received = await createProduct('CSV: 受領済', 5, 10);
    await request('POST', '/api/inventory/out', { productId: received, quantity: 6, note: '発注点割れ' });
    await request('PUT', `/api/orders/${(await activeOrdersOf(received))[0].id}`, { status: 'received' });

    const csv = await fetchCsv(client.state.cookie);
    const lines = csv.text.split('\n');
    const lineOf = name => lines.find(line => line.startsWith(`${name},`));

    addResult(
        'CSV: CSV として返す（Excel で文字化けしないよう BOM 付き）',
        csv.status === 200 && csv.contentType.startsWith('text/csv') && csv.hasBom,
        `status ${csv.status} / ${csv.contentType} / BOM ${csv.hasBom ? 'あり' : 'なし'}`
    );
    addResult(
        'CSV: 見出しが画面の一覧と同じ',
        lines[0] === '商品名,状況,依頼日,現在庫,発注点,依頼者,備考',
        lines[0]
    );

    const activeCount = (await allOrders()).filter(o => o.status === 'pending' || o.status === 'ordered').length;
    addResult(
        'CSV: 未入荷の依頼だけが並ぶ（受領済・キャンセルは出さない）',
        lines.length - 1 === activeCount && activeCount === 3 && !lineOf('CSV: 受領済') && !lineOf('画面: 依頼中'),
        `行 ${lines.length - 1}（期待値 ${activeCount}）`
    );

    // 依頼はどれも日本時間の今日（手の依頼は今日の朝、ほかは今）
    const today = `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
    addResult(
        'CSV: 状況と依頼日（日本時間）が入る',
        lineOf('CSV: 発注済') === `CSV: 発注済,発注済,${today},3,5,テスト担当,在庫が発注点を下回ったため自動発注`,
        lineOf('CSV: 発注済')
    );
    addResult(
        'CSV: 保存時のエスケープを戻す（& や / が &amp; &#x2F; のまま出ない）',
        !!lineOf('CSV: P&G ジョイ 1/2') && !/&amp;|&#x2F;|&quot;/.test(csv.text),
        lineOf('CSV: P&G ジョイ 1/2')
    );
    addResult(
        'CSV: 「,」や「"」を含む備考で列がずれない（日本時間の朝の依頼も今日の日付）',
        lineOf('CSV: 手で依頼') === `CSV: 手で依頼,発注依頼中,${today},20,5,テスト担当,"A社, ""至急""/2箱"`,
        lineOf('CSV: 手で依頼')
    );

    const expectedName = encodeURIComponent(`発注依頼_${today.replace(/\//g, '')}.csv`);
    addResult(
        'CSV: ファイル名は日本語（発注依頼_日付.csv）',
        csv.disposition.startsWith('attachment;') && csv.disposition.includes(`filename*=UTF-8''${expectedName}`),
        csv.disposition
    );

    const anonymous = await fetchCsv(null);
    addResult(
        'CSV: ログインしていないと出さない',
        anonymous.status === 401,
        `status ${anonymous.status}`
    );
}

// ---------------------------------------------------------------------------

(async () => {
    console.log('========================================');
    console.log('発注依頼テスト開始');
    console.log('========================================\n');

    const { server, waitUntilReady } = startServer({ port: PORT, dbDir: DB_DIR });

    try {
        await waitUntilReady(BASE_URL);
        const location = await setupLocationUser(client, { password: PASSWORD });

        await adminClient.refreshCsrfToken();
        await adminClient.request('POST', '/api/auth/admin/login', { username: 'admin', password: PASSWORD });
        await adminClient.refreshCsrfToken();

        await testApi(location);
        await testScreen(location);
        await testCsv(location);
    } catch (err) {
        results.failed++;
        console.error('\n❌ テストの実行中にエラーが発生しました:', err.message);
    } finally {
        server.kill();
        fs.rmSync(DB_DIR, { recursive: true, force: true });
    }

    printSummary();
    process.exit(results.failed > 0 ? 1 : 0);
})();
