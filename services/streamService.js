const { EventEmitter } = require('events');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { Innertube, Platform } = require('youtubei.js');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Provide the mandatory JavaScript interpreter for youtubei.js to decipher signatures natively
Platform.shim.eval = async (data) => {
    return new Function(data.output)();
};

// Netscape HTTP Cookie File Parser
function parseNetscapeCookies(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const cookiePairs = [];
    
    for (const line of lines) {
        if (line.trim().startsWith('#') || line.trim() === '') continue;
        
        const parts = line.split('\t');
        if (parts.length >= 7) {
            const name = parts[5].trim();
            const value = parts[6].trim();
            if (name && value) {
                cookiePairs.push(`${name}=${value}`);
            }
        }
    }
    
    return cookiePairs.join('; ');
}

// Lazy-loaded Innertube client factory
let youtubeClient = null;
async function getYoutubeClient() {
    if (!youtubeClient) {
        const cookiesPath = path.join(__dirname, '../cookies.txt');
        let cookieString = '';
        if (fs.existsSync(cookiesPath)) {
            try {
                cookieString = parseNetscapeCookies(cookiesPath);
                logger.info('Detected cookies.txt in project root. Parsed Netscape cookies successfully for youtubei.js.');
            } catch (e) {
                logger.warn(`Failed to parse cookies.txt: ${e.message}`);
            }
        }
        
        youtubeClient = await Innertube.create({
            cookie: cookieString || undefined
        });
        logger.info('Innertube YouTube client created successfully.');
    }
    return youtubeClient;
}

// YouTube Video ID extractor regex helper
function getYouTubeVideoId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

// Tell fluent-ffmpeg to use the locally installed static binary
try {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
} catch (ffmpegErr) {
    logger.error(`Failed to set local FFmpeg path: ${ffmpegErr.message}`);
}

class StreamService extends EventEmitter {
    constructor() {
        super();
        this.currentUrl = null;
        this.isOnline = false;
        this.ffmpegCommand = null;
        this.ffmpegStream = null;
        this.listeners = new Set();
        this.retryTimeout = null;
        this.watchdogInterval = null;
        this.lastChunkTime = Date.now();
        this.shouldRetry = true;
        this.burstBuffer = [];
        this.currentBurstSize = 0;
        this.maxBurstSize = 64 * 1024; // 64KB memory cache for instant playback
        this.streamSessionId = 0;
    }

    startStream(url) {
        if (this.currentUrl === url && this.isOnline) {
            return;
        }

        this.stopStream(false);
        this.streamSessionId++;
        this.currentUrl = url;
        this.shouldRetry = true;
        this._startWatchdog();
        this._launchProcesses();
    }

    _startWatchdog() {
        clearInterval(this.watchdogInterval);
        this.watchdogInterval = setInterval(() => {
            if (this.isOnline && this.ffmpegCommand) {
                const timeSinceLastChunk = Date.now() - this.lastChunkTime;
                if (timeSinceLastChunk > 15000) {
                    logger.error('Watchdog: No audio chunks received for 15s. Restarting stream.');
                    this._handleProcessClose();
                }
            }
        }, 5000);
    }

    async _launchProcesses() {
        if (!this.currentUrl) return;

        const sessionId = this.streamSessionId;
        logger.info(`Starting stream extraction for URL: ${this.currentUrl} (session: ${sessionId})`);
        
        // Extract the video ID from the URL
        const videoId = getYouTubeVideoId(this.currentUrl);
        if (!videoId) {
            logger.error(`Invalid YouTube URL format: ${this.currentUrl}`);
            this._handleProcessClose();
            return;
        }

        let webStream;
        try {
            logger.info('Fetching stream source via youtubei.js (100% Pure JavaScript)...');
            const client = await getYoutubeClient();
            const videoInfo = await client.getInfo(videoId);

            // Fetch the best audio stream format natively
            webStream = await videoInfo.download({
                type: 'audio',
                quality: 'best'
            });
        } catch (err) {
            if (sessionId !== this.streamSessionId) return;
            logger.warn(`youtubei.js error fetching URL: ${err.message}`);
            this._handleProcessClose();
            return;
        }

        // In case stopStream or startStream was called while we were awaiting the URL
        if (sessionId !== this.streamSessionId || !this.shouldRetry) {
            logger.info('Aborting process launch: Stream session changed.');
            if (webStream) {
                try { webStream.cancel(); } catch (e) {}
            }
            return;
        }

        logger.info('Successfully extracted direct audio stream.');

        // Convert modern Web-standard ReadableStream to a standard Node.js Readable stream
        const nodeStream = Readable.fromWeb(webStream);

        // Create fluent-ffmpeg command reading from the Node.js readable stream
        this.ffmpegCommand = ffmpeg(nodeStream)
            .audioCodec('libmp3lame')
            .audioBitrate('16k')
            .format('mp3')
            .on('start', (commandLine) => {
                logger.info(`Spawned fluent-ffmpeg`);
            })
            .on('error', (err) => {
                if (err.message.includes('SIGKILL') || err.message.includes('ffmpeg was killed')) return; // Ignore intentional kills
                logger.warn(`fluent-ffmpeg error: ${err.message}`);
                this._handleProcessClose();
            })
            .on('end', () => {
                logger.info('ffmpeg stream ended naturally');
                this._handleProcessClose();
            });

        // Get the output stream to pipe to listeners
        this.ffmpegStream = this.ffmpegCommand.pipe();

        this.ffmpegStream.on('data', (chunk) => {
            this.lastChunkTime = Date.now();
            
            // Manage burst buffer
            this.burstBuffer.push(chunk);
            this.currentBurstSize += chunk.length;
            while (this.currentBurstSize > this.maxBurstSize) {
                const removed = this.burstBuffer.shift();
                this.currentBurstSize -= removed.length;
            }

            if (!this.isOnline) {
                this.isOnline = true;
                logger.info('Stream is now online and broadcasting via Node modules.');
                this.emit('status-change');
            }
            for (const res of this.listeners) {
                try {
                    res.write(chunk);
                } catch (e) {
                    this.removeListener(res);
                }
            }
        });
    }

    _handleProcessClose() {
        if (!this.shouldRetry) return; // Already stopped or handling manual stop
        
        this.isOnline = false;
        this.emit('status-change');
        this._cleanupProcesses();

        logger.info('Scheduling stream restart in 10 seconds...');
        clearTimeout(this.retryTimeout);
        this.retryTimeout = setTimeout(() => {
            this._launchProcesses();
        }, 10000);
    }

    _cleanupProcesses() {
        if (this.ffmpegCommand) {
            try {
                this.ffmpegCommand.kill('SIGKILL');
            } catch (e) {}
            this.ffmpegCommand = null;
        }
        if (this.ffmpegStream) {
            try {
                this.ffmpegStream.destroy();
            } catch (e) {}
            this.ffmpegStream = null;
        }
        this.burstBuffer = [];
        this.currentBurstSize = 0;
    }

    stopStream(clearUrl = true) {
        logger.info('Stopping stream manually.');
        this.streamSessionId++;
        this.shouldRetry = false;
        clearTimeout(this.retryTimeout);
        clearInterval(this.watchdogInterval);
        if (clearUrl) {
            this.currentUrl = null;
        }
        this._cleanupProcesses();
        this.isOnline = false;
        this.emit('status-change');
        
        // End all active listener responses
        for (const res of this.listeners) {
            res.end();
        }
        this.listeners.clear();
    }

    addListener(res) {
        this.listeners.add(res);
        logger.info(`Listener added. Total listeners: ${this.listeners.size}`);
        
        // Burst on connect: send the last 64KB immediately so browser buffers instantly
        if (this.burstBuffer.length > 0) {
            const burstData = Buffer.concat(this.burstBuffer);
            try {
                res.write(burstData);
            } catch (e) {
                this.removeListener(res);
            }
        }
        
        // Ensure to remove listener if they disconnect
        res.on('close', () => {
            this.removeListener(res);
        });
    }

    removeListener(res) {
        this.listeners.delete(res);
        logger.info(`Listener removed. Total listeners: ${this.listeners.size}`);
    }

    getStatus() {
        return {
            online: this.isOnline,
            url: this.currentUrl,
            listenerCount: this.listeners.size
        };
    }
}

module.exports = new StreamService();
