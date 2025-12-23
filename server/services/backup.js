const fs = require('fs');
const path = require('path');
const { mainDb } = require('../db/database-admin');

// データベースディレクトリのパス
const DB_DIR = process.env.DB_DIR || path.join(__dirname, '../db');
const BACKUP_DIR = path.join(DB_DIR, 'backups');

// バックアップディレクトリが存在しない場合は作成
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * データベースをバックアップ
 * @returns {Promise<{success: boolean, backupFile: string, message: string}>}
 */
async function backupDatabase() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' +
                         new Date().toTimeString().split(' ')[0].replace(/:/g, '-');

        const backupFile = path.join(BACKUP_DIR, `backup_${timestamp}.tar.gz`);

        // バックアップディレクトリを確実に作成
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }

        // tar.gzで圧縮してバックアップ
        const { execSync } = require('child_process');

        // DB_DIR内のすべての.dbファイルをバックアップ
        const dbFiles = fs.readdirSync(DB_DIR)
            .filter(file => file.endsWith('.db'))
            .map(file => path.join(DB_DIR, file));

        if (dbFiles.length === 0) {
            return {
                success: false,
                message: 'バックアップ対象のデータベースファイルが見つかりません'
            };
        }

        // 絶対パスを取得
        const absoluteBackupFile = path.resolve(backupFile);
        const absoluteDbDir = path.resolve(DB_DIR);

        // tarコマンドでバックアップ（各DBファイルを個別に追加）
        const fileList = dbFiles.map(f => path.basename(f)).join(' ');
        execSync(`cd ${absoluteDbDir} && tar -czf ${absoluteBackupFile} ${fileList}`);

        // バックアップファイルのサイズを取得
        const stats = fs.statSync(backupFile);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

        console.log(`✓ バックアップ完了: ${backupFile} (${fileSizeMB} MB)`);

        // 古いバックアップを削除（30日以上前のものを削除）
        await cleanOldBackups(30);

        return {
            success: true,
            backupFile: path.basename(backupFile),
            size: fileSizeMB,
            message: `バックアップが完了しました (${fileSizeMB} MB)`
        };
    } catch (err) {
        console.error('バックアップエラー:', err);
        return {
            success: false,
            message: `バックアップに失敗しました: ${err.message}`
        };
    }
}

/**
 * 古いバックアップファイルを削除
 * @param {number} daysToKeep - 保持する日数
 */
async function cleanOldBackups(daysToKeep = 30) {
    try {
        const now = Date.now();
        const files = fs.readdirSync(BACKUP_DIR);

        let deletedCount = 0;

        for (const file of files) {
            if (!file.startsWith('backup_') || !file.endsWith('.tar.gz')) {
                continue;
            }

            const filePath = path.join(BACKUP_DIR, file);
            const stats = fs.statSync(filePath);
            const fileAge = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24); // 日数

            if (fileAge > daysToKeep) {
                fs.unlinkSync(filePath);
                deletedCount++;
                console.log(`✓ 古いバックアップを削除: ${file} (${fileAge.toFixed(0)}日前)`);
            }
        }

        if (deletedCount > 0) {
            console.log(`✓ ${deletedCount}個の古いバックアップを削除しました`);
        }
    } catch (err) {
        console.error('バックアップクリーンアップエラー:', err);
    }
}

/**
 * バックアップファイル一覧を取得
 * @returns {Array<{filename: string, size: string, date: string}>}
 */
function listBackups() {
    try {
        const files = fs.readdirSync(BACKUP_DIR);
        const backups = [];

        for (const file of files) {
            if (!file.startsWith('backup_') || !file.endsWith('.tar.gz')) {
                continue;
            }

            const filePath = path.join(BACKUP_DIR, file);
            const stats = fs.statSync(filePath);
            const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

            backups.push({
                filename: file,
                size: fileSizeMB,
                date: stats.mtime.toISOString(),
                path: filePath
            });
        }

        // 日付の新しい順にソート
        backups.sort((a, b) => new Date(b.date) - new Date(a.date));

        return backups;
    } catch (err) {
        console.error('バックアップ一覧取得エラー:', err);
        return [];
    }
}

/**
 * 定期バックアップを開始
 * @param {number} intervalHours - バックアップ間隔（時間）
 */
function startScheduledBackup(intervalHours = 24) {
    console.log(`✓ 定期バックアップを開始: ${intervalHours}時間ごと`);

    // 起動時に1回実行
    setTimeout(() => {
        console.log('起動時バックアップを実行中...');
        backupDatabase();
    }, 10000); // 10秒後に実行（起動完了を待つ）

    // 定期実行
    setInterval(async () => {
        console.log('定期バックアップを実行中...');
        await backupDatabase();
    }, intervalHours * 60 * 60 * 1000);
}

/**
 * バックアップからデータベースを復元
 * @param {string} backupFilename - バックアップファイル名
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function restoreDatabase(backupFilename) {
    try {
        // セキュリティチェック
        if (backupFilename.includes('..') || backupFilename.includes('/')) {
            return {
                success: false,
                message: '不正なファイル名です'
            };
        }

        if (!backupFilename.startsWith('backup_') || !backupFilename.endsWith('.tar.gz')) {
            return {
                success: false,
                message: '不正なバックアップファイルです'
            };
        }

        const backupFile = path.join(BACKUP_DIR, backupFilename);

        // バックアップファイルの存在確認
        if (!fs.existsSync(backupFile)) {
            return {
                success: false,
                message: 'バックアップファイルが見つかりません'
            };
        }

        const { execSync } = require('child_process');
        const absoluteBackupFile = path.resolve(backupFile);
        const absoluteDbDir = path.resolve(DB_DIR);

        console.log(`リストアを開始: ${backupFilename}`);

        // 現在のDBファイルをバックアップ（念のため）
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' +
                         new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
        const tempBackupFile = path.join(BACKUP_DIR, `before_restore_${timestamp}.tar.gz`);

        const dbFiles = fs.readdirSync(DB_DIR)
            .filter(file => file.endsWith('.db'))
            .map(file => path.basename(file));

        if (dbFiles.length > 0) {
            const fileList = dbFiles.join(' ');
            const absoluteTempBackupFile = path.resolve(tempBackupFile);
            execSync(`cd ${absoluteDbDir} && tar -czf ${absoluteTempBackupFile} ${fileList}`);
            console.log(`✓ 現在のDBを一時保存: ${tempBackupFile}`);
        }

        // バックアップファイルを展開
        execSync(`cd ${absoluteDbDir} && tar -xzf ${absoluteBackupFile}`, { stdio: 'inherit' });

        console.log(`✓ リストア完了: ${backupFilename}`);

        // fly.io環境の場合は自動再起動を試みる
        if (process.env.FLY_APP_NAME) {
            console.log('fly.io環境を検出しました。再起動を試みます...');

            // 非同期で再起動（レスポンスを返した後に実行）
            setTimeout(() => {
                try {
                    const { exec } = require('child_process');
                    // fly.ioの特殊なエンドポイントを使用してシャットダウン
                    // fly.ioは自動的に新しいインスタンスを起動します
                    exec('kill -SIGTERM 1', (error) => {
                        if (error) {
                            console.error('再起動エラー:', error);
                        } else {
                            console.log('再起動シグナルを送信しました');
                        }
                    });
                } catch (err) {
                    console.error('再起動に失敗:', err);
                }
            }, 2000); // 2秒後に実行（レスポンスを返す時間を確保）

            return {
                success: true,
                message: `リストアが完了しました。fly.ioアプリケーションが自動的に再起動されます...`
            };
        }

        return {
            success: true,
            message: `リストアが完了しました。サーバーを再起動してください。`
        };
    } catch (err) {
        console.error('リストアエラー:', err);
        return {
            success: false,
            message: `リストアに失敗しました: ${err.message}`
        };
    }
}

module.exports = {
    backupDatabase,
    cleanOldBackups,
    listBackups,
    startScheduledBackup,
    restoreDatabase,
    BACKUP_DIR
};
