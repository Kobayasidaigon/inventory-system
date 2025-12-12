const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ローカル環境用
const uploadsDir = path.join(__dirname, '../uploads');

async function optimizeImage(filePath) {
    try {
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();

        // 画像ファイルのみ処理
        if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
            console.log(`スキップ: ${fileName} (非画像ファイル)`);
            return;
        }

        // バックアップファイル名
        const backupPath = filePath + '.backup';

        // 元ファイルをバックアップ
        fs.copyFileSync(filePath, backupPath);

        // 画像を圧縮・リサイズ
        await sharp(filePath)
            .resize(800, 800, {
                fit: 'inside',
                withoutEnlargement: true
            })
            .jpeg({ quality: 80 })
            .toFile(filePath + '.tmp');

        // 元ファイルを圧縮後のファイルで置き換え
        fs.renameSync(filePath + '.tmp', filePath);

        // ファイルサイズを比較
        const originalSize = fs.statSync(backupPath).size;
        const optimizedSize = fs.statSync(filePath).size;
        const reduction = ((1 - optimizedSize / originalSize) * 100).toFixed(2);

        console.log(`✓ ${fileName}: ${(originalSize / 1024).toFixed(2)}KB → ${(optimizedSize / 1024).toFixed(2)}KB (${reduction}% 削減)`);

        // バックアップを削除
        fs.unlinkSync(backupPath);

    } catch (err) {
        console.error(`エラー: ${path.basename(filePath)} - ${err.message}`);
        // エラーが発生した場合はバックアップから復元
        const backupPath = filePath + '.backup';
        if (fs.existsSync(backupPath)) {
            fs.copyFileSync(backupPath, filePath);
            fs.unlinkSync(backupPath);
        }
    }
}

async function optimizeAllImages() {
    console.log('既存画像の最適化を開始します...\n');

    if (!fs.existsSync(uploadsDir)) {
        console.log(`uploadsディレクトリが見つかりません: ${uploadsDir}`);
        return;
    }

    const files = fs.readdirSync(uploadsDir);

    if (files.length === 0) {
        console.log('画像ファイルが見つかりません。');
        return;
    }

    console.log(`${files.length}個のファイルを処理します...\n`);

    for (const file of files) {
        const filePath = path.join(uploadsDir, file);

        // ディレクトリはスキップ
        if (fs.statSync(filePath).isDirectory()) {
            continue;
        }

        await optimizeImage(filePath);
    }

    console.log('\n最適化が完了しました！');
}

// スクリプト実行
optimizeAllImages().catch(err => {
    console.error('エラーが発生しました:', err);
    process.exit(1);
});
