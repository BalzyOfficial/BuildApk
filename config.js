require('dotenv').config();
module.exports = {
 bot: { token: process.env.BOT_TOKEN || '', adminId: process.env.ADMIN_ID || '' },
 github: { token: process.env.GITHUB_TOKEN || '', owner: process.env.GITHUB_OWNER || '', repo: process.env.GITHUB_REPO || '' },
 license: { '2K': {duration:1,unit:'hour'}, '5K': {duration:7,unit:'hour'}, '10K': {duration:12,unit:'hour'}, '15K': {duration:'permanent',unit:null} },
 server: {maxConcurrent:5,buildTimeout:600000,tempDir:'./temp'},
 verification: {enabled:process.env.VERIFICATION_ENABLED !== 'false',channelUsername:process.env.CHANNEL_USERNAME || 'your_channel',channelUrl:process.env.CHANNEL_URL || 'https://t.me/your_channel'},
 contact: {owner:process.env.OWNER_CONTACT || '@your_username',support:process.env.SUPPORT_CONTACT || '@your_support'},
 web: {url:process.env.WEB_URL || 'http://localhost:3000'},
 sessionSecret:process.env.SESSION_SECRET || '',
 texts: {welcome:'Web2APK Builder\nSelamat Datang, {name}!',features:'Build Flutter APK melalui GitHub Actions.'}
};
