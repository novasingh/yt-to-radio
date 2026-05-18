const { execFile } = require('child_process');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');

// Do NOT use @ffmpeg-installer/ffmpeg! Let's check system ffmpeg!
console.log('Using system-wide ffmpeg (looking up in PATH)...');

ffmpeg.setFfmpegPath(ffmpegPath);

async function testYtDlpExecFile() {
    console.log('Testing direct child_process.execFile of youtube-dl-exec binary...');
    try {
        const url = 'https://www.youtube.com/watch?v=zb7Dik2a6N4';
        console.log('Step 1: Extracting direct stream URL via yt-dlp...');

        const directUrl = await youtubedl(url, {
            f: 'bestaudio/best',
            getUrl: true,
            noPlaylist: true,
            geoBypass: true,
            socketTimeout: 15,
            ignoreConfig: true,
            jsRuntimes: 'node'
        });

        console.log('Step 2: Extracted direct URL:', directUrl.substring(0, 100) + '...');

        console.log('Step 3: Spawning system ffmpeg...');
        const command = ffmpeg(directUrl)
            .inputOptions('-re')
            .audioCodec('libmp3lame')
            .audioBitrate('16k')
            .format('mp3')
            .on('start', (commandLine) => {
                console.log('ffmpeg spawned successfully with command:', commandLine);
            })
            .on('stderr', (stderrLine) => {
                console.log('ffmpeg stderr:', stderrLine);
            })
            .on('error', (err) => {
                console.error('ffmpeg error:', err.message);
            })
            .on('end', () => {
                console.log('ffmpeg ended');
            });

        const outStream = command.pipe();
        let chunkCount = 0;
        outStream.on('data', (chunk) => {
            chunkCount++;
            console.log(`Received chunk #${chunkCount} of size ${chunk.length}`);
            if (chunkCount >= 5) {
                console.log('Received 5 chunks successfully, stopping test.');
                try { command.kill('SIGKILL'); } catch (e) { }
                process.exit(0);
            }
        });

        // Timeout after 30 seconds
        setTimeout(() => {
            console.error('Test timed out after 30s. No chunks received.');
            try { command.kill('SIGKILL'); } catch (e) { }
            process.exit(1);
        }, 30000);

    } catch (err) {
        console.error('Extraction Error:', err.message);
    }
}

testYtDlpExecFile();
