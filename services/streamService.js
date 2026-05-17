const { EventEmitter } = require('events');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const youtubedl = require('youtube-dl-exec');
const logger = require('../utils/logger');

// Tell fluent-ffmpeg to use the locally installed static binary
ffmpeg.setFfmpegPath(ffmpegStatic);

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
    }

    startStream(url) {
        if (this.currentUrl === url && this.isOnline) {
            return;
        }

        this.stopStream(false);
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

        logger.info(`Starting stream extraction for URL: ${this.currentUrl}`);
        
        let directUrl;
        try {
            // Get the direct media URL instead of piping stdout.
            // Using stability flags: --no-playlist, --geo-bypass, and timeout
            directUrl = await youtubedl(this.currentUrl, {
                f: 'bestaudio/best',
                getUrl: true,
                noPlaylist: true,
                geoBypass: true,
                socketTimeout: 15
            });
        } catch (err) {
            logger.warn(`yt-dlp error fetching URL: ${err.message}`);
            this._handleProcessClose();
            return;
        }

        // In case stopStream was called while we were awaiting the URL
        if (!this.shouldRetry) return;

        logger.info('Successfully extracted direct stream URL.');

        // Create fluent-ffmpeg command reading from the direct URL
        this.ffmpegCommand = ffmpeg(directUrl)
            // -re tells ffmpeg to read input at native frame rate. 
            // This is CRITICAL so non-live videos don't finish transcoding in 2 seconds and stop the stream.
            .inputOptions('-re') 
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
    }

    stopStream(clearUrl = true) {
        logger.info('Stopping stream manually.');
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
