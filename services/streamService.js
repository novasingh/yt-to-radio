const { EventEmitter } = require('events');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Setup execute-permitted local temp directory (kept for compatibility)
const localTmpDir = path.join(__dirname, '../tmp');
if (!fs.existsSync(localTmpDir)) {
    try {
        fs.mkdirSync(localTmpDir, { recursive: true });
    } catch (err) {
        logger.error(`Failed to create local tmp directory: ${err.message}`);
    }
}
process.env.TMPDIR = localTmpDir;
process.env.TEMP = localTmpDir;
process.env.TMP = localTmpDir;

// Set static FFmpeg path natively and automatically (no manual install!)
try {
    ffmpeg.setFfmpegPath(ffmpegPath);
    logger.info(`Locked static FFmpeg path successfully via ffmpeg-static: ${ffmpegPath}`);
} catch (ffmpegErr) {
    logger.error(`Failed to set static FFmpeg path: ${ffmpegErr.message}`);
}

// Helper to search and find the cookies.txt file across multiple locations
function getCookiesPath() {
    const paths = [
        path.join(__dirname, '../cookies.txt'),
        path.join(__dirname, 'cookies.txt'),
        path.join(process.cwd(), 'cookies.txt')
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

// Convert Netscape cookies.txt file content into standard Cookie header string
function getCookieHeaderString(cookiesPath) {
    if (!cookiesPath || !fs.existsSync(cookiesPath)) return '';
    try {
        const lines = fs.readFileSync(cookiesPath, 'utf8').split('\n');
        const cookies = [];
        for (const line of lines) {
            const cleanLine = line.trim();
            if (!cleanLine || cleanLine.startsWith('#')) continue;
            const parts = cleanLine.split('\t');
            if (parts.length >= 7) {
                const name = parts[5];
                const value = parts[6];
                cookies.push(`${name}=${value}`);
            }
        }
        return cookies.join('; ');
    } catch (err) {
        logger.error(`Error parsing cookies.txt: ${err.message}`);
        return '';
    }
}

// Helper to extract the 11-character video ID from standard YouTube links
function extractVideoId(url) {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
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
        this.maxBurstSize = 128 * 1024; // 128KB memory cache for instant playback buffering
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
                if (timeSinceLastChunk > 20000) {
                    logger.error('Watchdog: No audio chunks received for 20s. Restarting stream.');
                    this._handleProcessClose();
                }
            }
        }, 5000);
    }

    async _launchProcesses() {
        if (!this.currentUrl) return;

        const sessionId = this.streamSessionId;
        logger.info(`Starting stream extraction for URL: ${this.currentUrl} (session: ${sessionId})`);

        const videoId = extractVideoId(this.currentUrl);
        if (!videoId) {
            logger.error(`Invalid YouTube URL provided: ${this.currentUrl}`);
            this._handleProcessClose();
            return;
        }

        try {
            logger.info('Initializing Innertube YouTube.js client...');
            const { Innertube } = require('youtubei.js');
            
            const cookiesPath = getCookiesPath();
            const config = {};
            
            if (cookiesPath) {
                const cookieString = getCookieHeaderString(cookiesPath);
                if (cookieString) {
                    config.cookie = cookieString;
                    logger.info(`Detected cookies.txt at: ${cookiesPath}. Applied session cookies successfully to YouTube.js.`);
                }
            } else {
                logger.warn('WARNING: cookies.txt was NOT found on this server! YouTube.js requests will be unauthenticated.');
            }

            const client = await Innertube.create(config);

            if (sessionId !== this.streamSessionId || !this.shouldRetry) return;

            const clientsToTry = ['TV_EMBEDDED', 'TV', 'ANDROID', 'WEB'];
            let playerResponse = null;
            let lastErr = null;

            for (const clientName of clientsToTry) {
                try {
                    logger.info(`Executing client.getBasicInfo() with ${clientName} client context for video ID: ${videoId}...`);
                    playerResponse = await client.getBasicInfo(videoId, clientName);
                    if (playerResponse && playerResponse.streaming_data) {
                        logger.info(`SUCCESS: Extracted streaming data successfully using ${clientName} client context!`);
                        break;
                    } else {
                        logger.warn(`WARNING: No streaming data returned using ${clientName} client context. Trying next client...`);
                    }
                } catch (err) {
                    lastErr = err;
                    logger.warn(`WARNING: Failed extraction using ${clientName} client context: ${err.message}. Trying next client...`);
                }
            }

            if (sessionId !== this.streamSessionId || !this.shouldRetry) return;

            if (!playerResponse || !playerResponse.streaming_data) {
                throw new Error(lastErr ? lastErr.message : 'All client contexts failed to extract streaming data.');
            }

            const streamingData = playerResponse.streaming_data;

            // Live stream detection
            const isLive = !streamingData.dash_manifest_url && !streamingData.hls_manifest_url ? false : true;
            
            let directUrl;
            if (isLive && streamingData.hls_manifest_url) {
                logger.info('Live stream detected! Using direct HLS master manifest URL for infinite transcoding.');
                directUrl = streamingData.hls_manifest_url;
            } else {
                const formats = [...(streamingData.formats || []), ...(streamingData.adaptive_formats || [])];
                // Select itag 140 (128kbps AAC audio in MP4 container, highly compatible and perfect quality/bandwidth ratio)
                let audioFormat = formats.find(f => f.itag === 140);
                if (!audioFormat) {
                    audioFormat = formats.find(f => f.mime_type.startsWith('audio/'));
                }

                if (!audioFormat) {
                    throw new Error('No compatible audio format found for this video.');
                }

                logger.info(`Static video detected! Chose audio format itag ${audioFormat.itag} (${audioFormat.mime_type}). Deciphering direct play URL...`);
                
                // AWAIT the decipher call to resolve to direct play URL
                directUrl = await audioFormat.decipher(client.session.actions.sig_decipherer);
            }

            if (sessionId !== this.streamSessionId || !this.shouldRetry) return;

            logger.info(`Successfully prepared direct audio stream source (isLive: ${isLive})! Spawning FFmpeg transcoder...`);
            
            this._startFfmpegStream(directUrl, sessionId, isLive);

        } catch (err) {
            if (sessionId !== this.streamSessionId) return;
            logger.error(`YouTube.js streaming error: ${err.message}`);
            this._handleProcessClose();
        }
    }

    _startFfmpegStream(directUrl, sessionId, isLive = false) {
        if (sessionId !== this.streamSessionId || !this.shouldRetry) return;

        // Create fluent-ffmpeg command reading from the direct URL
        const cmd = ffmpeg(directUrl);
        
        // Pacing standard non-live video frames to match real-time audio playback
        if (!isLive) {
            cmd.inputOptions('-re');
        }

        this.ffmpegCommand = cmd
            .audioCodec('libmp3lame')
            .audioBitrate('128k') // High-quality 128kbps MP3 audio for premium listening experience
            .format('mp3')
            .on('start', (commandLine) => {
                logger.info('fluent-ffmpeg process spawned successfully.');
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
                logger.info('Stream is now online and broadcasting via automatic FFmpeg transcoder.');
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
        this.watchdogInterval = null;
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
        
        // Send correct content-type header for standard MP3
        res.setHeader('Content-Type', 'audio/mpeg');
        
        // Burst on connect: send the last 128KB immediately so browser buffers instantly
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
