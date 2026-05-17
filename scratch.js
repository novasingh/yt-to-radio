const youtubedl = require('youtube-dl-exec');

async function test() {
    try {
        const url = 'https://www.youtube.com/watch?v=ALeRtAOnJi0';
        console.log('Fetching URL...');
        
        const directUrl = await youtubedl(url, {
            f: 'bestaudio/best',
            getUrl: true
        });
        
        console.log('Direct URL:', directUrl);
    } catch (err) {
        console.error('Error:', err.message);
    }
}

test();
