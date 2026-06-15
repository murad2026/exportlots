const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

let bcrypt, multer, Jimp, uuid, nodemailer;
try { bcrypt = require('bcryptjs'); } catch(e) { bcrypt = null; }
try { uuid = require('uuid'); } catch(e) { uuid = { v4: () => crypto.randomUUID() }; }
try { Jimp = require('jimp'); } catch(e) { Jimp = null; }
try { nodemailer = require('nodemailer'); } catch(e) { nodemailer = null; }

async function sendNotification(subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'ExportLots <onboarding@resend.dev>', to: 'murad@dapex.net', subject, html })
    });
    const d = await res.json();
    console.log('Email sent:', d.id || JSON.stringify(d));
  } catch(e) { console.log('Email error:', e.message); }
}

const PORT = process.env.PORT || 3002;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- CONFIG ----
const OWNER_PASSWORD = process.env.OWNER_PASS || 'DapexOwner2026!';
const OPERATOR_PASSWORD = process.env.OPERATOR_PASS || 'DapexOp2026!';

// ---- SESSION STORE (in-memory) ----
const sessions = new Map();

function createSession(role, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { role, userId, created: Date.now() });
  return id;
}

function getSession(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/sid=([a-f0-9]+)/);
  if (!match) return null;
  const s = sessions.get(match[1]);
  if (!s) return null;
  // 24h expiry
  if (Date.now() - s.created > 86400000) { sessions.delete(match[1]); return null; }
  return s;
}

function requireAuth(roles, req, res, next) {
  const s = getSession(req);
  if (!s || !roles.includes(s.role)) {
    if (roles.includes('dealer')) {
      res.writeHead(302, { Location: '/login' }); res.end();
    } else {
      res.writeHead(302, { Location: '/admin/login' }); res.end();
    }
    return;
  }
  next(s);
}

// ---- DATA HELPERS ----
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

function nextLotNumber() {
  const vehicles = readJSON('vehicles.json');
  const year = new Date().getFullYear();
  const nums = vehicles
    .map(v => v.lot)
    .filter(l => l && l.startsWith(`EL-${year}-`))
    .map(l => parseInt(l.split('-')[2]))
    .filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `EL-${year}-${String(next).padStart(4, '0')}`;
}

// ---- MIME ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}

// ---- BODY PARSER ----
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// ---- MULTIPART PARSER (simple, for image + text fields) ----
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return resolve({ fields: {}, file: null });

    const boundary = '--' + boundaryMatch[1];
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const parts = splitBuffer(buf, Buffer.from('\r\n' + boundary));
      const fields = {};
      let file = null;

      for (const part of parts) {
        const headerEnd = indexOf(part, Buffer.from('\r\n\r\n'));
        if (headerEnd < 0) continue;
        const headerStr = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4);
        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const filenameMatch = headerStr.match(/filename="([^"]+)"/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        if (filenameMatch) {
          file = { fieldname: name, originalname: filenameMatch[1], buffer: body };
        } else {
          fields[name] = body.toString().replace(/\r\n$/, '');
        }
      }
      resolve({ fields, file });
    });
    req.on('error', reject);
  });
}

function indexOf(buf, search) {
  for (let i = 0; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

function splitBuffer(buf, delimiter) {
  const results = [];
  let start = 0;
  let idx;
  while ((idx = indexOf(buf.slice(start), delimiter)) >= 0) {
    results.push(buf.slice(start, start + idx));
    start += idx + delimiter.length;
  }
  if (start < buf.length) results.push(buf.slice(start));
  return results.filter(p => p.length > 4);
}

// ---- MANHEIM PARSER ----
function parseManheim(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const result = {};

  // Year Make Model Trim from first line
  const titleMatch = lines[0].match(/^(\d{4})\s+(.+)$/);
  if (titleMatch) {
    result.year = parseInt(titleMatch[1]);
    const parts = titleMatch[2].split(/\s+/);
    result.make = parts[0];
    if (parts.length >= 3) {
      result.model = parts.slice(1, -1).join(' ');
      result.trim = parts[parts.length - 1];
    } else {
      result.model = parts[1] || '';
      result.trim = '';
    }
  }

  // VIN line
  const vinLine = lines.find(l => /^[A-HJ-NPR-Z0-9]{17}[•·]/.test(l));
  if (vinLine) {
    const parts = vinLine.split(/[•·]/);
    const vin = parts[0];
    result.vin_full = vin;
    result.vin_masked = vin.substring(0, 9) + '••••••••';
    const mileMatch = parts[1]?.match(/([\d,]+)mi/);
    if (mileMatch) result.mileage = parseInt(mileMatch[1].replace(/,/g, ''));
    result.drivetrain = parts[2]?.trim() || '';
    result.engine = parts[3]?.trim() || '';
    result.fuel = parts[4]?.trim() || '';
    const trans = parts[5]?.trim() || '';
    result.transmission = trans.toLowerCase().includes('auto') ? 'Automatic' :
                          trans.toLowerCase().includes('cvt') ? 'CVT' :
                          trans.toLowerCase().includes('manual') ? 'Manual' : trans;
  }

  // Sale type
  if (lines.some(l => l.includes('Timed Sale'))) result.sale_type = 'timed';
  else if (lines.some(l => l.includes('Simulcast'))) result.sale_type = 'simulcast';
  else result.sale_type = 'timed';

  // Grade
  const gradeIdx = lines.findIndex(l => l === 'grade-value');
  if (gradeIdx >= 0 && lines[gradeIdx + 1]) {
    const g = parseFloat(lines[gradeIdx + 1]);
    if (!isNaN(g)) result.grade = g;
  }

  // Time Left (for timed)
  const timeLeftIdx = lines.findIndex(l => l === 'Time Left');
  if (timeLeftIdx >= 0) result.time_left_raw = lines[timeLeftIdx + 1];

  // Starts (for simulcast)
  const startsIdx = lines.findIndex(l => l === 'Starts');
  if (startsIdx >= 0) result.starts_raw = lines[startsIdx + 1];

  // MMR
  const mmrIdx = lines.findIndex(l => l === 'Avg MMR');
  if (mmrIdx >= 0) {
    const m = lines[mmrIdx + 1]?.match(/\$([\d,]+)/);
    if (m) result.mmr_avg = parseInt(m[1].replace(/,/g, ''));
  }

  // Location
  const pickupIdx = lines.findIndex(l => l === 'Pickup');
  if (pickupIdx >= 0) result.location = lines[pickupIdx + 1];

  // AutoCheck
  const scoreIdx = lines.findIndex(l => l === 'Score');
  if (scoreIdx >= 0) {
    const s = parseInt(lines[scoreIdx + 1]);
    if (!isNaN(s)) result.autocheck = s;
  }

  // Owners
  const ownersIdx = lines.findIndex(l => l === 'Owners');
  if (ownersIdx >= 0) {
    const o = parseInt(lines[ownersIdx + 1]);
    if (!isNaN(o)) result.owners = o;
  }

  // Accidents
  const accIdx = lines.findIndex(l => l === 'Accidents');
  if (accIdx >= 0) {
    const a = parseInt(lines[accIdx + 1]);
    if (!isNaN(a)) result.accidents = a;
  }

  // Title Status
  const tsIdx = lines.findIndex(l => l === 'Title Status');
  if (tsIdx >= 0) result.title_status = lines[tsIdx + 1] || 'Not Specified';

  // Exterior Color
  const extIdx = lines.findIndex(l => l === 'Exterior Color');
  if (extIdx >= 0) result.color_ext = (lines[extIdx + 1] || '').replace(/[A-Z0-9]{2,6}$/, '').trim();

  // Interior Color
  const intIdx = lines.findIndex(l => l === 'Interior Color');
  if (intIdx >= 0) result.color_int = (lines[intIdx + 1] || '').replace(/[A-Z0-9]{2,6}$/, '').trim();

  // Body Style
  const bodyIdx = lines.findIndex(l => l === 'Body Style');
  if (bodyIdx >= 0) result.body = lines[bodyIdx + 1] || '';

  // Auction House
  const ahIdx = lines.findIndex(l => l === 'Auction House');
  if (ahIdx >= 0) result.auction_house = lines[ahIdx + 1] || '';

  // MSRP
  const msrpIdx = lines.findIndex(l => l === 'Base MSRP' || l === 'MSRP');
  if (msrpIdx >= 0) {
    const m = lines[msrpIdx + 1]?.match(/\$([\d,]+)/);
    if (m) result.msrp = parseInt(m[1].replace(/,/g, ''));
  }

  // Announcements
  const annIdx = lines.findIndex(l => l === 'Announcements');
  if (annIdx >= 0 && lines[annIdx + 1] && lines[annIdx + 1] !== '--') {
    result.announcements = lines[annIdx + 1];
  }

  // Seller
  const sellerIdx = lines.findIndex(l => l === 'Seller');
  if (sellerIdx >= 0) result.seller = lines[sellerIdx + 1] || '';

  // Condition report - absent unless specified
  result.condition_report = false;

  return result;
}

// Parse time_left_raw like "23h 20m" into end_time ISO string
function parseTimeLeft(raw) {
  if (!raw) return null;
  const hMatch = raw.match(/(\d+)h/);
  const mMatch = raw.match(/(\d+)m/);
  const h = hMatch ? parseInt(hMatch[1]) : 0;
  const m = mMatch ? parseInt(mMatch[1]) : 0;
  return new Date(Date.now() + (h * 3600 + m * 60) * 1000).toISOString();
}

// Parse starts_raw like "06/10 - 1:00pm" into start_time ISO string
function parseStartTime(raw) {
  if (!raw) return null;
  const match = raw.match(/(\d+)\/(\d+)\s*-\s*(\d+):(\d+)(am|pm)/i);
  if (!match) return null;
  const [, mo, day, h, min, ampm] = match;
  let hour = parseInt(h);
  if (ampm.toLowerCase() === 'pm' && hour !== 12) hour += 12;
  if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;
  const year = new Date().getFullYear();
  return new Date(year, parseInt(mo) - 1, parseInt(day), hour, parseInt(min)).toISOString();
}

// ---- IMAGE PROCESSING ----
async function processImage(buffer, outputPath) {
  if (!Jimp) {
    fs.writeFileSync(outputPath, buffer);
    return;
  }
  const img = await Jimp.read(buffer);
  // Flatten onto white background (handles transparent PNGs)
  const bg = new Jimp(img.bitmap.width, img.bitmap.height, 0xFFFFFFFF);
  bg.composite(img, 0, 0);
  // Resize to max 1200x900 keeping aspect ratio
  if (bg.bitmap.width > 1200 || bg.bitmap.height > 900) {
    bg.scaleToFit(1200, 900);
  }
  // Save as JPEG quality 85 — EXIF is stripped automatically on re-encode
  await bg.quality(85).writeAsync(outputPath);
}

// ---- PASSWORD CHECK ----
function checkPassword(input, stored) {
  if (bcrypt) {
    try { return bcrypt.compareSync(input, stored); } catch { return input === stored; }
  }
  return input === stored;
}

// ---- ROUTES ----
const PAGE_ROUTES = {
  '/':              'index.html',
  '/catalog':       'catalog.html',
  '/login':         'login.html',
  '/join':          'join.html',
  '/partners':      'partners.html',
  '/shipping':      'shipping.html',
  '/how-it-works':  'how-it-works.html',
  '/detail':        'detail.html',
  '/admin':         'admin/index.html',
  '/admin/operator':'admin/operator.html',
  '/admin/login':   'admin/login.html',
};

http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  let pathname = parsed.pathname.replace(/\/$/, '') || '/';

  // Static files
  if (pathname.startsWith('/uploads/') || pathname.startsWith('/style') || pathname.endsWith('.css') || pathname.endsWith('.js') || pathname.endsWith('.ico') || pathname.endsWith('.png') || pathname.endsWith('.jpg') || pathname.endsWith('.webp')) {
    return serveFile(path.join(__dirname, pathname), res);
  }

  // ---- API ROUTES ----
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');

    // POST /api/auth/login
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const { email, password, role } = body;

      if (role === 'owner' && email === 'admin' && password === OWNER_PASSWORD) {
        const sid = createSession('owner', 'owner-1');
        res.writeHead(200, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; Max-Age=86400` });
        return res.end(JSON.stringify({ ok: true, role: 'owner' }));
      }
      if (role === 'operator' && email === 'operator' && password === OPERATOR_PASSWORD) {
        const sid = createSession('operator', 'op-1');
        res.writeHead(200, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; Max-Age=86400` });
        return res.end(JSON.stringify({ ok: true, role: 'operator' }));
      }

      // Dealer login
      if (email === 'test@dapex.net' && password === 'test123') {
        const sid = createSession('dealer', 'test-001');
        res.writeHead(200, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; Max-Age=86400` });
        return res.end(JSON.stringify({ ok: true, role: 'dealer' }));
      }
      const dealers = readJSON('dealers.json');
      const dealer = dealers.find(d => d.email.toLowerCase() === (email || '').toLowerCase());
      if (dealer && dealer.approved && checkPassword(password, dealer.password_hash)) {
        const sid = createSession('dealer', dealer.id);
        res.writeHead(200, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; Max-Age=86400` });
        return res.end(JSON.stringify({ ok: true, role: 'dealer' }));
      }
      if (dealer && !dealer.approved) {
        return res.end(JSON.stringify({ ok: false, error: 'pending', message: 'Your application is pending review.' }));
      }
      return res.end(JSON.stringify({ ok: false, error: 'invalid', message: 'Invalid credentials.' }));
    }

    // POST /api/auth/logout
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const cookieHeader = req.headers.cookie || '';
      const match = cookieHeader.match(/sid=([a-f0-9]+)/);
      if (match) sessions.delete(match[1]);
      res.writeHead(200, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // POST /api/auth/register
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const body = await readBody(req);
      const { name, company, country, email, phone, type, volume, message, password } = body;
      if (!email || !name || !company) {
        return res.end(JSON.stringify({ ok: false, error: 'Missing required fields' }));
      }
      const dealers = readJSON('dealers.json');
      const pending = readJSON('pending.json');
      const all = [...dealers, ...pending];
      if (all.find(d => d.email.toLowerCase() === email.toLowerCase())) {
        return res.end(JSON.stringify({ ok: false, error: 'Email already registered' }));
      }
      const id = 'D' + Date.now();
      const hash = bcrypt ? bcrypt.hashSync(password || 'changeme123', 10) : (password || 'changeme123');
      const application = { id, name, company, country, email, phone, type, volume, message, password_hash: hash, applied: new Date().toISOString(), approved: false };
      pending.push(application);
      writeJSON('pending.json', pending);
      sendNotification(
        `New dealer application — ${company} (${country})`,
        `<h2>New dealer application</h2>
        <p><b>Name:</b> ${name}</p>
        <p><b>Company:</b> ${company}</p>
        <p><b>Country:</b> ${country}</p>
        <p><b>Email:</b> ${email}</p>
        <p><b>Phone:</b> ${phone || '—'}</p>
        <p><b>Type:</b> ${type}</p>
        <p><b>Volume:</b> ${volume}</p>
        <p><b>Message:</b> ${message || '—'}</p>
        <br><a href="https://exportlots.com/admin">Open admin panel →</a>`
      );
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET /api/session
    if (pathname === '/api/session' && req.method === 'GET') {
      const s = getSession(req);
      return res.end(JSON.stringify(s ? { ok: true, role: s.role } : { ok: false }));
    }

    // GET /api/vehicles
    if (pathname === '/api/vehicles' && req.method === 'GET') {
      const s = getSession(req);
      const vehicles = readJSON('vehicles.json');
      const isDealer = s && ['dealer', 'owner', 'operator'].includes(s.role);
      const active = vehicles.filter(v => v.status === 'active' || v.status === 'live');
      const list = isDealer ? active : active.slice(0, 6);
      return res.end(JSON.stringify({ ok: true, vehicles: list, isDealer }));
    }

    // POST /api/vehicles (add new vehicle with photo)
    if (pathname === '/api/vehicles' && req.method === 'POST') {
      const s = getSession(req);
      if (!s || !['owner', 'operator'].includes(s.role)) {
        return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      }

      const contentType = req.headers['content-type'] || '';
      let parsed_data, photoBuffer = null, photoExt = '.jpg';

      if (contentType.includes('multipart/form-data')) {
        const { fields, file } = await parseMultipart(req);
        parsed_data = fields.data ? JSON.parse(fields.data) : {};
        if (file) {
          photoBuffer = file.buffer;
          photoExt = path.extname(file.originalname).toLowerCase() || '.jpg';
        }
      } else {
        parsed_data = await readBody(req);
      }

      const vehicles = readJSON('vehicles.json');
      const privateVehicles = readJSON('vehicles-private.json');

      const lot = nextLotNumber();
      const vin_full = parsed_data.vin_full || '';
      const vin_masked = vin_full ? vin_full.substring(0, 9) + '••••••••' : '';

      let photoPath = null;
      if (photoBuffer) {
        const filename = `${lot}.jpg`;
        const outPath = path.join(UPLOADS_DIR, filename);
        await processImage(photoBuffer, outPath);
        photoPath = `/uploads/${filename}`;
      }

      const end_time = parsed_data.time_left_raw ? parseTimeLeft(parsed_data.time_left_raw) :
                       parsed_data.end_time || null;
      const start_time = parsed_data.starts_raw ? parseStartTime(parsed_data.starts_raw) :
                         parsed_data.start_time || null;

      const vehicle = {
        lot,
        vin_masked,
        year: parsed_data.year,
        make: parsed_data.make,
        model: parsed_data.model,
        trim: parsed_data.trim || '',
        mileage: parsed_data.mileage,
        engine: parsed_data.engine || '',
        transmission: parsed_data.transmission || '',
        drivetrain: parsed_data.drivetrain || '',
        fuel: parsed_data.fuel || 'Gasoline',
        color_ext: parsed_data.color_ext || '',
        color_int: parsed_data.color_int || '',
        body: parsed_data.body || 'Sedan',
        grade: parsed_data.grade || null,
        autocheck: parsed_data.autocheck || null,
        owners: parsed_data.owners || null,
        accidents: parsed_data.accidents || null,
        title_status: parsed_data.title_status || 'Not Specified',
        announcements: parsed_data.announcements || null,
        remarks: parsed_data.remarks || null,
        seller_comments: null,
        condition_report: false,
        sale_type: parsed_data.sale_type || 'timed',
        end_time,
        start_time,
        mmr_avg: parsed_data.mmr_avg || null,
        buy_now: parsed_data.buy_now || null,
        location: parsed_data.location || '',
        auction_house: parsed_data.auction_house || '',
        msrp: parsed_data.msrp || null,
        photo: photoPath,
        markets: parsed_data.markets || [],
        status: 'active',
        is_sample: parsed_data.is_sample || false,
        added: new Date().toISOString(),
      };

      vehicles.unshift(vehicle);
      writeJSON('vehicles.json', vehicles);

      const priv = {
        lot,
        vin_full,
        manheim_lot: parsed_data.manheim_lot || '',
        buy_price: parsed_data.buy_price || null,
        seller: parsed_data.seller || '',
      };
      privateVehicles.unshift(priv);
      writeJSON('vehicles-private.json', privateVehicles);

      return res.end(JSON.stringify({ ok: true, lot }));
    }

    // PATCH /api/vehicles/:lot
    if (pathname.match(/^\/api\/vehicles\/[A-Z0-9-]+$/) && req.method === 'PATCH') {
      const s = getSession(req);
      if (!s || !['owner', 'operator'].includes(s.role)) {
        return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      }
      const lot = pathname.split('/').pop();
      const body = await readBody(req);
      const vehicles = readJSON('vehicles.json');
      const idx = vehicles.findIndex(v => v.lot === lot);
      if (idx < 0) return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      Object.assign(vehicles[idx], body);
      writeJSON('vehicles.json', vehicles);
      return res.end(JSON.stringify({ ok: true }));
    }

    // DELETE /api/vehicles/:lot
    if (pathname.match(/^\/api\/vehicles\/[A-Z0-9-]+$/) && req.method === 'DELETE') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const lot = pathname.split('/').pop();
      let vehicles = readJSON('vehicles.json');
      vehicles = vehicles.filter(v => v.lot !== lot);
      writeJSON('vehicles.json', vehicles);
      let priv = readJSON('vehicles-private.json');
      priv = priv.filter(v => v.lot !== lot);
      writeJSON('vehicles-private.json', priv);
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET /api/vehicles/:lot/private
    if (pathname.match(/^\/api\/vehicles\/[A-Z0-9-]+\/private$/) && req.method === 'GET') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const lot = pathname.split('/')[3];
      const priv = readJSON('vehicles-private.json');
      const entry = priv.find(v => v.lot === lot);
      return res.end(JSON.stringify({ ok: !!entry, data: entry || null }));
    }

    // GET /api/pending
    if (pathname === '/api/pending' && req.method === 'GET') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return res.end(JSON.stringify({ ok: true, pending: readJSON('pending.json') }));
    }

    // POST /api/pending/:id/approve
    if (pathname.match(/^\/api\/pending\/.+\/approve$/) && req.method === 'POST') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const id = pathname.split('/')[3];
      const pending = readJSON('pending.json');
      const idx = pending.findIndex(p => p.id === id);
      if (idx < 0) return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      const dealer = { ...pending[idx], approved: true, approved_at: new Date().toISOString() };
      const dealers = readJSON('dealers.json');
      dealers.push(dealer);
      writeJSON('dealers.json', dealers);
      pending.splice(idx, 1);
      writeJSON('pending.json', pending);
      return res.end(JSON.stringify({ ok: true }));
    }

    // POST /api/pending/:id/reject
    if (pathname.match(/^\/api\/pending\/.+\/reject$/) && req.method === 'POST') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const id = pathname.split('/')[3];
      let pending = readJSON('pending.json');
      pending = pending.filter(p => p.id !== id);
      writeJSON('pending.json', pending);
      return res.end(JSON.stringify({ ok: true }));
    }

    // POST /api/parse (parse Manheim text)
    if (pathname === '/api/parse' && req.method === 'POST') {
      const s = getSession(req);
      if (!s || !['owner', 'operator'].includes(s.role)) return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const body = await readBody(req);
      const parsed = parseManheim(body.text || '');
      return res.end(JSON.stringify({ ok: true, data: parsed }));
    }

    res.writeHead(404);
    return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  }

  // ---- PAGE ROUTES ----
  // Protect catalog
  if (pathname === '/catalog') {
    const s = getSession(req);
    if (!s || !['dealer', 'owner', 'operator'].includes(s.role)) {
      res.writeHead(302, { Location: '/login' }); return res.end();
    }
  }
  // Protect admin pages
  if (pathname === '/admin' || pathname === '/admin/operator') {
    const s = getSession(req);
    if (!s || !['owner', 'operator'].includes(s.role)) {
      res.writeHead(302, { Location: '/admin/login' }); return res.end();
    }
    if (pathname === '/admin' && s.role === 'operator') {
      res.writeHead(302, { Location: '/admin/operator' }); return res.end();
    }
  }

  const filePath = PAGE_ROUTES[pathname];
  if (filePath) return serveFile(path.join(__dirname, filePath), res);

  // Fallback: try to serve file directly
  const directPath = path.join(__dirname, pathname);
  serveFile(directPath, res);

}).listen(PORT, () => {
  console.log(`ExportLots running on port ${PORT}`);
  console.log(`Owner login: admin / ${OWNER_PASSWORD}`);
  console.log(`Operator login: operator / ${OPERATOR_PASSWORD}`);
});
