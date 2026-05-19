const audioPlayer = document.getElementById('audioPlayer');
const playBtn = document.getElementById('playBtn');
const playIcon = document.querySelector('.play-icon');
const pauseIcon = document.querySelector('.pause-icon');
const loadingIcon = document.querySelector('.loading-icon');
const visualizer = document.querySelector('.visualizer');
const statusBadge = document.getElementById('statusBadge');
const listenersCount = document.getElementById('listeners');
const reconnectStatus = document.getElementById('reconnectStatus');
const trackTitle = document.getElementById('trackTitle');

let isPlaying = false;
let isIntentionallyStopped = true;
let statusInterval;

function handleStatusUpdate(data) {
    if (data.listenerCount !== undefined) {
        listenersCount.textContent = `Listeners: ${data.listenerCount}`;
    }
    
    if (data.online) {
        statusBadge.textContent = 'LIVE';
        statusBadge.className = 'badge live';
        if (trackTitle) {
            trackTitle.textContent = 'Live Radio Stream';
            trackTitle.style.color = 'var(--text-main)';
        }
        // Auto reconnect if we were playing but audio stopped
        if (!isIntentionallyStopped && !isPlaying && audioPlayer.paused) {
            startPlayback();
        }
    } else {
        statusBadge.textContent = 'OFFLINE';
        statusBadge.className = 'badge';
        if (trackTitle) {
            trackTitle.textContent = 'Radio Stream Offline';
            trackTitle.style.color = 'var(--text-muted)';
        }
        if (isPlaying) {
            stopPlaybackUI();
        }
    }
}

// Fetch initial status immediately on load
async function checkInitialStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        handleStatusUpdate(data);
    } catch (err) {
        console.error('Failed to fetch initial status:', err);
    }
}

// Connect to Server-Sent Events for real-time status changes
function connectSSE() {
    const eventSource = new EventSource('/api/status/events');

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleStatusUpdate(data);
        } catch (err) {
            console.error('Failed to parse SSE event data:', err);
        }
    };

    eventSource.onerror = (err) => {
        console.error('SSE connection lost. Reconnecting in 5 seconds...', err);
        eventSource.close();
        setTimeout(connectSSE, 5000);
    };
}

function startPlayback() {
    isIntentionallyStopped = false;
    audioPlayer.src = `/live?t=${Date.now()}`;
    
    // Show loading spinner immediately
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'none';
    loadingIcon.style.display = 'block';
    visualizer.classList.remove('playing');
    
    audioPlayer.play().catch(err => {
        console.error('Playback failed (maybe 503 offline):', err);
        stopPlaybackUI();
        showReconnecting();
    });
}

function stopPlayback() {
    isIntentionallyStopped = true;
    stopPlaybackUI();
    hideReconnecting();
}

function stopPlaybackUI() {
    audioPlayer.pause();
    audioPlayer.src = '';
    isPlaying = false;
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
    loadingIcon.style.display = 'none';
    visualizer.classList.remove('playing');
}

function showReconnecting() {
    if (reconnectStatus) reconnectStatus.style.display = 'block';
}

function hideReconnecting() {
    if (reconnectStatus) reconnectStatus.style.display = 'none';
}

// Auto-reconnect listeners
audioPlayer.addEventListener('ended', () => {
    if (!isIntentionallyStopped) {
        console.log('Stream ended unexpectedly. Reconnecting...');
        showReconnecting();
        setTimeout(startPlayback, 3000);
    }
});

audioPlayer.addEventListener('error', () => {
    if (!isIntentionallyStopped) {
        console.log('Stream error. Reconnecting...');
        showReconnecting();
        setTimeout(startPlayback, 3000);
    }
});

// HTML5 Audio Buffering states
audioPlayer.addEventListener('waiting', () => {
    if (!isIntentionallyStopped) {
        playIcon.style.display = 'none';
        pauseIcon.style.display = 'none';
        loadingIcon.style.display = 'block';
        visualizer.classList.remove('playing');
    }
});

audioPlayer.addEventListener('playing', () => {
    isPlaying = true;
    playIcon.style.display = 'none';
    loadingIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
    visualizer.classList.add('playing');
    hideReconnecting();
});

playBtn.addEventListener('click', () => {
    if (isPlaying) {
        stopPlayback();
    } else {
        startPlayback();
    }
});

// Check status on load and connect Server-Sent Events channel
checkInitialStatus();
connectSSE();
