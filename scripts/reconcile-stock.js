/**
 * 現在庫と履歴のズレを調べて、必要なら調整履歴で埋めるスクリプト。
 *
 * 在庫の更新と履歴の追記が別々のクエリだった頃のデータには、
 * 「現在庫 = 履歴の増減の合計」が成り立たない商品がある。
 * 現在庫はそのままに、差分を説明する調整履歴を 1 件ずつ足して辻褄を合わせる。
 *
 * 使い方:
 *   node scripts/reconcile-stock.js                # 調べるだけ（何も書き換えない）
 *   node scripts/reconcile-stock.js --apply        # 実際に調整履歴を入れる
 *   node scripts/reconcile-stock.js --location 1   # 拠点コードを指定
 *
 * --apply の前に、必ずデータベースのバックアップを取ってください。
 */

require('dotenv').config();

const { mainDb, getLocationDatabase, closeAllDatabases } = require('../server/db/database-admin');
const { reconcileLocation } = require('../server/services/stock-reconcile');

function parseArgs(argv) {
    const options = { apply: false, locationCode: null };

    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--apply') {
            options.apply = true;
        } else if (argv[i] === '--location') {
            options.locationCode = argv[i + 1];
            i++;
        }
    }

    return options;
}

function printDiscrepancies(discrepancies) {
    if (discrepancies.length === 0) {
        console.log(`  ズレはありません`);
        return;
    }

    for (const item of discrepancies) {
        const sign = item.diff > 0 ? '+' : '';
        console.log(
            `  [${String(item.productId).padStart(4)}] ${item.productName}\n` +
            `         現在庫 ${item.currentStock} / 履歴の合計 ${item.historyTotal}` +
            ` → 調整 ${sign}${item.diff}（${item.adjustDate || '日付なし'} に記録）`
        );
    }
}

(async () => {
    const options = parseArgs(process.argv.slice(2));

    console.log('========================================');
    console.log('現在庫と履歴のズレを確認します');
    console.log(options.apply ? 'モード: 調整履歴を実際に追加します' : 'モード: 確認のみ（--apply で実行）');
    console.log('========================================\n');

    let totalDiscrepancies = 0;
    let totalApplied = 0;

    try {
        await mainDb.ready;

        let locations = await mainDb.all('SELECT * FROM locations ORDER BY location_code');

        if (options.locationCode) {
            locations = locations.filter(l => l.location_code === options.locationCode);

            if (locations.length === 0) {
                console.error(`拠点コード ${options.locationCode} が見つかりません`);
                process.exitCode = 1;
                return;
            }
        }

        if (locations.length === 0) {
            console.log('拠点が登録されていません');
            return;
        }

        for (const location of locations) {
            console.log(`■ ${location.location_name}（拠点コード ${location.location_code}）`);

            const db = getLocationDatabase(location.location_code);
            await db.ready;

            const { discrepancies, applied } = await reconcileLocation(db, {
                apply: options.apply
            });

            printDiscrepancies(discrepancies);

            if (options.apply && applied > 0) {
                console.log(`  → ${applied} 件の調整履歴を追加しました`);
            }

            totalDiscrepancies += discrepancies.length;
            totalApplied += applied;
            console.log('');
        }

        console.log('========================================');
        console.log(`ズレのある商品: ${totalDiscrepancies} 件`);

        if (options.apply) {
            console.log(`追加した調整履歴: ${totalApplied} 件`);
        } else if (totalDiscrepancies > 0) {
            console.log('実際に直すには --apply を付けて実行してください');
            console.log('（先にデータベースのバックアップを取ってください）');
        }

        console.log('========================================');
    } catch (err) {
        console.error('処理中にエラーが発生しました:', err);
        process.exitCode = 1;
    } finally {
        closeAllDatabases();
    }
})();
