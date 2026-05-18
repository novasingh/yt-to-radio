const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

async function testYtDlpExec() {
    console.log('Testing youtube-dl-exec -> ffmpeg -> pipe pipeline with bestaudio/best fallback...');
    try {
        const videoId = '4klRth5QQ8E'; // Lofi Girl Live
        const url = `https://www.youtube.com/watch?v=${videoId}`;

        console.log(`Querying direct URL using youtube-dl-exec for: ${url}`);
        const directUrl = await youtubedl(url, {
            getUrl: true,
            format: 'bestaudio/best'
        });

        console.log(`SUCCESS: Extracted URL: ${directUrl}`);

        console.log('Spawning fluent-ffmpeg with HLS manifest input...');
        const cmd = ffmpeg(directUrl)
            .audioCodec('libmp3lame')
            .audioBitrate('128k')
            .format('mp3')
            .on('start', (commandLine) => {
                console.log('FFmpeg spawned successfully with command:', commandLine);
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err.message);
                process.exit(1);
            })
            .on('end', () => {
                console.log('FFmpeg stream ended naturally.');
                process.exit(0);
            });

        const stream = cmd.pipe();
        
        let chunkCount = 0;
        stream.on('data', (chunk) => {
            chunkCount++;
            console.log(`[Chunk #${chunkCount}] Transcoded MP3 bytes received: ${chunk.length}`);
            
            if (chunkCount >= 10) {
                console.log('SUCCESS: Received 10 consecutive transcoded MP3 chunks successfully!');
                console.log('VERIFIED: youtube-dl-exec -> FFmpeg pipeline with bestaudio/best fallback is 100% operational!');
                try { cmd.kill('SIGKILL'); } catch (e) {}
                process.exit(0);
            }
        });

    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    }
}

testYtDlpExec();
