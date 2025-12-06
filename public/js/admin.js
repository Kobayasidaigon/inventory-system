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
                <div class="location-info">
                    <strong>${location.location_name}</strong>
                    <span style="color: #666; margin-left: 10px;">(${location.location_code})</span>
                    <div style="font-size: 12px; color: #999; margin-top: 5px;">
                        登録日: ${new Date(location.created_at).toLocaleDateString('ja-JP')}
                    </div>
                </div>
                <div class="action-buttons">
                    <button class="btn-small btn-edit">編集</button>
                    <button class="btn-small btn-delete">削除</button>
                </div>
            `;

            // イベントリスナーを追加
            const locationInfo = div.querySelector('.location-info');
            const editBtn = div.querySelector('.btn-edit');
            const deleteBtn = div.querySelector('.btn-delete');

            locationInfo.addEventListener('click', () => {
                selectLocation(location.id, location.location_name, location.location_code);
            });

            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                editLocation(location.id, location.location_name);
            });

            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteLocation(location.id, location.location_name);
            });

            locationList.appendChild(div);
        });
    } catch (error) {
        console.error('拠点読み込みエラー:', error);
        alert('拠点の読み込みに失敗しました');
    }
}

// 拠点選択
async function selectLocation(locationId, locationName, locationCode) {
    selectedLocationId = locationId;

    // 選択状態の表示更新
    document.querySelectorAll('.location-item').forEach(item => {
        item.classList.remove('selected');
    });
    event.target.closest('.location-item').classList.add('selected');

    // 選択された拠点情報を表示
    document.getElementById('selected-location-info').textContent =
        `選択中: ${locationName} (${locationCode})`;

    // ユーザーフォームとテーブルを表示
    document.getElementById('user-form').style.display = 'flex';
    document.getElementById('users-table').style.display = 'table';

    // ユーザー一覧を読み込み
    await loadUsers(locationId);
}

// ユーザー一覧読み込み
async function loadUsers(locationId) {
    try {
        const response = await fetch(`/api/auth/admin/locations/${locationId}/users`);
        const users = await response.json();

        const usersList = document.getElementById('users-list');
        usersList.innerHTML = '';

        if (users.length === 0) {
            usersList.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #666;">登録されているユーザーがいません</td></tr>';
            return;
        }

        users.forEach(user => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${user.user_id}</td>
                <td>${user.user_name}</td>
                <td>${new Date(user.created_at).toLocaleDateString('ja-JP')}</td>
                <td>
                    <button class="btn btn-small btn-edit" data-user-id="${user.id}" data-user-login-id="${user.user_id}" data-user-name="${user.user_name}">編集</button>
                    <button class="btn btn-small btn-delete" data-user-id="${user.id}" data-user-login-id="${user.user_id}">削除</button>
                </td>
            `;

            // イベントリスナーを追加
            const editBtn = tr.querySelector('.btn-edit');
            const deleteBtn = tr.querySelector('.btn-delete');

            editBtn.addEventListener('click', () => {
                editUser(user.id, user.user_id, user.user_name);
            });

            deleteBtn.addEventListener('click', () => {
                deleteUser(user.id, user.user_id);
            });

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

// 拠点編集
async function editLocation(locationId, currentName) {
    const newName = prompt('新しい拠点名を入力してください:', currentName);

    if (!newName || newName === currentName) {
        return;
    }

    try {
        const response = await fetch(`/api/auth/admin/locations/${locationId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locationName: newName })
        });

        const data = await response.json();

        if (response.ok) {
            alert('拠点を更新しました');
            await loadLocations();
        } else {
            alert(data.error || '拠点の更新に失敗しました');
        }
    } catch (error) {
        console.error('拠点編集エラー:', error);
        alert('拠点の更新に失敗しました');
    }
}

// 拠点削除
async function deleteLocation(locationId, locationName) {
    if (!confirm(`拠点「${locationName}」を削除してもよろしいですか？\n\n※この拠点に登録されているユーザーがいる場合は削除できません。`)) {
        return;
    }

    try {
        const response = await fetch(`/api/auth/admin/locations/${locationId}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (response.ok) {
            alert('拠点を削除しました');

            // 削除した拠点が選択中の場合、選択をクリア
            if (selectedLocationId === locationId) {
                selectedLocationId = null;
                document.getElementById('selected-location-info').textContent = '※ 左側の拠点リストから拠点を選択してください';
                document.getElementById('user-form').style.display = 'none';
                document.getElementById('users-table').style.display = 'none';
            }

            await loadLocations();
        } else {
            alert(data.error || '拠点の削除に失敗しました');
        }
    } catch (error) {
        console.error('拠点削除エラー:', error);
        alert('拠点の削除に失敗しました');
    }
}

// ユーザー編集
async function editUser(userId, currentUserId, currentUserName) {
    const newUserName = prompt('新しいユーザー名を入力してください:', currentUserName);

    if (!newUserName) {
        return;
    }

    const newPassword = prompt('新しいパスワードを入力してください（変更しない場合は空欄）:', '');

    try {
        const body = { userName: newUserName };
        if (newPassword) {
            body.password = newPassword;
        }

        const response = await fetch(`/api/auth/admin/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (response.ok) {
            alert('ユーザーを更新しました');
            await loadUsers(selectedLocationId);
        } else {
            alert(data.error || 'ユーザーの更新に失敗しました');
        }
    } catch (error) {
        console.error('ユーザー編集エラー:', error);
        alert('ユーザーの更新に失敗しました');
    }
}

// ユーザー削除
async function deleteUser(userId, userIdName) {
    if (!confirm(`ユーザー「${userIdName}」を削除してもよろしいですか？`)) {
        return;
    }

    try {
        const response = await fetch(`/api/auth/admin/users/${userId}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (response.ok) {
            alert('ユーザーを削除しました');
            await loadUsers(selectedLocationId);
        } else {
            alert(data.error || 'ユーザーの削除に失敗しました');
        }
    } catch (error) {
        console.error('ユーザー削除エラー:', error);
        alert('ユーザーの削除に失敗しました');
    }
}
