/**
 * 入出庫履歴の絞り込みと CSV 出力のテストスクリプト
 *
 * 履歴確認の画面で選んだ条件（カテゴリ・商品・期間）が、一覧にも CSV にも
 * 同じように効くことを確かめる。
 *
 * 1. API: 一覧の絞り込み（商品・カテゴリ・期間）
 * 2. CSV: 条件どおりの行を全件（画面の 50 件の上限なし）、日時・記号・ファイル名
 * 3. 画面: 選んだ条件がそのまま一覧と CSV に渡る（jsdom で実物の画面を動かす）
 *
 * 使い方: node test-history.js
 * 一時ディレクトリに専用のデータベースを作り、サーバーを別プロセスで起動する。
 */

// 店の端末と同じ日本時間で動かす（CSV の時刻を日本時間で出しているかを見るため）
process.env.TZ = 'Asia/Tokyo';

const fs = require('fs');
const {
    createResults,
    createTempDbDir,
    createClient,
    startServer,
    setupLocationUser,
    openUserScreen,
    waitFor
} = require('./test-helpers');

const PORT = 3996;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = createTempDbDir('inventory-history-test');

const { results, addResult, printSummary } = createResults();

const client = createClient(BASE_URL);
const { request } = client;

// 取引日はすべて過去（2025 年）にする。商品登録のときの初期在庫の履歴は
// 「今日」の日付で入るので、期間をずらしておけばテストを流す日に左右されない。
const products = {};

async function createProduct(key, name, category, stock) {
    const res = await request('POST', '/api/products', {
        name,
        category,
        reorder_point: 0,
        current_stock: stock
    });

    if (res.status !== 200 || !res.body.productId) {
        throw new Error(`商品の登録に失敗しました: ${name} / ${JSON.stringify(res.body)}`);
    }

    products[key] = res.body.productId;
}

async function out(key, date, note = '') {
    const res = await request('POST', '/api/inventory/out', { productId: products[key], quantity: 1, date, note });
    if (res.status !== 200) {
        throw new Error(`出庫に失敗しました: ${key} ${date} / ${JSON.stringify(res.body)}`);
    }
}

async function prepare() {
    await createProduct('glove', 'ニトリルグローブ(Ｍサイズ)', '衛生用品', 200);
    await createProduct('joy', 'P&G ジョイ 1/2', '洗剤', 100);
    await createProduct('paper', 'トイレットペーパー', '衛生用品', 100);
    await createProduct('special', '記号カテゴリの商品', 'A&B/テスト', 10);

    for (const date of ['2025-08-01', '2025-08-15', '2025-09-01', '2025-09-30']) {
        await out('glove', date);
    }
    await request('POST', '/api/inventory/in', {
        productId: products.glove, quantity: 5, date: '2025-09-10', note: '発注依頼による入荷'
    });

    await out('joy', '2025-09-05', 'A社/B社, "急ぎ"');
    await out('special', '2025-09-02');

    // 画面の一覧（50 件まで）より多い件数にする
    for (let i = 0; i < 60; i++) {
        await out('paper', '2025-09-20');
    }
}

/** 一覧 API（上限 1000 件）で、条件に合う履歴を取る */
async function listHistory(query) {
    const res = await request('GET', `/api/inventory/history?${new URLSearchParams({ ...query, limit: '1000' })}`);
    return res;
}

/** CSV を取ってくる。ヘッダーも見たいので fetch を直接使う */
async function fetchCsv(pathAndQuery) {
    const res = await fetch(`${BASE_URL}${pathAndQuery}`, { headers: { Cookie: client.state.cookie } });
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8').replace(/^﻿/, '');
    const disposition = res.headers.get('content-disposition') || '';
    const encodedName = (disposition.match(/filename\*=UTF-8''([^;]+)/) || [])[1];

    return {
        status: res.status,
        text,
        lines: text.split('\n').slice(1).filter(line => line !== ''),
        fileName: encodedName ? decodeURIComponent(encodedName) : null
    };
}

function csvIds(csv) {
    return csv.lines.map(line => Number(line.split(',')[0])).sort((a, b) => a - b);
}

function sameIds(csv, list) {
    const listIds = list.map(h => h.id).sort((a, b) => a - b);
    return JSON.stringify(csvIds(csv)) === JSON.stringify(listIds);
}

// ---------------------------------------------------------------------------
// 1. API
// ---------------------------------------------------------------------------

async function testList() {
    const byProduct = await listHistory({ productId: products.glove });
    addResult(
        '一覧: 商品で絞ると、その商品だけ',
        byProduct.status === 200 && byProduct.body.length === 6 &&
            byProduct.body.every(h => h.product_id === products.glove),
        `${byProduct.body.length} 件（出庫 4・入庫 1・初期在庫 1）`
    );

    const byCategory = await listHistory({ category: '衛生用品' });
    addResult(
        '一覧: カテゴリで絞ると、そのカテゴリの商品だけ',
        byCategory.status === 200 && byCategory.body.length === 6 + 61 &&
            byCategory.body.every(h => h.category === '衛生用品'),
        `${byCategory.body.length} 件（期待値 67）`
    );

    const bySpecial = await listHistory({ category: 'A&B/テスト' });
    addResult(
        '一覧: 「&」や「/」を含むカテゴリでも絞れる',
        bySpecial.status === 200 && bySpecial.body.length === 2 &&
            bySpecial.body.every(h => h.product_id === products.special),
        `${bySpecial.body.length} 件（期待値 2）`
    );

    const byPeriod = await listHistory({ startDate: '2025-09-01', endDate: '2025-09-10' });
    addResult(
        '一覧: 期間で絞ると、取引日がその期間のものだけ',
        byPeriod.status === 200 && byPeriod.body.length === 4 &&
            byPeriod.body.every(h => h.transaction_date >= '2025-09-01' && h.transaction_date <= '2025-09-10'),
        `${byPeriod.body.map(h => h.transaction_date).sort().join(', ')}`
    );

    const badDate = await request('GET', '/api/inventory/history?startDate=2025-13-01');
    addResult(
        '一覧: 存在しない日付は拒否する',
        badDate.status === 400,
        `status ${badDate.status} / ${badDate.body.error || ''}`
    );
}

// ---------------------------------------------------------------------------
// 2. CSV
// ---------------------------------------------------------------------------

async function testCsv() {
    const all = await fetchCsv('/api/inventory/export?type=history');
    const allList = await listHistory({});
    addResult(
        'CSV: 条件なしなら全件（画面の 50 件で切らない）',
        all.status === 200 && all.lines.length === 71 && sameIds(all, allList.body),
        `${all.lines.length} 行（期待値 71）`
    );

    const productPeriod = { productId: String(products.glove), startDate: '2025-08-01', endDate: '2025-09-30' };
    const byProduct = await fetchCsv(`/api/inventory/export?type=history&${new URLSearchParams(productPeriod)}`);
    const byProductList = await listHistory(productPeriod);
    addResult(
        'CSV: 商品と期間で絞ると、一覧と同じ行だけ',
        byProduct.status === 200 && byProduct.lines.length === 5 && sameIds(byProduct, byProductList.body),
        `${byProduct.lines.length} 行（期待値 5。今日付けの初期在庫は期間外）`
    );

    const categoryPeriod = { category: '衛生用品', startDate: '2025-09-01', endDate: '2025-09-30' };
    const byCategory = await fetchCsv(`/api/inventory/export?type=history&${new URLSearchParams(categoryPeriod)}`);
    const byCategoryList = await listHistory(categoryPeriod);
    addResult(
        'CSV: カテゴリと期間で絞ると、一覧と同じ行を全件（50 件を超えても）',
        byCategory.status === 200 && byCategory.lines.length === 63 && sameIds(byCategory, byCategoryList.body),
        `${byCategory.lines.length} 行（期待値 63）`
    );

    // 日時は画面と同じく「取引日 + 登録した時刻（日本時間）」
    const row = byProductList.body.find(h => h.transaction_date === '2025-09-01');
    const created = new Date(`${row.created_at.replace(' ', 'T')}Z`);
    const jst = new Date(created.getTime() + 9 * 60 * 60 * 1000);
    const expectedTime = jst.toISOString().slice(11, 19);
    const line = byProduct.lines.find(l => l.startsWith(`${row.id},`));
    addResult(
        'CSV: 日時は取引日と日本時間の時刻（画面の一覧と同じ）',
        line && line.split(',')[1] === `2025/09/01 ${expectedTime}`,
        `${line && line.split(',')[1]}（期待値 2025/09/01 ${expectedTime}）`
    );

    const joy = await fetchCsv(`/api/inventory/export?type=history&productId=${products.joy}`);
    const joyLine = joy.lines.find(l => l.includes('出庫'));
    addResult(
        'CSV: 商品名・備考の記号が「&amp;」「&#x2F;」のまま出ない',
        joyLine && joyLine.includes(',P&G ジョイ 1/2,') && joyLine.includes(',"A社/B社, ""急ぎ""",') &&
            !/&amp;|&#x2F;|&quot;/.test(joy.text),
        joyLine
    );

    addResult(
        'CSV: ファイル名で何を絞ったか分かる（商品・期間）',
        byProduct.fileName === '入出庫履歴_ニトリルグローブ(Ｍサイズ)_20250801-20250930.csv',
        byProduct.fileName
    );
    addResult(
        'CSV: ファイル名で何を絞ったか分かる（カテゴリ・期間 / 条件なし）',
        byCategory.fileName === '入出庫履歴_衛生用品_20250901-20250930.csv' &&
            all.fileName === '入出庫履歴_全商品.csv',
        `${byCategory.fileName} / ${all.fileName}`
    );

    const special = await fetchCsv(`/api/inventory/export?type=history&${new URLSearchParams({ category: 'A&B/テスト' })}`);
    addResult(
        'CSV: ファイル名に使えない文字は置き換える',
        special.fileName === '入出庫履歴_A&B_テスト.csv',
        special.fileName
    );

    const bad = await fetchCsv('/api/inventory/export?type=history&productId=abc');
    addResult(
        'CSV: 不正な条件は拒否する',
        bad.status === 400,
        `status ${bad.status}`
    );
}

// ---------------------------------------------------------------------------
// 3. 画面（jsdom）
// ---------------------------------------------------------------------------

function tableCategories(window) {
    // 詳細行（まとめ表示の中身）の内側の表は数えない
    return [...window.document.querySelectorAll('#history-table > tbody > tr:not(.history-detail-row)')]
        .map(tr => tr.cells[2] && tr.cells[2].textContent.trim())
        .filter(Boolean);
}

async function testScreen() {
    const { window, errors } = openUserScreen(client, BASE_URL);
    const doc = window.document;
    let downloaded = null;

    try {
        await waitFor(() => doc.querySelectorAll('.stock-card').length > 0, 'ダッシュボードが開く');

        doc.querySelector('.nav-btn[data-page="history"]').click();
        await waitFor(
            () => [...doc.querySelectorAll('#history-category-filter option')].some(o => o.value === '衛生用品'),
            '履歴確認の画面が開く'
        );
        // 開いた直後の一覧（条件なし）が描き終わるのを待つ。読み込み中に条件を変えて
        // 更新すると、あとから届いた条件なしの結果で上書きされることがある
        await waitFor(() => doc.querySelectorAll('#history-table > tbody > tr').length > 0, '最初の一覧が描かれる');

        // カテゴリと期間を選んで「更新」
        const category = doc.getElementById('history-category-filter');
        category.value = '衛生用品';
        category.dispatchEvent(new window.Event('change'));
        doc.getElementById('history-start-date').value = '2025-09-01';
        doc.getElementById('history-end-date').value = '2025-09-30';
        doc.querySelector('#history-table tbody').innerHTML = '';
        doc.getElementById('refresh-history').click();
        await waitFor(() => doc.querySelectorAll('#history-table tbody tr').length > 0, '一覧が描かれる');

        const shown = tableCategories(window);
        addResult(
            '画面: カテゴリを選ぶと、一覧もそのカテゴリだけになる',
            shown.length > 0 && shown.every(c => c === '衛生用品'),
            `一覧のカテゴリ: ${[...new Set(shown)].join(', ')}`
        );

        // 「履歴CSV出力」を押すと、画面の条件がそのまま CSV に渡る
        window.downloadFile = url => { downloaded = url; };
        doc.getElementById('export-history').click();
        const params = new URL(downloaded, BASE_URL).searchParams;
        addResult(
            '画面: 「履歴CSV出力」に画面の条件（カテゴリ・期間）が渡る',
            params.get('type') === 'history' && params.get('category') === '衛生用品' &&
                params.get('startDate') === '2025-09-01' && params.get('endDate') === '2025-09-30' &&
                !params.has('productId'),
            downloaded
        );

        const csv = await fetchCsv(downloaded);
        addResult(
            '画面: 押して落ちる CSV は、画面の条件に合う行だけ',
            csv.status === 200 && csv.lines.length === 63,
            `${csv.lines.length} 行（期待値 63）`
        );

        // 商品まで選んだとき
        const product = doc.getElementById('history-filter');
        product.value = String(products.glove);
        doc.getElementById('export-history').click();
        const withProduct = new URL(downloaded, BASE_URL).searchParams;
        addResult(
            '画面: 商品を選ぶと、その商品も CSV の条件に入る',
            withProduct.get('productId') === String(products.glove) && withProduct.get('category') === '衛生用品',
            downloaded
        );

        // 「&」「/」を含むカテゴリも、選んだまま届く
        category.value = 'A&B/テスト';
        category.dispatchEvent(new window.Event('change'));
        doc.getElementById('history-start-date').value = '';
        doc.getElementById('history-end-date').value = '';
        doc.getElementById('export-history').click();
        const specialCsv = await fetchCsv(downloaded);
        addResult(
            '画面: 記号を含むカテゴリでも、CSV はそのカテゴリの行だけ',
            specialCsv.status === 200 && specialCsv.lines.length === 2,
            `${specialCsv.lines.length} 行（期待値 2） / ${downloaded}`
        );

        addResult(
            '画面: 操作中にエラーが出ていない',
            errors.length === 0,
            errors.length === 0 ? 'エラーなし' : errors.join(' / ')
        );
    } finally {
        window.close();
    }
}

// ---------------------------------------------------------------------------

(async () => {
    console.log('========================================');
    console.log('入出庫履歴の絞り込みと CSV のテスト開始');
    console.log('========================================\n');

    const { server, waitUntilReady } = startServer({ port: PORT, dbDir: DB_DIR });

    try {
        await waitUntilReady(BASE_URL);
        await setupLocationUser(client);
        await prepare();

        await testList();
        await testCsv();
        await testScreen();
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
