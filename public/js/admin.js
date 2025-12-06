let selectedLocationId = null;

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
    await checkAdminAuth();
    await loadLocations();
});

// 管理者認証チェック
async function checkAdminAuth() {
    try {
        const response = await fetch('/api/auth/check');
        const data = await response.json();

        if (!data.loggedIn || !data.isAdmin) {
            window.location.href = '/';
            return;
        }

        document.getElementById('admin-name').textContent = `管理者: ${data.userName}`;
    } catch (error) {
        console.error('認証チェックエラー:', error);
        window.location.href = '/';
    }
}

// ログアウト
document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.href = '/';
    } catch (error) {
        console.error('ログアウトエラー:', error);
    }
});

// 拠点一覧読み込み
async function loadLocations() {
    try {
        const response = await fetch('/api/auth/admin/locations');
        const locations = await response.json();

        const locationList = document.getElementById('location-list');
        locationList.innerHTML = '';

        if (locations.length === 0) {
            locationList.innerHTML = '<p style="color: #666;">登録されている拠点がありません</p>';
            return;
        }

        locations.forEach(location => {
            const div = document.createElement('div');
            div.className = 'location-item';
            div.innerHTML = `
                <strong>${location.location_name}</strong>
                <span style="color: #666; margin-left: 10px;">(${location.location_code})</span>
                <div style="font-size: 12px; color: #999; margin-top: 5px;">
                    登録日: ${new Date(location.created_at).toLocaleDateString('ja-JP')}
                </div>
            `;
            div.addEventListener('click', () => selectLocation(location));
            locationList.appendChild(div);
        });
    } catch (error) {
        console.error('拠点読み込みエラー:', error);
        alert('拠点の読み込みに失敗しました');
    }
}

// 拠点選択
async function selectLocation(location) {
    selectedLocationId = location.id;

    // 選択状態の表示更新
    document.querySelectorAll('.location-item').forEach(item => {
        item.classList.remove('selected');
    });
    event.target.closest('.location-item').classList.add('selected');

    // 選択された拠点情報を表示
    document.getElementById('selected-location-info').textContent =
        `選択中: ${location.location_name} (${location.location_code})`;

    // ユーザーフォームとテーブルを表示
    document.getElementById('user-form').style.display = 'flex';
    document.getElementById('users-table').style.display = 'table';

    // ユーザー一覧を読み込み
    await loadUsers(location.id);
}

// ユーザー一覧読み込み
async function loadUsers(locationId) {
    try {
        const response = await fetch(`/api/auth/admin/locations/${locationId}/users`);
        const users = await response.json();

        const usersList = document.getElementById('users-list');
        usersList.innerHTML = '';

        if (users.length === 0) {
            usersList.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #666;">登録されているユーザーがいません</td></tr>';
            return;
        }

        users.forEach(user => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${user.user_id}</td>
                <td>${user.user_name}</td>
                <td>${new Date(user.created_at).toLocaleDateString('ja-JP')}</td>
            `;
            usersList.appendChild(tr);
        });
    } catch (error) {
        console.error('ユーザー読み込みエラー:', error);
        alert('ユーザーの読み込みに失敗しました');
    }
}

// 拠点追加
document.getElementById('add-location-btn').addEventListener('click', async () => {
    const locationCode = document.getElementById('location-code').value.trim();
    const locationName = document.getElementById('location-name').value.trim();

    if (!locationCode || !locationName) {
        alert('拠点コードと拠点名を入力してください');
        return;
    }

    try {
        const response = await fetch('/api/auth/admin/locations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locationCode, locationName })
        });

        const data = await response.json();

        if (response.ok) {
            alert('拠点を追加しました');
            document.getElementById('location-code').value = '';
            document.getElementById('location-name').value = '';
            await loadLocations();
        } else {
            alert(data.error || '拠点の追加に失敗しました');
        }
    } catch (error) {
        console.error('拠点追加エラー:', error);
        alert('拠点の追加に失敗しました');
    }
});

// ユーザー追加
document.getElementById('add-user-btn').addEventListener('click', async () => {
    if (!selectedLocationId) {
        alert('拠点を選択してください');
        return;
    }

    const userId = document.getElementById('user-id').value.trim();
    const userName = document.getElementById('user-name').value.trim();
    const password = document.getElementById('user-password').value;

    if (!userId || !userName || !password) {
        alert('すべての項目を入力してください');
        return;
    }

    try {
        const response = await fetch('/api/auth/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                locationId: selectedLocationId,
                userId,
                userName,
                password
            })
        });

        const data = await response.json();

        if (response.ok) {
            alert('ユーザーを追加しました');
            document.getElementById('user-id').value = '';
            document.getElementById('user-name').value = '';
            document.getElementById('user-password').value = '';
            await loadUsers(selectedLocationId);
        } else {
            alert(data.error || 'ユーザーの追加に失敗しました');
        }
    } catch (error) {
        console.error('ユーザー追加エラー:', error);
        alert('ユーザーの追加に失敗しました');
    }
});
