require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const axios = require('axios');
const chalk = require('chalk');
const config = require('./config.js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

if (!config.bot.token || !config.bot.adminId || !config.sessionSecret) { console.error('ERROR: BOT_TOKEN, ADMIN_ID, dan SESSION_SECRET wajib diatur di .env'); process.exit(1); }
const bot = new Bot(config.bot.token);
const app = express();
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// ==================== DATABASE ====================
const DB_FILE = path.join(__dirname, 'db.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024;
const upload = multer({
  storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, UPLOAD_DIR), filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.zip`) }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => (/\.zip$/i.test(file.originalname || '') || /zip/i.test(file.mimetype || '')) ? cb(null, true) : cb(new Error('File harus berformat ZIP.'))
});
const webJobs = [];
function makeDownloadSignature(filename, expiry) { return crypto.createHmac('sha256', config.sessionSecret).update(`${filename}:${expiry}`).digest('hex'); }
function publicDownloadUrl(filename) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('PUBLIC_BASE_URL belum diatur. Isi dengan URL HTTPS panel yang bisa diakses GitHub Actions.');
  const expiry = Math.floor(Date.now()/1000) + 3600;
  return `${base}/build-files/${encodeURIComponent(filename)}?exp=${expiry}&sig=${makeDownloadSignature(filename, expiry)}`;
}
function safeAppName(value) { return String(value || 'FlutterApp').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0,30) || 'FlutterApp'; }
function safePackageName(value) {
  const normalized = String(value || 'com.web2apk.myapp').toLowerCase().replace(/[^a-z0-9.]/g, '');
  return /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(normalized) ? normalized : 'com.web2apk.myapp';
}
let db = { 
    users: {}, 
    queue: [], 
    building: [], 
    stats: { success: 0, failed: 0 },
    webUsers: {} 
};

if (fs.existsSync(DB_FILE)) {
    try { 
        db = JSON.parse(fs.readFileSync(DB_FILE)); 
    } catch (e) {
        db = { users: {}, queue: [], building: [], stats: { success: 0, failed: 0 }, webUsers: {} };
    }
}
if (!db.webUsers) db.webUsers = {};
if (!db.stats) db.stats = { success: 0, failed: 0 };

function saveDB() { 
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); 
}

// ==================== FUNGSI HELPER ====================
function getProgressBar(p) {
    const f = Math.floor(p / 10);
    return '█'.repeat(f) + '░'.repeat(10 - f);
}

function checkLicense(uid) {
    if (uid.toString() === config.bot.adminId) return true;
    const u = db.users[uid];
    if (!u?.license) return false;
    if (u.license.expiry === 'permanent') return true;
    return Date.now() < u.license.expiry;
}

function calcExpiry(t) {
    const l = config.license[t];
    if (!l) return null;
    if (l.duration === 'permanent') return 'permanent';
    const u = { hour: 3600000, day: 86400000 };
    return Date.now() + (l.duration * u[l.unit]);
}

async function triggerGitHub(uid, name, url, zipUrl = '', options = {}) {
  if (!config.github.token || !config.github.owner || !config.github.repo) { console.error('GitHub configuration incomplete'); return false; }
  const pkg = safePackageName(options.packageName || `com.web2apk.${name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'app'}`);
  try {
    await axios.post(`https://api.github.com/repos/${config.github.owner}/${config.github.repo}/actions/workflows/build.yml/dispatches`, {
      ref: process.env.GITHUB_BRANCH || 'main', inputs: { url: url || '', app_name: safeAppName(name), package_name: pkg, user_id: uid == null ? '' : String(uid), zip_url: zipUrl, build_type: options.buildType === 'debug' ? 'debug' : 'release' }
    }, { headers: { Authorization: `Bearer ${config.github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, timeout: 20000 });
    return true;
  } catch (e) { console.error('GitHub dispatch error:', e.response?.status, e.response?.data || e.message); return false; }
}

async function uploadToGitHub(uid, name, zipId) {
  try {
    const file = await bot.api.getFile(zipId);
    const url = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
    const response = await axios.get(url, { responseType: 'stream', timeout: 120000, maxContentLength: MAX_UPLOAD_BYTES });
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.zip`;
    await new Promise((resolve, reject) => { const out = fs.createWriteStream(path.join(UPLOAD_DIR, filename)); response.data.pipe(out); out.on('finish', resolve); out.on('error', reject); response.data.on('error', reject); });
    return publicDownloadUrl(filename);
  } catch (e) { console.error('Telegram ZIP download failed:', e.message); return null; }
}

// ==================== WEB SERVER SETUP ====================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));

function requireLogin(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}

// Signed temporary download URL used by GitHub Actions runner.
app.get('/build-files/:filename', (req, res) => {
  const filename = path.basename(req.params.filename), expiry = Number(req.query.exp), sig = String(req.query.sig || '');
  const now = Math.floor(Date.now()/1000);
  if (!Number.isFinite(expiry) || expiry < now || expiry > now + 3605) return res.status(403).send('Link download kedaluwarsa.');
  const expected = makeDownloadSignature(filename, expiry), a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return res.status(403).send('Signature tidak valid.');
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('ZIP tidak ditemukan.');
  res.setHeader('Content-Type','application/zip'); res.setHeader('Content-Disposition','attachment; filename="flutter-project.zip"'); res.sendFile(filePath);
});
app.post('/api/build', requireLogin, upload.single('projectZip'), async (req,res) => {
  try {
    if (!req.file) return res.status(400).json({error:'Pilih file ZIP project Flutter.'});
    const appName = safeAppName(req.body.appName || path.basename(req.file.originalname,'.zip'));
    const packageName = safePackageName(req.body.packageName);
    const buildType = req.body.buildType === 'debug' ? 'debug' : 'release';
    const zipUrl = publicDownloadUrl(req.file.filename);
    const job = { id:crypto.randomBytes(6).toString('hex'), name:appName, packageName, buildType, file:req.file.filename, status:'dispatching', createdAt:Date.now(), username:req.session.user.username };
    webJobs.unshift(job);
    const ok = await triggerGitHub(null,appName,'',zipUrl,{packageName,buildType});
    job.status = ok ? 'queued' : 'failed';
    job.message = ok ? 'Workflow dikirim ke GitHub Actions. Periksa Actions → Artifacts untuk APK.' : 'Gagal memicu workflow. Periksa token, repo, branch, dan izin Actions.';
    if (!ok) db.stats.failed++;
    saveDB(); return res.status(ok?202:502).json({id:job.id,status:job.status,message:job.message});
  } catch(e) { console.error('Build upload error:',e.message); return res.status(400).json({error:e.message || 'Upload/build gagal.'}); }
});
app.get('/api/jobs', requireLogin, (req,res) => {
  const jobs = webJobs.filter(j => req.session.user.role === 'owner' || j.username === req.session.user.username).slice(0,20).map(({id,name,buildType,status,createdAt,message})=>({id,name,buildType,status,createdAt,message}));
  res.json({jobs});
});

// ==================== WEB ROUTES ====================
app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.send(`<!DOCTYPE html><html><head><title>Web2APK | GyzenLyoraa</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif}body{background:radial-gradient(circle at top right,#0a1628,#030812);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}.container{max-width:400px;width:100%;background:rgba(10,22,40,0.95);border-radius:30px;padding:40px 30px;border:1px solid #1e3a5f}.logo{text-align:center;margin-bottom:30px}.logo-icon{font-size:50px}.logo-text{font-size:28px;font-weight:700;background:linear-gradient(135deg,#00d4ff,#0099cc);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.btn{display:block;width:100%;padding:16px;background:linear-gradient(135deg,#00d4ff,#0066aa);color:#fff;text-align:center;border-radius:15px;font-weight:600;margin-top:15px;text-decoration:none}.btn-outline{background:transparent;border:1px solid #00d4ff;color:#00d4ff}.info{text-align:center;margin-top:25px;color:#88aacc}.owner{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:20px}.owner-avatar{width:50px;height:50px;background:linear-gradient(135deg,#00d4ff,#0066aa);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px}.owner-name{color:#00d4ff;font-weight:700}</style></head><body><div class="container"><div class="logo"><div class="logo-icon">📱</div><div class="logo-text">Web2APK</div></div><div class="owner"><div class="owner-avatar">K</div><div><span class="owner-name">GyzenLyoraa</span><br><span style="color:#88aacc;font-size:12px">Owner</span></div></div><a href="/login" class="btn">🔐 LOGIN</a><a href="/register" class="btn btn-outline">📝 REGISTER</a><div class="info"><p>📞 aetherotpp<br>📢 @aetherotppp</p></div></div></body></html>`);
});

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    const error = req.query.error ? `<div class="error">❌ ${req.query.error}</div>` : '';
    res.send(`<!DOCTYPE html><html><head><title>Login | Web2APK</title><style>*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif}body{background:radial-gradient(circle at top right,#0a1628,#030812);min-height:100vh;display:flex;justify-content:center;align-items:center}.container{max-width:380px;width:100%;background:rgba(10,22,40,0.95);border-radius:25px;padding:35px 25px;border:1px solid #1e3a5f}h2{color:#00d4ff;margin-bottom:25px;text-align:center}.input-group{margin-bottom:18px}.input-group input{width:100%;padding:15px;background:#0f1a2e;border:1px solid #1e3a5f;border-radius:12px;color:#fff}.btn{width:100%;padding:15px;background:linear-gradient(135deg,#00d4ff,#0066aa);color:#fff;border:none;border-radius:12px;font-weight:600;cursor:pointer}.link{text-align:center;margin-top:20px;color:#88aacc}.link a{color:#00d4ff;text-decoration:none}.error{color:#ff4466;text-align:center;margin-bottom:15px;background:#ff446622;padding:10px;border-radius:10px}</style></head><body><div class="container"><h2>🔐 Login</h2>${error}<form method="POST" action="/login"><div class="input-group"><input type="text" name="username" placeholder="Username" required></div><div class="input-group"><input type="password" name="password" placeholder="Password" required></div><button type="submit" class="btn">MASUK</button></form><div class="link">Belum punya akun? <a href="/register">Register</a></div><div class="link"><a href="/">← Kembali</a></div></div></body></html>`);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.webUsers[username];
    let valid = false;
    if (user && typeof password === 'string') {
        if (String(user.password || '').startsWith('$2')) valid = await bcrypt.compare(password, user.password);
        else if (user.password === password) { valid = true; user.password = await bcrypt.hash(password, 12); saveDB(); }
    }
    if (valid) {
        return req.session.regenerate((err) => {
            if (err) return res.status(500).send('Gagal membuat sesi.');
            req.session.user = { username, role: user.role || 'user' };
            req.session.save(() => res.redirect('/dashboard'));
        });
    }
    res.redirect('/login?error=Username atau password salah');
});

app.get('/register', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Register | Web2APK</title><style>*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif}body{background:radial-gradient(circle at top right,#0a1628,#030812);min-height:100vh;display:flex;justify-content:center;align-items:center}.container{max-width:380px;width:100%;background:rgba(10,22,40,0.95);border-radius:25px;padding:35px 25px;border:1px solid #1e3a5f}h2{color:#00d4ff;margin-bottom:25px;text-align:center}.input-group{margin-bottom:18px}.input-group input{width:100%;padding:15px;background:#0f1a2e;border:1px solid #1e3a5f;border-radius:12px;color:#fff}.btn{width:100%;padding:15px;background:linear-gradient(135deg,#00d4ff,#0066aa);color:#fff;border:none;border-radius:12px;font-weight:600;cursor:pointer}.link{text-align:center;margin-top:20px;color:#88aacc}.link a{color:#00d4ff;text-decoration:none}</style></head><body><div class="container"><h2>📝 Register</h2><form method="POST" action="/register"><div class="input-group"><input type="text" name="username" placeholder="Username" required></div><div class="input-group"><input type="password" name="password" placeholder="Password" required></div><div class="input-group"><input type="text" name="telegram_id" placeholder="Telegram ID (opsional)"></div><button type="submit" class="btn">DAFTAR</button></form><div class="link">Sudah punya akun? <a href="/login">Login</a></div></div></body></html>`);
});

app.post('/register', async (req, res) => {
    const { username, password, telegram_id } = req.body;
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).send('Username 3-32 karakter (huruf/angka/._-), password 8-128 karakter.');
    if (db.webUsers[username]) {
        return res.redirect('/register?error=Username sudah dipakai');
    }
    db.webUsers[username] = { password: await bcrypt.hash(password, 12), telegram_id: typeof telegram_id === 'string' ? telegram_id.slice(0, 40) : '', role: 'user', createdAt: Date.now() };
    saveDB();
    res.redirect('/login?msg=Registrasi berhasil');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ==================== DASHBOARD WEB ====================
app.get('/dashboard', requireLogin, (req, res) => {
    const user = req.session.user;
    const isOwner = (user.username === 'GyzenLyoraa' || user.role === 'owner');
    
    const buildingList = db.building.map(j => `<div class="queue-item">🔄 ${j.name} - Building</div>`).join('');
    const queueList = db.queue.map((j, i) => `<div class="queue-item">⏳ ${j.name} - Antrian #${i+1}</div>`).join('');
    const emptyQueue = db.building.length === 0 && db.queue.length === 0 ? '<div class="queue-item">✨ Tidak ada antrian</div>' : '';
    
    const ownerPanelHtml = isOwner ? `
        <div style="margin-top:30px;padding-top:20px;border-top:1px solid #1e3a5f;">
            <h4 style="color:#00d4ff;margin-bottom:15px;">👑 Owner Panel - GyzenLyotaa</h4>
            <button class="btn" style="width:100%;margin-bottom:10px;" onclick="broadcastTele()">📢 Broadcast Telegram</button>
            <button class="btn" style="width:100%;margin-bottom:10px;background:#1a2a4a;" onclick="broadcastWeb()">🌐 Broadcast Web</button>
            <button class="btn" style="width:100%;margin-bottom:10px;background:#1a2a4a;" onclick="createPremium()">💎 Buat Akun Premium</button>
            <button class="btn" style="width:100%;background:#1a2a4a;" onclick="viewUsers()">👥 List Users</button>
        </div>
    ` : '';
    
    res.send(`<!DOCTYPE html><html><head><title>Dashboard | Web2APK</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',sans-serif}body{background:radial-gradient(circle at top right,#0a1628,#030812);min-height:100vh;padding:20px;color:#fff}.container{max-width:1200px;margin:0 auto}.header{display:flex;justify-content:space-between;align-items:center;padding:20px;background:rgba(10,22,40,0.9);border-radius:20px;margin-bottom:30px;border:1px solid #1e3a5f}.logo{font-size:24px;font-weight:700;color:#00d4ff}.user-info{display:flex;align-items:center;gap:15px}.avatar{width:45px;height:45px;background:linear-gradient(135deg,#00d4ff,#0066aa);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin-bottom:30px}.stat-card{background:rgba(15,26,46,0.8);border-radius:20px;padding:25px;border:1px solid #1e3a5f;text-align:center}.stat-value{font-size:32px;font-weight:700;color:#00d4ff}.main{display:grid;grid-template-columns:1fr 350px;gap:25px}.build-section{background:rgba(15,26,46,0.8);border-radius:25px;padding:30px;border:1px solid #1e3a5f}.upload-area{border:2px dashed #2a4a7a;border-radius:20px;padding:40px;text-align:center;cursor:pointer;margin:20px 0}.upload-area:hover{border-color:#00d4ff;background:rgba(0,212,255,0.05)}.btn{padding:15px 25px;background:linear-gradient(135deg,#00d4ff,#0066aa);color:#fff;border:none;border-radius:15px;font-weight:600;cursor:pointer}.queue-panel{background:rgba(10,18,30,0.95);border-radius:25px;padding:25px;border:1px solid #1e3a5f}.queue-item{padding:12px;background:#0f1a2e;border-radius:12px;margin-bottom:10px}.logout{color:#ff4466;text-decoration:none}</style></head><body><div class="container"><div class="header"><div class="logo">📱 Web2APK Dashboard</div><div class="user-info"><div class="avatar">${user.username.charAt(0).toUpperCase()}</div><div><div style="color:#00d4ff;font-weight:600">${user.username}</div><div style="font-size:12px;color:#88aacc">${isOwner?'Owner':'User'}</div></div><a href="/logout" class="logout" style="margin-left:20px">🚪 Logout</a></div></div><div class="stats"><div class="stat-card"><div class="stat-value">${db.stats.success}</div><div>Build Sukses</div></div><div class="stat-card"><div class="stat-value">${db.stats.failed}</div><div>Build Gagal</div></div><div class="stat-card"><div class="stat-value">${db.queue.length}</div><div>Antrian</div></div><div class="stat-card"><div class="stat-value">${db.building.length}</div><div>Sedang Build</div></div></div><div class="main"><div class="build-section"><h2 style="color:#00d4ff;margin-bottom:20px;">🚀 Build APK dari ZIP</h2><div class="upload-area" onclick="document.getElementById('zipFile').click()"><div style="font-size:48px;">📦</div><div>Klik untuk upload file .zip</div><div id="fileName" style="color:#00d4ff;margin-top:10px;"></div></div><input type="file" id="zipFile" accept=".zip" style="display:none;" onchange="handleFile(this)"><div style="display:flex;gap:10px;"><select id="buildType" style="flex:1;padding:15px;background:#0f1a2e;border:1px solid #1e3a5f;border-radius:15px;color:#fff;"><option value="release">🚀 Release APK</option><option value="debug">🐞 Debug APK</option></select><button class="btn" onclick="startBuild()" style="flex:1;">🔥 BUILD</button></div><div id="progress" style="display:none;margin-top:20px;"><div style="height:10px;background:#1a2a4a;border-radius:10px;"><div id="progressBar" style="width:0%;height:100%;background:linear-gradient(90deg,#00d4ff,#0099cc);border-radius:10px;transition:0.3s;"></div></div><div id="progressText" style="margin-top:10px;color:#88aacc;"></div></div></div><div class="queue-panel"><h3 style="color:#00d4ff;margin-bottom:20px;">📋 Status Antrian</h3><div id="queueList">${buildingList}${queueList}${emptyQueue}</div>${ownerPanelHtml}</div></div></div><script>let selectedFile=null;function handleFile(t){if(t.files[0]){selectedFile=t.files[0];document.getElementById('fileName').textContent=selectedFile.name;}}async function startBuild(){const file=document.getElementById('zipFile').files[0];if(!file){alert('Pilih ZIP project Flutter terlebih dahulu.');return;}const appName=(file.name||'FlutterApp').replace(/\.zip$/i,'').slice(0,30);const fd=new FormData();fd.append('projectZip',file);fd.append('appName',appName);fd.append('packageName','com.web2apk.'+appName.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20));fd.append('buildType',document.getElementById('buildType').value);const prog=document.getElementById('progress');prog.style.display='block';document.getElementById('progressText').textContent='Mengunggah ZIP dan memicu GitHub Actions...';document.getElementById('progressBar').style.width='20%';try{const r=await fetch('/api/build',{method:'POST',body:fd});const d=await r.json();if(!r.ok)throw new Error(d.error||d.message||'Build gagal');document.getElementById('progressBar').style.width='100%';document.getElementById('progressText').textContent=d.message;loadJobs();}catch(e){document.getElementById('progressText').textContent=e.message;alert(e.message);}}
async function loadJobs(){try{const r=await fetch('/api/jobs');if(!r.ok)return;const d=await r.json();if(d.jobs.length)document.getElementById('queueList').innerHTML=d.jobs.map(j=>'<div class="queue-item">📦 '+escapeHtml(j.name)+' — '+escapeHtml(j.status)+'<br><small>'+escapeHtml(j.message||'')+'</small></div>').join('');}catch(e){}}
function escapeHtml(s){return String(s||'').replace(/[&<>"\']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}loadJobs();function broadcastTele(){const e=prompt('📢 Pesan broadcast ke Telegram:');e&&alert('✅ Broadcast Telegram dikirim!');}function broadcastWeb(){const e=prompt('🌐 Pesan broadcast ke Web:');e&&alert('✅ Broadcast Web dikirim!');}function createPremium(){const e=prompt('💎 Masukkan username untuk akun premium:');e&&alert('✅ Akun premium '+e+' berhasil dibuat!');}function viewUsers(){alert('👥 Users:\\n• GyzenLyoraa (Owner)\\n• user1 (Premium)\\n• user2 (Free)');}</script></body></html>`);
});

// ==================== BOT TELEGRAM ====================
async function checkJoinChannel(ctx, next) {
    const uid = ctx.from.id;
    if (uid.toString() === config.bot.adminId) return next();
    if (db.users[uid]?.verified) return next();
    return sendVerificationMessage(ctx);
}

function sendVerificationMessage(ctx) {
    let pt = '';
    Object.entries(config.license).forEach(([t, d]) => {
        pt += `• ${t} - ${d.duration === 'permanent' ? 'Permanen' : d.duration + (d.unit === 'hour' ? 'H' : '')}\n`;
    });
    const kb = new InlineKeyboard()
        .url('📢 Join', config.verification.channelUrl)
        .row()
        .text('✅ Saya Sudah Join', 'verify_join');
    return ctx.reply(
        `⚠️ <b>Verifikasi</b>\n\n` +
        `Join: @${config.verification.channelUsername}\n\n` +
        `${pt}\nHubungi ${config.contact.owner}`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
}

bot.callbackQuery('verify_join', async (ctx) => {
    const uid = ctx.from.id;
    if (!db.users[uid]) db.users[uid] = { id: uid };
    db.users[uid].verified = true;
    saveDB();
    await ctx.answerCallbackQuery({ text: '✅ Berhasil!' });
    await ctx.editMessageText('✅ <b>Verifikasi Berhasil!</b>\n\nKetik /start', { parse_mode: 'HTML' });
});

bot.command('start', checkJoinChannel, async (ctx) => {
    const uid = ctx.from.id;
    if (!checkLicense(uid)) return sendVerificationMessage(ctx);
    ctx.reply(
        `W9April2APK\nSelamat Datang, '${ctx.from.first_name || 'User'}'\n\n` +
        `<b>Web2Apk Pro</b>\n${config.texts.features}`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    ['📱 BUAT APLIKASI', '📦 BUILD PROJECT'],
                    ['📊 Cek Antrian', '❓ Bantuan']
                ],
                resize_keyboard: true
            }
        }
    );
});

bot.command('register', async (ctx) => {
    const uid = ctx.from.id;
    const args = ctx.message.text.split(' ');
    const username = args[1];
    const password = args[2];
    
    if (!username || !password) {
        return ctx.reply('❌ Format: /register <username> <password>');
    }
    
    if (db.webUsers[username]) {
        return ctx.reply('❌ Username sudah dipakai!');
    }
    
    db.webUsers[username] = {
        password: password,
        telegram_id: uid,
        role: 'user',
        createdAt: Date.now()
    };
    saveDB();
    
    ctx.reply(`✅ Akun berhasil dibuat!\n\nUsername: ${username}\n\nLogin di web: ${config.web?.url || 'http://panel:3000'}`);
});

bot.hears('📱 BUAT APLIKASI', async (ctx) => {
    if (!checkLicense(ctx.from.id)) return ctx.reply('⚠️ Tidak premium');
    if (!db.users[ctx.from.id]) db.users[ctx.from.id] = { id: ctx.from.id };
    db.users[ctx.from.id].step = 'waiting_url';
    saveDB();
    ctx.reply('🔗 Kirim URL website (https://...)', { parse_mode: 'HTML' });
});

bot.hears('📦 BUILD PROJECT', async (ctx) => {
    if (!checkLicense(ctx.from.id)) return ctx.reply('⚠️ Tidak premium');
    const kb = new InlineKeyboard()
        .text('💙 Flutter', 'project_flutter')
        .row()
        .text('❌ Batal', 'project_cancel');
    ctx.reply('📦 Pilih jenis project:', { reply_markup: kb });
});

bot.callbackQuery('project_flutter', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!db.users[ctx.from.id]) db.users[ctx.from.id] = { id: ctx.from.id };
    db.users[ctx.from.id].step = 'waiting_zip';
    saveDB();
    ctx.reply('📁 Kirim file .zip project Flutter Anda.', { parse_mode: 'HTML' });
});

bot.callbackQuery('project_cancel', async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.reply('❌ Dibatalkan');
});

bot.on(':document', async (ctx) => {
    const u = db.users[ctx.from.id];
    if (!u || u.step !== 'waiting_zip') return;
    const doc = ctx.message.document;
    if (!/\.zip$/i.test(doc.file_name || '')) return ctx.reply('❌ Hanya .zip');
    if (doc.file_size && doc.file_size > MAX_UPLOAD_BYTES) return ctx.reply(`❌ ZIP maksimal ${Math.floor(MAX_UPLOAD_BYTES/1024/1024)} MB.`);
    u.zipFile = doc.file_id;
    u.appName = doc.file_name.replace('.zip', '');
    u.step = null;
    saveDB();
    ctx.reply('✅ ZIP diterima! Build dimulai...');
    addToQueue(ctx.from.id, u.appName, null, 'flutter', doc.file_id);
});

bot.on(':text', async (ctx) => {
    const u = db.users[ctx.from.id];
    const txt = ctx.message.text;
    
    if (!u?.step) {
        if (txt === '📊 Cek Antrian') {
            ctx.reply(`📊 Queue: ${db.queue.length}\n✅ ${db.stats.success} | ❌ ${db.stats.failed}`);
        }
        if (txt === '❓ Bantuan') {
            ctx.reply(`📖 Panduan:\n1. BUAT APLIKASI\n2. Masukkan URL\n3. Masukkan Nama\n\n📌 ${config.contact.support}`);
        }
        return;
    }
    
    if (u.step === 'waiting_url') {
        if (!txt.startsWith('http')) return ctx.reply('❌ http/https');
        u.url = txt;
        u.step = 'waiting_name';
        saveDB();
        ctx.reply('📝 Nama aplikasi:');
    } else if (u.step === 'waiting_name') {
        u.appName = txt.substring(0, 30);
        u.step = null;
        saveDB();
        ctx.reply(`✅ Build ${u.appName} dimulai!`);
        addToQueue(ctx.from.id, u.appName, u.url, 'url');
    } else if (u.step === 'waiting_broadcast_tele') {
        u.step = null; saveDB();
        const ids = Object.keys(db.users); let s = 0, f = 0;
        for (const id of ids) { try { await bot.api.sendMessage(id, txt, { parse_mode: 'HTML' }); s++; } catch (e) { f++; } }
        ctx.reply(`✅ Broadcast Telegram selesai!\n✅ ${s} | ❌ ${f}`);
    } else if (u.step === 'waiting_broadcast_web') {
        u.step = null; saveDB();
        ctx.reply(`✅ Broadcast Web selesai!\nPesan: ${txt}`);
    } else if (u.step === 'waiting_create_premium') {
        const args = txt.split(' '); const username = args[0]; const tier = args[1] || '15K';
        if (!username) return ctx.reply('❌ Format: username tier (2K/5K/10K/15K)');
        if (!config.license[tier]) return ctx.reply('❌ Tier invalid!');
        if (!db.webUsers[username]) db.webUsers[username] = { password: 'premium123', role: 'premium' };
        db.webUsers[username].role = 'premium';
        db.webUsers[username].premium_tier = tier;
        u.step = null; saveDB();
        ctx.reply(`✅ Akun premium ${username} (${tier}) berhasil dibuat!`);
    } else if (u.step === 'waiting_editharga') {
        const a = txt.split(' '); const tier = a[0]; const dur = a[1]; const unit = a[2];
        if (!tier || !config.license[tier]) return ctx.reply('❌ Tier invalid');
        if (dur === 'permanent') config.license[tier] = { duration: 'permanent', unit: null };
        else if (dur && unit) config.license[tier] = { duration: parseInt(dur), unit };
        else return ctx.reply('❌ Format: 2K 1 hour / 15K permanent');
        u.step = null; saveDB();
        ctx.reply(`✅ Harga ${tier} diupdate!`);
    }
});

// ==================== OWNER MENU LENGKAP ====================
bot.command('ownermenu', async (ctx) => {
    if (ctx.from.id.toString() !== config.bot.adminId) return;
    
    const totalUsers = Object.keys(db.users).length;
    const totalWebUsers = Object.keys(db.webUsers).length;
    const premiumUsers = Object.values(db.users).filter(u => checkLicense(u.id)).length;
    
    const kb = new InlineKeyboard()
        .text('📢 Broadcast Telegram', 'owner_broadcast_tele')
        .text('🌐 Broadcast Web', 'owner_broadcast_web').row()
        .text('👥 List Premium', 'owner_listpremium')
        .text('💎 Buat Akun Premium', 'owner_create_premium').row()
        .text('💰 Edit Harga', 'owner_editharga')
        .text('📊 Stats', 'owner_stats').row()
        .text('🔄 Refresh', 'owner_refresh');
    
    ctx.reply(
        `╔═══════════════════════════════╗\n     👑 OWNER MENU - DINXZ OFFCIAL 👑\n╚═══════════════════════════════╝\n\n` +
        `<b>📊 Statistik:</b>\n• User Telegram: ${totalUsers}\n• User Web: ${totalWebUsers}\n• Premium: ${premiumUsers}\n• Antrian: ${db.queue.length}\n• Building: ${db.building.length}\n\n` +
        `<b>✅ Sukses:</b> ${db.stats.success} | <b>❌ Gagal:</b> ${db.stats.failed}`,
        { parse_mode: 'HTML', reply_markup: kb }
    );
});

bot.callbackQuery('owner_refresh', async (ctx) => { await ctx.answerCallbackQuery(); ctx.reply('/ownermenu'); });
bot.callbackQuery('owner_stats', async (ctx) => { await ctx.answerCallbackQuery(); ctx.reply(`📊 Stats\n✅ ${db.stats.success} | ❌ ${db.stats.failed}`); });
bot.callbackQuery('owner_listpremium', async (ctx) => { await ctx.answerCallbackQuery(); const u = Object.entries(db.users).filter(([_,d])=>checkLicense(d.id)).map(([id,d])=>`• ${id} - ${d.license?.tier}`).join('\n'); ctx.reply(`👥 Premium:\n${u||'Kosong'}`); });

bot.callbackQuery('owner_broadcast_tele', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!db.users[ctx.from.id]) db.users[ctx.from.id] = { id: ctx.from.id };
    db.users[ctx.from.id].step = 'waiting_broadcast_tele'; saveDB();
    ctx.reply('📢 Kirim pesan broadcast Telegram:');
});

bot.callbackQuery('owner_broadcast_web', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!db.users[ctx.from.id]) db.users[ctx.from.id] = { id: ctx.from.id };
    db.users[ctx.from.id].step = 'waiting_broadcast_web'; saveDB();
    ctx.reply('🌐 Kirim pesan broadcast Web:');
});

bot.callbackQuery('owner_create_premium', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!db.users[ctx.from.id]) db.users[ctx.from.id] = { id: ctx.from.id };
    db.users[ctx.from.id].step = 'waiting_create_premium'; saveDB();
    ctx.reply('💎 Kirim: username tier (2K/5K/10K/15K)\nContoh: user1 15K');
});

bot.callbackQuery('owner_editharga', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!db.users[ctx.from.id]) db.users[ctx.from.id] = { id: ctx.from.id };
    db.users[ctx.from.id].step = 'waiting_editharga'; saveDB();
    ctx.reply('💰 Format: 2K 1 hour / 15K permanent');
});

// ==================== QUEUE SYSTEM ====================
function addToQueue(uid, name, url, type, zipId = null) {
    const job = { userId: uid, name, url, type, zipId, start: Date.now() };
    if (db.building.length < config.server.maxConcurrent) { db.building.push(job); processBuild(job); }
    else { db.queue.push(job); bot.api.sendMessage(uid, `📋 Antrian #${db.queue.length} (~${db.queue.length * 2} menit)`, { parse_mode: 'HTML' }); }
    saveDB();
}

async function processBuild(job) {
  const {userId,name,url,type,zipId}=job; let msg;
  try {
    msg=await bot.api.sendMessage(userId,`🚀 <b>Menyiapkan build ${name}</b>\nMengirim project ke GitHub Actions...`,{parse_mode:'HTML'});
    let zipUrl=''; if(zipId){zipUrl=await uploadToGitHub(userId,name,zipId);if(!zipUrl)throw new Error('Gagal mengunduh ZIP Telegram atau membuat link sementara.');}
    const ok=await triggerGitHub(userId,name,url,zipUrl,{buildType:'release'});
    if(!ok)throw new Error('GitHub Actions gagal dipicu. Periksa GITHUB_TOKEN, repository, branch, workflow, dan izin Actions.');
    db.stats.success++;
    await bot.api.editMessageText(msg.chat.id,msg.message_id,`📨 <b>Build dikirim ke GitHub Actions.</b>\nNama: ${name}\nStatus ini belum berarti APK selesai. Buka repository → Actions → pilih workflow → Artifacts untuk mengunduh APK.`,{parse_mode:'HTML'});
  } catch(e) { db.stats.failed++; console.error('Build failed:',e.message); if(msg){try{await bot.api.editMessageText(msg.chat.id,msg.message_id,`❌ ${e.message}`);}catch(_){}}else{try{await bot.api.sendMessage(userId,`❌ ${e.message}`);}catch(_){}} }
  finally { db.building=db.building.filter(j=>j!==job); if(db.queue.length){const n=db.queue.shift();db.building.push(n);void processBuild(n);} saveDB(); }
}

bot.command('addlic', async (ctx) => {
    if (ctx.from.id.toString() !== config.bot.adminId) return;
    const a = ctx.message.text.split(' '), t = a[1], tier = a[2];
    if (!t || !tier) return ctx.reply('❌ /addlic <id> <tier>');
    const exp = calcExpiry(tier); if (!db.users[t]) db.users[t] = { id: t };
    db.users[t].license = { tier, expiry: exp }; saveDB();
    ctx.reply(`✅ License ${tier} ke ${t}`);
});

bot.command('cancel', async (ctx) => {
    if (db.users[ctx.from.id]?.step) { db.users[ctx.from.id].step = null; saveDB(); ctx.reply('❌ Dibatalkan'); }
    else ctx.reply('Tidak ada proses.');
});

app.get('/health', (_req,res)=>res.json({ok:true,service:'web2apk-builder'}));
app.use((err,req,res,next)=>{if(res.headersSent)return next(err);console.error('HTTP error:',err.message);res.status(err instanceof multer.MulterError ? 400 : 500).json({error:err instanceof multer.MulterError && err.code==='LIMIT_FILE_SIZE' ? `File terlalu besar. Batas ${Math.floor(MAX_UPLOAD_BYTES/1024/1024)} MB.` : err.message || 'Terjadi kesalahan server.'});});
// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(chalk.cyan(`🌐 Web: ${PORT}`)));
bot.start().catch((err) => { console.error('Telegram bot gagal start:', err.message); process.exitCode = 1; });
console.log(chalk.green('┌────────────────────────────────────┐'));
console.log(chalk.green('│   WEB2APK BOT + WEB + OWNER MENU   │'));
console.log(chalk.green('│            DINXZ OWNER            │'));
console.log(chalk.green('└────────────────────────────────────┘'));
console.log(chalk.cyan('🚀 Bot & Web siap!'));