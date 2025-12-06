const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'inventory.db');
const db = new sqlite3.Database(dbPath);

console.log('テストデータを作成します...\n');

db.serialize(async () => {
    // テストユーザーを作成
    const hashedPassword = await bcrypt.hash('password123', 10);

    db.run(`INSERT OR IGNORE INTO users (username, password) VALUES (?, ?)`,
        ['testuser', hashedPassword],
        function(err) {
            if (err) {
                console.error('ユーザー作成エラー:', err);
            } else {
                console.log('✓ テストユーザーを作成しました (username: testuser, password: password123)');
            }
        }
    );

    // ユーザーIDを取得
    db.get('SELECT id FROM users WHERE username = ?', ['testuser'], (err, user) => {
        if (err || !user) {
            console.error('ユーザー取得エラー');
            return;
        }

        const userId = user.id;

        // カテゴリ別の商品データ
        const testProducts = [
            // 果物
            { name: 'りんご', category: '果物', reorder_point: 20, current_stock: 50 },
            { name: 'みかん', category: '果物', reorder_point: 30, current_stock: 45 },
            { name: 'バナナ', category: '果物', reorder_point: 25, current_stock: 15 },
            { name: 'いちご', category: '果物', reorder_point: 15, current_stock: 8 },

            // 野菜
            { name: 'キャベツ', category: '野菜', reorder_point: 10, current_stock: 25 },
            { name: 'にんじん', category: '野菜', reorder_point: 20, current_stock: 18 },
            { name: 'じゃがいも', category: '野菜', reorder_point: 30, current_stock: 40 },
            { name: 'たまねぎ', category: '野菜', reorder_point: 25, current_stock: 22 },

            // 飲料
            { name: '緑茶', category: '飲料', reorder_point: 50, current_stock: 80 },
            { name: 'コーヒー', category: '飲料', reorder_point: 40, current_stock: 35 },
            { name: 'ジュース', category: '飲料', reorder_point: 30, current_stock: 12 },
            { name: '牛乳', category: '飲料', reorder_point: 20, current_stock: 25 },

            // 調味料
            { name: '醤油', category: '調味料', reorder_point: 15, current_stock: 20 },
            { name: '砂糖', category: '調味料', reorder_point: 10, current_stock: 8 },
            { name: '塩', category: '調味料', reorder_point: 10, current_stock: 15 },
            { name: '味噌', category: '調味料', reorder_point: 12, current_stock: 18 }
        ];

        let productsInserted = 0;

        testProducts.forEach((product, index) => {
            db.run(
                `INSERT INTO products (name, category, reorder_point, current_stock) VALUES (?, ?, ?, ?)`,
                [product.name, product.category, product.reorder_point, product.current_stock],
                function(err) {
                    if (err) {
                        console.error(`✗ ${product.name} の作成に失敗:`, err.message);
                    } else {
                        productsInserted++;

                        // 商品ごとに過去90日間のランダムな出庫履歴を作成
                        const productId = this.lastID;
                        createHistoryData(productId, product.name, userId);
                    }
                }
            );
        });

        setTimeout(() => {
            console.log(`\n✓ ${productsInserted}個の商品を作成しました`);
            console.log('\nテストデータの作成が完了しました！');
            console.log('\n以下でログインできます:');
            console.log('  ユーザー名: testuser');
            console.log('  パスワード: password123\n');
            db.close();
        }, 3000);
    });
});

// 過去90日間のランダムな出庫履歴を作成
function createHistoryData(productId, productName, userId) {
    const today = new Date();
    let historyCount = 0;

    // 過去90日間のデータを作成
    for (let i = 90; i >= 1; i--) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];

        // 曜日によって消費量を変える（週末は少ない）
        const dayOfWeek = date.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        // ランダムに出庫を発生させる（70%の確率）
        if (Math.random() < 0.7) {
            // 平日: 3-8個、週末: 1-4個
            const baseQuantity = isWeekend ?
                Math.floor(Math.random() * 4) + 1 :
                Math.floor(Math.random() * 6) + 3;

            db.run(
                `INSERT INTO inventory_history (product_id, type, quantity, date, note, user_id, created_at)
                 VALUES (?, 'out', ?, ?, '自動生成データ', ?, ?)`,
                [productId, baseQuantity, dateStr, userId, date.toISOString()],
                function(err) {
                    if (!err) historyCount++;
                }
            );
        }

        // 時々入庫も発生させる（10%の確率）
        if (Math.random() < 0.1) {
            const inQuantity = Math.floor(Math.random() * 30) + 20;

            db.run(
                `INSERT INTO inventory_history (product_id, type, quantity, date, note, user_id, created_at)
                 VALUES (?, 'in', ?, ?, '自動生成データ', ?, ?)`,
                [productId, inQuantity, dateStr, userId, date.toISOString()],
                function(err) {
                    if (!err) historyCount++;
                }
            );
        }
    }

    setTimeout(() => {
        if (historyCount > 0) {
            console.log(`  → ${productName}: ${historyCount}件の履歴データを作成`);
        }
    }, 2000);
}
