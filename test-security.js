/**
 * セキュリティ対策テストスクリプト
 * XSS対策とCSRF対策の動作を確認
 */

const http = require('http');

console.log('========================================');
console.log('セキュリティテスト開始');
console.log('========================================\n');

// テスト結果を保存
const results = {
    passed: 0,
    failed: 0,
    tests: []
};

function addResult(name, passed, message) {
    results.tests.push({ name, passed, message });
    if (passed) {
        results.passed++;
        console.log(`✅ ${name}: ${message}`);
    } else {
        results.failed++;
        console.log(`❌ ${name}: ${message}`);
    }
}

// テスト1: CSRFトークンなしでPOSTリクエスト（拒否されるべき）
function testCsrfWithoutToken() {
    return new Promise((resolve) => {
        const postData = JSON.stringify({ locationName: 'テスト拠点' });

        const options = {
            hostname: 'localhost',
            port: 3000,
            path: '/api/auth/admin/locations',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (res.statusCode === 403 && response.error) {
                        addResult(
                            'CSRF: トークンなしリクエストの拒否',
                            true,
                            `期待通り403エラー: ${response.error}`
                        );
                    } else {
                        addResult(
                            'CSRF: トークンなしリクエストの拒否',
                            false,
                            `予期しないレスポンス: ${res.statusCode}`
                        );
                    }
                } catch (error) {
                    addResult(
                        'CSRF: トークンなしリクエストの拒否',
                        false,
                        `エラー: ${error.message}`
                    );
                }
                resolve();
            });
        });

        req.on('error', (error) => {
            addResult(
                'CSRF: トークンなしリクエストの拒否',
                false,
                `リクエストエラー: ${error.message}`
            );
            resolve();
        });

        req.write(postData);
        req.end();
    });
}

// テスト2: CSRFトークン取得エンドポイントの動作確認
function testCsrfTokenEndpoint() {
    return new Promise((resolve) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: '/api/csrf-token',
            method: 'GET'
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.success && response.csrfToken) {
                        addResult(
                            'CSRF: トークン取得エンドポイント',
                            true,
                            `トークン取得成功: ${response.csrfToken.substring(0, 20)}...`
                        );
                    } else {
                        addResult(
                            'CSRF: トークン取得エンドポイント',
                            false,
                            '期待されるフォーマットと異なる'
                        );
                    }
                } catch (error) {
                    addResult(
                        'CSRF: トークン取得エンドポイント',
                        false,
                        `パースエラー: ${error.message}`
                    );
                }
                resolve();
            });
        });

        req.on('error', (error) => {
            addResult(
                'CSRF: トークン取得エンドポイント',
                false,
                `リクエストエラー: ${error.message}`
            );
            resolve();
        });

        req.end();
    });
}

// テスト3: XSS対策 - サニタイズ関数の確認
function testXssSanitization() {
    try {
        const { sanitizeHtml } = require('./server/utils/xss-protection');

        const maliciousInputs = [
            '<script>alert("XSS")</script>',
            '<img src=x onerror=alert("XSS")>',
            '<svg onload=alert("XSS")>',
            'javascript:alert("XSS")'
        ];

        let allPassed = true;
        maliciousInputs.forEach(input => {
            const sanitized = sanitizeHtml(input);
            if (sanitized.includes('<script') || sanitized.includes('onerror') || sanitized.includes('onload')) {
                allPassed = false;
            }
        });

        if (allPassed) {
            addResult(
                'XSS: サニタイズ関数の動作',
                true,
                '悪意のあるスクリプトが正しく除去される'
            );
        } else {
            addResult(
                'XSS: サニタイズ関数の動作',
                false,
                'スクリプトタグが残っている'
            );
        }
    } catch (error) {
        addResult(
            'XSS: サニタイズ関数の動作',
            false,
            `エラー: ${error.message}`
        );
    }
}

// テスト4: HTMLファイルにcsrf.jsが含まれているか確認
function testCsrfScriptInclusion() {
    const fs = require('fs');
    const path = require('path');

    const htmlFiles = [
        'public/login.html',
        'public/index.html',
        'public/admin.html',
        'public/setup.html'
    ];

    let allIncluded = true;
    const missing = [];

    htmlFiles.forEach(file => {
        const filePath = path.join(__dirname, file);
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            if (!content.includes('csrf.js')) {
                allIncluded = false;
                missing.push(file);
            }
        } catch (error) {
            allIncluded = false;
            missing.push(`${file} (読み取りエラー)`);
        }
    });

    if (allIncluded) {
        addResult(
            'CSRF: スクリプトの読み込み',
            true,
            'すべてのHTMLファイルにcsrf.jsが含まれている'
        );
    } else {
        addResult(
            'CSRF: スクリプトの読み込み',
            false,
            `以下のファイルにcsrf.jsがありません: ${missing.join(', ')}`
        );
    }
}

// すべてのテストを実行
async function runAllTests() {
    console.log('サーバーが起動していることを確認してください (http://localhost:3000)\n');

    // XSS対策テスト（サーバー不要）
    testXssSanitization();
    testCsrfScriptInclusion();

    // CSRF対策テスト（サーバー必要）
    await testCsrfTokenEndpoint();
    await testCsrfWithoutToken();

    // 結果サマリー
    console.log('\n========================================');
    console.log('テスト結果サマリー');
    console.log('========================================');
    console.log(`合計: ${results.passed + results.failed}件`);
    console.log(`✅ 成功: ${results.passed}件`);
    console.log(`❌ 失敗: ${results.failed}件`);
    console.log('========================================\n');

    if (results.failed === 0) {
        console.log('🎉 すべてのテストが成功しました！');
    } else {
        console.log('⚠️  一部のテストが失敗しました。上記の詳細を確認してください。');
    }

    process.exit(results.failed > 0 ? 1 : 0);
}

runAllTests().catch(error => {
    console.error('テスト実行エラー:', error);
    process.exit(1);
});
