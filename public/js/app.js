const audioPlayer = document.getElementById('audioPlayer');
const playBtn = document.getElementById('playBtn');
const playIcon = document.querySelector('.play-icon');
const pauseIcon = document.querySelector('.pause-icon');
const loadingIcon = document.querySelector('.loading-icon');
const visualizer = document.querySelector('.visualizer');
const statusBadge = document.getElementById('statusBadge');
const listenersCount = document.getElementById('listeners');

let isPlaying = false;
let isIntentionallyStopped = true;
let statusInterval;

// Fetch stream status
async function updateStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        listenersCount.textContent = `Listeners: ${data.listenerCount}`;
        
        if (data.online) {
            statusBadge.textContent = 'LIVE';
            statusBadge.className = 'badge live';
            // Auto reconnect if we were playing but audio stopped
            if (!isIntentionallyStopped && !isPlaying && audioPlayer.paused) {
                startPlayback();
            }
        } else {
            statusBadge.textContent = 'OFFLINE';
            statusBadge.className = 'badge';
            if (isPlaying) {
                stopPlaybackUI();
            }
        }
    } catch (err) {
        console.error('Failed to fetch status:', err);
    }
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
        // Retry logic handled by setInterval if stream comes back
    });
}

function stopPlayback() {
    isIntentionallyStopped = true;
    stopPlaybackUI();
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

// Auto-reconnect listeners
audioPlayer.addEventListener('ended', () => {
    if (!isIntentionallyStopped) {
        console.log('Stream ended unexpectedly. Reconnecting...');
        setTimeout(startPlayback, 3000);
    }
});

audioPlayer.addEventListener('error', () => {
    if (!isIntentionallyStopped) {
        console.log('Stream error. Reconnecting...');
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
});

playBtn.addEventListener('click', () => {
    if (isPlaying) {
        stopPlayback();
    } else {
        startPlayback();
    }
});

// Update status every 5 seconds
updateStatus();
statusInterval = setInterval(updateStatus, 5000);
