// 拠点一覧を読み込み
async function loadLocations() {
    try {
        console.log('拠点一覧を読み込み中...');
        const response = await fetch('/api/public/locations');
        console.log('Response status:', response.status);

        const locations = await response.json();
        console.log('取得した拠点:', locations);

        const locationSelect = document.getElementById('location-select');
        if (!locationSelect) {
            console.error('location-select要素が見つかりません');
            return;
        }

        locationSelect.innerHTML = '<option value="">拠点を選択してください</option>';

        locations.forEach(location => {
            const option = document.createElement('option');
            option.value = location.location_code;
            option.textContent = location.location_name;
            locationSelect.appendChild(option);
        });

        console.log('拠点一覧の読み込みが完了しました。拠点数:', locations.length);
    } catch (error) {
        console.error('拠点読み込みエラー:', error);
    }
}

// ページ読み込み時に拠点一覧を取得
document.addEventListener('DOMContentLoaded', () => {
    loadLocations();
});

// タブ切り替え機能
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;

        // タブボタンの切り替え
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // フォームの切り替え
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
            if (content.dataset.tab === tab) {
                content.classList.add('active');
            }
        });

        // エラーメッセージをクリア
        document.getElementById('error-message').classList.remove('show');
    });
});

// ユーザーログイン
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const locationCode = document.getElementById('location-select').value;
    const userId = document.getElementById('user-id').value;
    const password = document.getElementById('password').value;
    const rememberMe = document.getElementById('remember-me').checked;
    const errorMessage = document.getElementById('error-message');

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ locationCode, userId, password, rememberMe })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            window.location.href = '/';
        } else {
            errorMessage.textContent = data.error || 'ログインに失敗しました';
            errorMessage.classList.add('show');
        }
    } catch (error) {
        errorMessage.textContent = 'サーバーエラーが発生しました';
        errorMessage.classList.add('show');
    }
});

// 管理者ログイン
document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('admin-username').value;
    const password = document.getElementById('admin-password').value;
    const rememberMe = document.getElementById('admin-remember-me').checked;
    const errorMessage = document.getElementById('error-message');

    try {
        const response = await fetch('/api/auth/admin/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password, rememberMe })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            window.location.href = '/admin.html';
        } else {
            errorMessage.textContent = data.error || 'ログインに失敗しました';
            errorMessage.classList.add('show');
        }
    } catch (error) {
        errorMessage.textContent = 'サーバーエラーが発生しました';
        errorMessage.classList.add('show');
    }
});