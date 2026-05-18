const { EventEmitter } = require('events');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const play = require('play-dl');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

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
        
        // Detect and apply cookies if present in project root for play-dl
        const cookiesPath = path.join(__dirname, '../cookies.txt');
        if (fs.existsSync(cookiesPath)) {
            try {
                const cookies = fs.readFileSync(cookiesPath, 'utf8');
                play.setToken({
                    youtube: {
                        cookie: cookies
                    }
                });
                logger.info('Detected cookies.txt file in project root. Loaded cookies successfully into play-dl.');
            } catch (cookieErr) {
                logger.warn(`Failed to set play-dl cookie token: ${cookieErr.message}`);
            }
        }
        
        let source;
        try {
            logger.info('Fetching stream source via play-dl (100% Pure JavaScript)...');
            source = await play.stream(this.currentUrl, {
                quality: 1 // best audio quality
            });
        } catch (err) {
            if (sessionId !== this.streamSessionId) return;
            logger.warn(`play-dl error fetching URL: ${err.message}`);
            this._handleProcessClose();
            return;
        }

        // In case stopStream or startStream was called while we were awaiting the URL
        if (sessionId !== this.streamSessionId || !this.shouldRetry) {
            logger.info('Aborting process launch: Stream session changed.');
            if (source && source.stream) {
                try { source.stream.destroy(); } catch (e) {}
            }
            return;
        }

        logger.info('Successfully extracted direct play-dl audio stream.');

        // Create fluent-ffmpeg command reading from the play-dl readable stream
        this.ffmpegCommand = ffmpeg(source.stream)
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
