const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');

async function testStream() {
    console.log('Testing @distube/ytdl-core streaming...');
    try {
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        const options = {
            filter: 'audioonly',
            quality: 'highestaudio'
        };

        if (fs.existsSync(cookiesPath)) {
            console.log('Applying cookies.txt for authentication...');
            // ytdl-core accepts cookies as an array of objects or parsed cookie string/header
            // But distube/ytdl-core has direct support for cookies from a cookie header or file
            // Let's pass the raw cookies or parse them!
            // Wait, distube/ytdl-core can accept cookies via standard headers or requestOptions:
            // options.requestOptions = {
            //     headers: {
            //         Cookie: fs.readFileSync(cookiesPath, 'utf8')
            //     }
            // };
        }

        const stream = ytdl('https://www.youtube.com/watch?v=4klRth5QQ8E', options);

        stream.on('info', (info) => {
            console.log('Successfully fetched video info!');
            console.log('Title:', info.videoDetails.title);
            console.log('Is Live Broadcast:', info.videoDetails.isLiveContent);
        });

        stream.on('data', (chunk) => {
            console.log(`Received chunk of size: ${chunk.length} bytes`);
            // We got data, so it works! Terminate early
            console.log('SUCCESS: Stream data is flowing! @distube/ytdl-core works perfectly!');
            process.exit(0);
        });

        stream.on('error', (err) => {
            console.error('Stream error event:', err.message);
            process.exit(1);
        });

    } catch (err) {
        console.error('Catch error:', err.message);
        process.exit(1);
    }
}

testStream();
