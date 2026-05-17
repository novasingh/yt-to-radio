const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '../app.log');

function log(message, level = 'INFO') {
    if (process.env.NODE_ENV === 'production') return; // Turn off logs in production

    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(formattedMessage);
    try {
        fs.appendFileSync(logFile, formattedMessage + '\n');
    } catch (err) {
        console.error('Failed to write to log file', err);
    }
}

module.exports = {
    info: (msg) => log(msg, 'INFO'),
    error: (msg) => log(msg, 'ERROR'),
    warn: (msg) => log(msg, 'WARN')
};
