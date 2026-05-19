const token = localStorage.getItem('token');
const role = localStorage.getItem('role');

if (!token) {
    window.location.href = '/login.html';
}

const logoutBtn = document.getElementById('logoutBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const ytUrlInput = document.getElementById('ytUrl');
const streamTitleInput = document.getElementById('streamTitle');
const urlInputGroup = document.getElementById('urlInputGroup');
const adminStatusBadge = document.getElementById('adminStatusBadge');
const adminListeners = document.getElementById('adminListeners');
const currentUrlSpan = document.getElementById('currentUrl');
const adminCurrentTitle = document.getElementById('adminCurrentTitle');
const streamMsg = document.getElementById('streamMsg');

// Tab logic
const tabs = document.querySelectorAll('.tab');
const contents = document.querySelectorAll('.tab-content');
const usersTabBtn = document.getElementById('usersTabBtn');

if (role === 'superadmin') {
    usersTabBtn.style.display = 'block';
}

const changePwdBtn = document.getElementById('changePwdBtn');
const pwdDialog = document.getElementById('pwdDialog');
const pwdForm = document.getElementById('pwdForm');
const cancelPwdBtn = document.getElementById('cancelPwdBtn');
const pwdError = document.getElementById('pwdError');

if (role !== 'superadmin') {
    changePwdBtn.style.display = 'block';
}

changePwdBtn.addEventListener('click', () => {
    pwdDialog.showModal();
});

cancelPwdBtn.addEventListener('click', () => {
    pwdDialog.close();
    pwdForm.reset();
    pwdError.style.display = 'none';
});

pwdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPwd = document.getElementById('newPwd').value;
    const confirmPwd = document.getElementById('confirmPwd').value;
    
    if (newPwd !== confirmPwd) {
        showMsg(pwdError, 'Passwords do not match', true);
        return;
    }
    
    try {
        const data = await apiCall('/auth/password', 'PUT', { newPassword: newPwd });
        if (data.success) {
            pwdDialog.close();
            pwdForm.reset();
            alert('Password updated successfully!');
        } else {
            showMsg(pwdError, data.message, true);
        }
    } catch (err) {
        showMsg(pwdError, 'Network error', true);
    }
});

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        contents.forEach(c => c.classList.remove('active'));
        
        tab.classList.add('active');
        document.getElementById(tab.dataset.target).classList.add('active');
        
        if (tab.dataset.target === 'usersTab') {
            loadUsers();
        }
    });
});

logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('role');
    window.location.href = '/login.html';
});

async function apiCall(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${token}`
        }
    };
    if (body) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }
    const res = await fetch(endpoint, options);
    if (res.status === 401) {
        localStorage.removeItem('token');
        window.location.href = '/login.html';
    }
    return res.json();
}

function handleStreamStatusUpdate(data) {
    if (data.listenerCount !== undefined) {
        adminListeners.textContent = `Listeners: ${data.listenerCount}`;
    }
    currentUrlSpan.textContent = data.url || 'None';
    if (adminCurrentTitle) {
        adminCurrentTitle.textContent = data.title || 'None';
    }
    
    // Hide/Show inputs and buttons based on URL state (started vs stopped)
    if (data.url) {
        startBtn.style.display = 'none';
        stopBtn.style.display = 'block';
        urlInputGroup.style.display = 'none';
    } else {
        startBtn.style.display = 'block';
        stopBtn.style.display = 'none';
        urlInputGroup.style.display = 'block';
        startBtn.disabled = false;
        startBtn.textContent = 'START STREAM';
    }

    if (data.online) {
        adminStatusBadge.textContent = 'ACTIVE';
        adminStatusBadge.className = 'badge live';
    } else {
        adminStatusBadge.textContent = 'OFFLINE';
        adminStatusBadge.className = 'badge';
    }
}

// Fetch initial status immediately on load
async function checkInitialStreamStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        handleStreamStatusUpdate(data);
    } catch (err) {
        console.error('Failed to fetch status:', err);
    }
}

// Connect to Server-Sent Events for real-time status updates in admin
function connectAdminSSE() {
    const eventSource = new EventSource('/api/status/events');

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleStreamStatusUpdate(data);
        } catch (err) {
            console.error('Failed to parse SSE event data:', err);
        }
    };

    eventSource.onerror = (err) => {
        console.error('Admin SSE connection lost. Reconnecting in 5 seconds...', err);
        eventSource.close();
        setTimeout(connectAdminSSE, 5000);
    };
}

function showMsg(element, msg, isError = false) {
    element.textContent = msg;
    element.className = isError ? 'error-msg' : 'success-msg';
    element.style.display = 'block';
    setTimeout(() => { element.style.display = 'none'; }, 3000);
}

startBtn.addEventListener('click', async () => {
    const url = ytUrlInput.value;
    const title = streamTitleInput ? streamTitleInput.value : '';
    if (!url) {
        showMsg(streamMsg, 'Please enter a URL', true);
        return;
    }
    
    startBtn.disabled = true;
    startBtn.textContent = 'STARTING...';
    
    try {
        const data = await apiCall('/api/start', 'POST', { url, title });
        if (data.success) {
            showMsg(streamMsg, 'Stream started successfully');
            ytUrlInput.value = '';
            if (streamTitleInput) streamTitleInput.value = '';
            checkInitialStreamStatus();
        } else {
            showMsg(streamMsg, data.message || 'Error starting stream', true);
            startBtn.disabled = false;
            startBtn.textContent = 'START STREAM';
        }
    } catch (err) {
        showMsg(streamMsg, 'Network error', true);
        startBtn.disabled = false;
        startBtn.textContent = 'START STREAM';
    }
});

stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    stopBtn.textContent = 'STOPPING...';
    try {
        const data = await apiCall('/api/stop', 'POST');
        if (data.success) {
            showMsg(streamMsg, 'Stream stopped');
            checkInitialStreamStatus();
        } else {
            showMsg(streamMsg, data.message, true);
        }
    } catch (err) {
        showMsg(streamMsg, 'Network error', true);
    } finally {
        stopBtn.disabled = false;
        stopBtn.textContent = 'STOP STREAM';
    }
});

// Users logic
const usersList = document.getElementById('usersList');
const addUserForm = document.getElementById('addUserForm');
const userMsg = document.getElementById('userMsg');

async function loadUsers() {
    try {
        const data = await apiCall('/auth/users');
        if (data.success) {
            usersList.innerHTML = '';
            data.users.forEach(u => {
                const tr = document.createElement('tr');
                let actionHtml = '';
                if (u.role !== 'superadmin') {
                    actionHtml = `<button class="del-btn" onclick="deleteUser(${u.id})">Delete</button>`;
                } else {
                    actionHtml = `<span style="color:var(--text-muted); font-size:0.8rem;">Protected</span>`;
                }
                
                tr.innerHTML = `
                    <td>${u.id}</td>
                    <td>${u.username}</td>
                    <td>${u.role}</td>
                    <td>${actionHtml}</td>
                `;
                usersList.appendChild(tr);
            });
        }
    } catch (err) {
        console.error('Failed to load users', err);
    }
}

addUserForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('newUsername').value;
    const password = document.getElementById('newPassword').value;
    
    try {
        const data = await apiCall('/auth/users', 'POST', { username, password });
        if (data.success) {
            showMsg(userMsg, 'User created');
            document.getElementById('newUsername').value = '';
            document.getElementById('newPassword').value = '';
            loadUsers();
        } else {
            showMsg(userMsg, data.message, true);
        }
    } catch (err) {
        showMsg(userMsg, 'Error creating user', true);
    }
});

const deleteDialog = document.getElementById('deleteDialog');
const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
let userToDelete = null;

window.deleteUser = function(id) {
    userToDelete = id;
    deleteDialog.showModal();
};

cancelDeleteBtn.addEventListener('click', () => {
    deleteDialog.close();
    userToDelete = null;
});

confirmDeleteBtn.addEventListener('click', async () => {
    if (!userToDelete) return;
    const id = userToDelete;
    deleteDialog.close();
    
    try {
        const data = await apiCall(`/auth/users/${id}`, 'DELETE');
        if (data.success) {
            showMsg(userMsg, 'User deleted');
            loadUsers();
        } else {
            showMsg(userMsg, data.message, true);
        }
    } catch (err) {
        showMsg(userMsg, 'Error deleting user', true);
    } finally {
        userToDelete = null;
    }
});

// Check status on load and connect Server-Sent Events channel
checkInitialStreamStatus();
connectAdminSSE();
