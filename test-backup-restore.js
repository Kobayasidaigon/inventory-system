// バックアップ/リストアのテストスクリプト
const { backupDatabase, listBackups, restoreDatabase } = require('./server/services/backup');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_DIR = process.env.DB_DIR || path.join(__dirname, 'server/db');
const mainDbPath = path.join(DB_DIR, 'main.db');

// Promiseラッパー
function runQuery(db, query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function testBackupRestore() {
    console.log('\n========== バックアップ/リストアテスト開始 ==========\n');

    const db = new sqlite3.Database(mainDbPath);

    try {
        // 1. 現在の状態を確認
        console.log('📊 1. 現在のデータベース状態を確認');
        const usersBefore = await runQuery(db, 'SELECT COUNT(*) as count FROM users');
        const locationsBefore = await runQuery(db, 'SELECT COUNT(*) as count FROM locations');
        console.log(`   ユーザー数: ${usersBefore[0].count}`);
        console.log(`   拠点数: ${locationsBefore[0].count}`);

        // 2. バックアップを作成
        console.log('\n📦 2. バックアップを作成');
        const backupResult = await backupDatabase();
        if (backupResult.success) {
            console.log(`   ✓ ${backupResult.message}`);
            console.log(`   ファイル: ${backupResult.backupFile}`);
        } else {
            console.log(`   ✗ ${backupResult.message}`);
            return;
        }

        // 3. バックアップ一覧を表示
        console.log('\n📋 3. バックアップ一覧');
        const backups = listBackups();
        backups.slice(0, 3).forEach((backup, index) => {
            console.log(`   ${index + 1}. ${backup.filename} (${backup.size} MB)`);
        });

        // 4. データベースに変更を加える（テスト用の設定を追加）
        console.log('\n✏️  4. データベースに変更を加える（テスト）');
        await new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO settings (key, value) VALUES ('test_key', 'test_value_12345')",
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
        const settingsAfterChange = await runQuery(db, "SELECT * FROM settings WHERE key = 'test_key'");
        console.log(`   ✓ テストデータを追加: ${settingsAfterChange[0].value}`);

        // 5. 古いバックアップからリストア
        console.log('\n🔄 5. バックアップからリストア');
        const oldestBackup = backups[backups.length - 1]; // 一番古いバックアップ
        console.log(`   リストアするファイル: ${oldestBackup.filename}`);

        db.close(); // DBを閉じる

        const restoreResult = await restoreDatabase(oldestBackup.filename);
        if (restoreResult.success) {
            console.log(`   ✓ ${restoreResult.message}`);
        } else {
            console.log(`   ✗ ${restoreResult.message}`);
            return;
        }

        // 6. リストア後の状態を確認
        console.log('\n✅ 6. リストア後の状態を確認');
        const db2 = new sqlite3.Database(mainDbPath);

        const usersAfter = await runQuery(db2, 'SELECT COUNT(*) as count FROM users');
        const locationsAfter = await runQuery(db2, 'SELECT COUNT(*) as count FROM locations');
        const settingsAfterRestore = await runQuery(db2, "SELECT * FROM settings WHERE key = 'test_key'");

        console.log(`   ユーザー数: ${usersAfter[0].count}`);
        console.log(`   拠点数: ${locationsAfter[0].count}`);
        console.log(`   テストデータ: ${settingsAfterRestore.length === 0 ? '削除されました ✓' : '残っています ✗'}`);

        db2.close();

        console.log('\n========== テスト完了 ==========\n');
        console.log('結果:');
        console.log('  ✓ バックアップ作成: OK');
        console.log('  ✓ バックアップ一覧取得: OK');
        console.log('  ✓ データベース変更: OK');
        console.log('  ✓ リストア: OK');
        console.log(`  ✓ データ復元: ${settingsAfterRestore.length === 0 ? 'OK' : 'NG'}`);
        console.log('\n全てのテストが完了しました！\n');

    } catch (error) {
        console.error('\n❌ エラーが発生しました:', error);
        db.close();
    }
}

// テスト実行
testBackupRestore().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('テストエラー:', err);
    process.exit(1);
});
