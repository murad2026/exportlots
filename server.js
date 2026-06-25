const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

let bcrypt, multer, Jimp, uuid, nodemailer, Anthropic, Tesseract;
try { bcrypt = require('bcryptjs'); } catch(e) { bcrypt = null; }
try { uuid = require('uuid'); } catch(e) { uuid = { v4: () => crypto.randomUUID() }; }
try { Jimp = require('jimp'); } catch(e) { Jimp = null; }
try { nodemailer = require('nodemailer'); } catch(e) { nodemailer = null; }
try { Anthropic = require('@anthropic-ai/sdk'); } catch(e) { Anthropic = null; }
try { Tesseract = require('tesseract.js'); } catch(e) { Tesseract = null; }

const { initDb, allDocs, getDoc, insertDoc, updateDoc, deleteDoc, withNextLotInsert, getPhoto, findLotByVin, logEvent, getEvents } = require('./db');

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

// ---- CONFIG ----
const OWNER_PASSWORD = process.env.OWNER_PASS || 'murad123';
const OPERATOR_PASSWORD = process.env.OPERATOR_PASS || 'DapexOp2026!';

// ---- SESSION STORE (signed cookie — stateless, survives restarts) ----
const SESSION_SECRET = process.env.SESSION_SECRET || 'exportlots-secret-2026';

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return data + '.' + sig;
}

function verifySession(token) {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (Date.now() - payload.created > 7 * 86400000) return null;
    return payload;
  } catch { return null; }
}

function createSession(role, userId) {
  return signSession({ role, userId, created: Date.now() });
}

function getSession(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/sid=([A-Za-z0-9_\-\.]+)/);
  if (!match) return null;
  return verifySession(match[1]);
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

  // Year Make Model Trim — search for the first line that looks like a
  // title ("2022 Tesla Model 3 Standard Range"), since pasted text can have
  // unrelated UI chrome (e.g. "360_icon_card_view") before the real title.
  const titleLine = lines.find(l => /^\d{4}\s+[A-Za-z].+$/.test(l));
  const titleMatch = titleLine ? titleLine.match(/^(\d{4})\s+(.+)$/) : null;
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

  // MMR (detail page format: "Avg MMR" followed by a single $ value)
  const mmrIdx = lines.findIndex(l => l === 'Avg MMR');
  if (mmrIdx >= 0) {
    const m = lines[mmrIdx + 1]?.match(/\$([\d,]+)/);
    if (m) result.mmr_avg = parseInt(m[1].replace(/,/g, ''));
  }

  // MMR (search/title-block format: "MMR" line, then "$X,XXX - $Y,YYY" range,
  // then sometimes a separate "$Z,ZZZ" line right after — that extra line is
  // the Buy Now price, since it's not part of the MMR range itself)
  const mmrLabelIdx = lines.findIndex(l => l === 'MMR');
  if (mmrLabelIdx >= 0) {
    const rangeLine = lines[mmrLabelIdx + 1] || '';
    const rangeMatch = rangeLine.match(/\$([\d,]+)\s*-\s*\$([\d,]+)/);
    if (rangeMatch) {
      if (result.mmr_avg == null) {
        const lo = parseInt(rangeMatch[1].replace(/,/g, ''));
        const hi = parseInt(rangeMatch[2].replace(/,/g, ''));
        result.mmr_avg = Math.round((lo + hi) / 2);
      }
      const nextLine = lines[mmrLabelIdx + 2] || '';
      const priceMatch = nextLine.match(/^\$([\d,]+)$/);
      if (priceMatch) {
        result.buy_now = parseInt(priceMatch[1].replace(/,/g, ''));
      }
    }
  }

  // Location — Manheim's pickup field looks like "MD - Manheim Baltimore-Washington";
  // strip the auction-house branding so we don't expose the source on the card.
  const pickupIdx = lines.findIndex(l => l === 'Pickup');
  if (pickupIdx >= 0) result.location = lines[pickupIdx + 1].replace(/\bManheim\s*/i, '').trim();

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

// Parse time_left_raw like "23h 20m" or "1d 10h 24m" into end_time ISO string
function parseTimeLeft(raw) {
  if (!raw) return null;
  const dMatch = raw.match(/(\d+)d/);
  const hMatch = raw.match(/(\d+)h/);
  const mMatch = raw.match(/(\d+)m/);
  const d = dMatch ? parseInt(dMatch[1]) : 0;
  const h = hMatch ? parseInt(hMatch[1]) : 0;
  const m = mMatch ? parseInt(mMatch[1]) : 0;
  return new Date(Date.now() + (d * 86400 + h * 3600 + m * 60) * 1000).toISOString();
}

// Parse sale_date like "6/23" into end_time (assumes current year, end of day ET)
function parseSaleDate(raw) {
  if (!raw) return null;
  const m = raw.match(/(\d+)\/(\d+)/);
  if (!m) return null;
  const year = new Date().getFullYear();
  // Auction ends at ~8pm ET = midnight UTC next day approx
  return new Date(year, parseInt(m[1]) - 1, parseInt(m[2]), 20, 0, 0).toISOString();
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
// No segmentation model available (no external API), so we approximate a
// "blurred background" by radially blending a heavily blurred copy under a
// sharp copy: center (where the car usually is) stays sharp, edges fade
// into the blurred version. Pure Jimp, no external calls.
async function applyEdgeBlur(img) {
  const w = img.bitmap.width, h = img.bitmap.height;
  const blurred = img.clone().blur(18);
  const cx = w / 2, cy = h / 2;
  const innerR = Math.min(w, h) * 0.30; // fully sharp radius
  const outerR = Math.min(w, h) * 0.62; // fully blurred radius
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= innerR) continue;
      let t = (dist - innerR) / (outerR - innerR);
      if (t > 1) t = 1;
      const sharpColor = Jimp.intToRGBA(img.getPixelColor(x, y));
      const blurColor = Jimp.intToRGBA(blurred.getPixelColor(x, y));
      const mix = (a, b) => Math.round(a + (b - a) * t);
      img.setPixelColor(Jimp.rgbaToInt(
        mix(sharpColor.r, blurColor.r),
        mix(sharpColor.g, blurColor.g),
        mix(sharpColor.b, blurColor.b),
        255
      ), x, y);
    }
  }
  return img;
}

// ---- HIDE TEXT/BADGES ON A PHOTO ----
// Two complementary passes that hide overlays without touching the car:
// 1) the amber "DealShield Select" badge by its distinctive colour (reliable),
// 2) any real text words via OCR (Tesseract) — pixelate only tight word boxes.
const isAmberBadge = (c) => c.r > 222 && c.g > 172 && c.g < 218 && c.b < 115 && (c.r - c.b) > 125 && (c.g - c.b) > 80;

function pixelateAmberBadge(im) {
  const w = im.bitmap.width, h = im.bitmap.height;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, cnt = 0;
  const yLim = Math.round(h * 0.30); // badge lives in the top strip
  for (let y = 0; y < yLim; y++) for (let x = 0; x < w; x++) {
    const c = Jimp.intToRGBA(im.getPixelColor(x, y));
    if (isAmberBadge(c)) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; cnt++; }
  }
  if (cnt > 40 && maxX > minX) {
    const bx = Math.max(0, minX - 3), by = Math.max(0, minY - 3);
    im.pixelate(7, bx, by, Math.min(w - bx, maxX - minX + 6), Math.min(h - by, maxY - minY + 6));
  }
}

async function pixelateTextWords(im, worker) {
  if (!worker) return;
  try {
    const SC = 3; // upscale so small text is legible to the OCR
    const buf = await im.clone().scale(SC).getBufferAsync(Jimp.MIME_PNG);
    const { data } = await worker.recognize(buf);
    const w = im.bitmap.width, h = im.bitmap.height;
    for (const word of (data.words || [])) {
      if (word.confidence <= 68) continue;
      if (!/^[A-Za-z][A-Za-z0-9]{2,}$/.test((word.text || '').trim())) continue; // real word, drop junk
      const b = word.bbox;
      const x0 = b.x0 / SC, y0 = b.y0 / SC, bw = (b.x1 - b.x0) / SC, bh = (b.y1 - b.y0) / SC;
      if (bw < 6 || bh < 5) continue;
      const px = Math.max(0, Math.round(x0 - 3)), py = Math.max(0, Math.round(y0 - 3));
      im.pixelate(6, px, py, Math.min(w - px, Math.round(bw + 6)), Math.min(h - py, Math.round(bh + 6)));
    }
  } catch (e) { console.log('OCR error:', e.message); }
}

async function processImage(buffer) {
  try {
    if (!Jimp) throw new Error('no jimp');
    const img = await Jimp.read(buffer);
    // White background, resize, strip EXIF via JPEG re-encode
    img.background(0xFFFFFFFF);
    if (img.bitmap.width > 1200 || img.bitmap.height > 900) {
      img.scaleToFit(1200, 900);
    }
    // No blur — the screenshot crop already produced the final framed photo.
    return await img.quality(85).getBufferAsync(Jimp.MIME_JPEG);
  } catch(e) {
    console.log('Image processing error:', e.message, '— saving raw');
    return buffer;
  }
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
  '/admin':              'admin/index.html',
  '/admin/screenshot':   'admin/screenshot.html',
  '/admin/login':        'admin/login.html',
};

const server = http.createServer(async (req, res) => {
  try {
    return await handleRequest(req, res);
  } catch (e) {
    console.error('Unhandled request error:', e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: 'Internal error: ' + e.message }));
  }
});

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`ExportLots running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Failed to initialize Postgres — server not started:', e.message);
    process.exit(1);
  });

async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  let pathname = parsed.pathname.replace(/\/$/, '') || '/';

  // Static files
  // Vehicle photos are stored in Postgres (not on disk/Volume) so they
  // survive redeploys reliably.
  if (pathname.startsWith('/uploads/')) {
    const lot = path.basename(pathname, '.jpg');
    const data = await getPhoto(lot);
    if (!data) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(data);
  }
  if (pathname.startsWith('/style') || pathname.endsWith('.css') || pathname.endsWith('.js') || pathname.endsWith('.ico') || pathname.endsWith('.png') || pathname.endsWith('.jpg') || pathname.endsWith('.webp')) {
    return serveFile(path.join(__dirname, pathname), res);
  }

  // ---- API ROUTES ----
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    // Prevent CDN/browser caching of API responses (e.g. Cloudflare edge cache
    // serving stale vehicle lists to different visitors).
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');

    // POST /api/auth/login
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const { email, password, role } = body;

      if (role === 'owner' && email === 'admin' && password === OWNER_PASSWORD) {
        const sid = createSession('owner', 'owner-1');
        res.writeHead(200, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; Max-Age=86400` });
        return res.end(JSON.stringify({ ok: true, role: 'owner' }));
      }
      // Dealer login
      if (email === 'test@dapex.net' && password === 'test123') {
        const sid = createSession('dealer', 'test-001');
        res.writeHead(200, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; Max-Age=86400` });
        return res.end(JSON.stringify({ ok: true, role: 'dealer' }));
      }
      const dealers = await allDocs('dealers');
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
      const dealers = await allDocs('dealers');
      const pending = await allDocs('pending');
      const all = [...dealers, ...pending];
      if (all.find(d => d.email.toLowerCase() === email.toLowerCase())) {
        return res.end(JSON.stringify({ ok: false, error: 'Email already registered' }));
      }
      const id = 'D' + Date.now();
      const hash = bcrypt ? bcrypt.hashSync(password || 'changeme123', 10) : (password || 'changeme123');
      const application = { id, name, company, country, email, phone, type, volume, message, password_hash: hash, applied: new Date().toISOString(), approved: false };
      await insertDoc('pending', 'id', id, application);
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

    // POST /api/track — record a dealer activity event.
    // Identity is taken from the session, NOT the request body, so it can't
    // be spoofed. Only logged-in dealers/owners are tracked; everyone else
    // is silently ignored (no error, so the client never breaks).
    if (pathname === '/api/track' && req.method === 'POST') {
      const s = getSession(req);
      if (!s || !['dealer', 'owner'].includes(s.role)) {
        return res.end(JSON.stringify({ ok: true, skipped: true }));
      }
      // The owner browsing their own catalog shouldn't pollute dealer stats.
      if (s.role === 'owner') return res.end(JSON.stringify({ ok: true, skipped: true }));
      const body = await readBody(req);
      const ALLOWED = ['view', 'whatsapp', 'search'];
      const type = ALLOWED.includes(body.type) ? body.type : null;
      if (!type) return res.end(JSON.stringify({ ok: false, error: 'bad type' }));
      const lot = typeof body.lot === 'string' ? body.lot.slice(0, 40) : null;
      let meta = null;
      if (body.meta && typeof body.meta === 'object') {
        meta = {};
        for (const k of ['query', 'make', 'model', 'dwell']) {
          if (body.meta[k] != null) meta[k] = String(body.meta[k]).slice(0, 120);
        }
        if (!Object.keys(meta).length) meta = null;
      }
      try { await logEvent(s.userId, lot, type, meta); } catch(e) { console.log('track error:', e.message); }
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET /api/admin/activity — per-dealer activity summary for the owner.
    if (pathname === '/api/admin/activity' && req.method === 'GET') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const days = Math.min(365, Math.max(1, parseInt(parsed.query.days) || 30));
      const events = await getEvents(days);
      const dealers = await allDocs('dealers');
      const vehicles = await allDocs('vehicles');

      // Lookups: dealer id -> readable name, lot -> "year make model".
      const dealerName = {};
      dealers.forEach(d => { dealerName[d.id] = d.company || d.name || d.email || d.id; });
      dealerName['test-001'] = 'Demo dealer (test@dapex.net)';
      const lotTitle = {};
      vehicles.forEach(v => { lotTitle[v.lot] = `${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim(); });

      // Aggregate per dealer.
      const byDealer = {};
      for (const e of events) {
        const id = e.dealer_id || 'unknown';
        if (!byDealer[id]) {
          byDealer[id] = { id, name: dealerName[id] || id, total: 0, lastSeen: e.created_at, cars: {}, searches: [] };
        }
        const d = byDealer[id];
        d.total++;
        if (new Date(e.created_at) > new Date(d.lastSeen)) d.lastSeen = e.created_at;
        if (e.type === 'search') {
          const q = (e.meta && (e.meta.query || [e.meta.make, e.meta.model].filter(Boolean).join(' '))) || '';
          if (q && d.searches.length < 25) d.searches.push({ q, at: e.created_at });
          continue;
        }
        if (!e.lot) continue;
        if (!d.cars[e.lot]) {
          d.cars[e.lot] = { lot: e.lot, title: lotTitle[e.lot] || '(removed listing)', views: 0, whatsapp: 0, lastSeen: e.created_at };
        }
        const c = d.cars[e.lot];
        if (e.type === 'view') c.views++;
        if (e.type === 'whatsapp') c.whatsapp++;
        if (new Date(e.created_at) > new Date(c.lastSeen)) c.lastSeen = e.created_at;
      }

      // Shape into sorted arrays: cars ranked by interest (WhatsApp first, then views).
      const dealersOut = Object.values(byDealer).map(d => {
        const cars = Object.values(d.cars).sort((a, b) =>
          (b.whatsapp - a.whatsapp) || (b.views - a.views) || (new Date(b.lastSeen) - new Date(a.lastSeen))
        );
        return { id: d.id, name: d.name, total: d.total, lastSeen: d.lastSeen, cars, searches: d.searches };
      }).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

      return res.end(JSON.stringify({ ok: true, days, dealers: dealersOut }));
    }

    // GET /api/vehicles
    if (pathname === '/api/vehicles' && req.method === 'GET') {
      const s = getSession(req);
      const vehicles = await allDocs('vehicles');
      const isDealer = s && ['dealer', 'owner'].includes(s.role);
      const active = vehicles.filter(v => v.status === 'active' || v.status === 'live');
      const list = isDealer ? active : active.slice(0, 6);
      return res.end(JSON.stringify({ ok: true, vehicles: list, isDealer }));
    }

    // PATCH /api/vehicles/:lot
    if (pathname.match(/^\/api\/vehicles\/[A-Z0-9-]+$/) && req.method === 'PATCH') {
      const s = getSession(req);
      if (!s || !['owner'].includes(s.role)) {
        return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      }
      const lot = pathname.split('/').pop();
      const body = await readBody(req);
      const existing = await getDoc('vehicles', 'lot', lot);
      if (!existing) return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      const updated = Object.assign({}, existing, body);
      await updateDoc('vehicles', 'lot', lot, updated);
      return res.end(JSON.stringify({ ok: true }));
    }

    // DELETE /api/vehicles/:lot
    if (pathname.match(/^\/api\/vehicles\/[A-Z0-9-]+$/) && req.method === 'DELETE') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const lot = pathname.split('/').pop();
      await deleteDoc('vehicles', 'lot', lot);
      await deleteDoc('vehicles_private', 'lot', lot);
      await deleteDoc('photos', 'lot', lot);
      return res.end(JSON.stringify({ ok: true }));
    }

    // POST /api/vehicles/:lot/photo — replace a listing's cover photo (manual upload)
    if (pathname.match(/^\/api\/vehicles\/[A-Z0-9-]+\/photo$/) && req.method === 'POST') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const lot = pathname.split('/')[3];
      const existing = await getDoc('vehicles', 'lot', lot);
      if (!existing) return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      const { file } = await parseMultipart(req);
      if (!file || !file.buffer || !file.buffer.length) return res.end(JSON.stringify({ ok: false, error: 'No image uploaded' }));
      // Normalize the uploaded image (white bg, resize, strip EXIF) — no blur,
      // since the operator is supplying a clean photo on purpose.
      let processed = file.buffer;
      if (Jimp) {
        try {
          const im = await Jimp.read(file.buffer);
          im.background(0xFFFFFFFF);
          if (im.bitmap.width > 1200 || im.bitmap.height > 900) im.scaleToFit(1200, 900);
          processed = await im.quality(85).getBufferAsync(Jimp.MIME_JPEG);
        } catch(e) { console.log('Replace photo process error:', e.message); }
      }
      const { pool } = require('./db');
      await pool.query('INSERT INTO photos (lot, data) VALUES ($1, $2) ON CONFLICT (lot) DO UPDATE SET data = $2', [lot, processed]);
      // Cache-bust the photo URL so the new image shows immediately.
      const updated = Object.assign({}, existing, { photo: `/uploads/${lot}.jpg?v=${Date.now()}` });
      await updateDoc('vehicles', 'lot', lot, updated);
      return res.end(JSON.stringify({ ok: true, photo: updated.photo }));
    }

    // POST /api/vehicles/bulk-delete
    if (pathname === '/api/vehicles/bulk-delete' && req.method === 'POST') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const body = await readBody(req);
      const { lots } = body;
      if (!Array.isArray(lots) || !lots.length) return res.end(JSON.stringify({ ok: false, error: 'No lots provided' }));
      const { pool } = require('./db');
      const placeholders = lots.map((_, i) => `$${i + 1}`).join(',');
      await pool.query(`DELETE FROM vehicles WHERE lot IN (${placeholders})`, lots);
      await pool.query(`DELETE FROM vehicles_private WHERE lot IN (${placeholders})`, lots);
      await pool.query(`DELETE FROM photos WHERE lot IN (${placeholders})`, lots);
      return res.end(JSON.stringify({ ok: true, deleted: lots.length }));
    }

    // GET /api/vehicles/:lot/private
    if (pathname.match(/^\/api\/vehicles\/[A-Z0-9-]+\/private$/) && req.method === 'GET') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const lot = pathname.split('/')[3];
      const entry = await getDoc('vehicles_private', 'lot', lot);
      return res.end(JSON.stringify({ ok: !!entry, data: entry || null }));
    }

    // GET /api/pending
    if (pathname === '/api/pending' && req.method === 'GET') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return res.end(JSON.stringify({ ok: true, pending: await allDocs('pending') }));
    }

    // POST /api/pending/:id/approve
    if (pathname.match(/^\/api\/pending\/.+\/approve$/) && req.method === 'POST') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const id = pathname.split('/')[3];
      const app = await getDoc('pending', 'id', id);
      if (!app) return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      const dealer = { ...app, approved: true, approved_at: new Date().toISOString() };
      await insertDoc('dealers', 'id', id, dealer);
      await deleteDoc('pending', 'id', id);
      return res.end(JSON.stringify({ ok: true }));
    }

    // POST /api/pending/:id/reject
    if (pathname.match(/^\/api\/pending\/.+\/reject$/) && req.method === 'POST') {
      const s = getSession(req);
      if (!s || s.role !== 'owner') return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      const id = pathname.split('/')[3];
      await deleteDoc('pending', 'id', id);
      return res.end(JSON.stringify({ ok: true }));
    }

    // POST /api/parse-screenshot — parse a Manheim grid screenshot via Claude Vision
    if (pathname === '/api/parse-screenshot' && req.method === 'POST') {
      const s = getSession(req);
      if (!s || !['owner'].includes(s.role)) return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));

      if (!Anthropic) return res.end(JSON.stringify({ ok: false, error: 'Anthropic SDK not available' }));
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.end(JSON.stringify({ ok: false, error: 'ANTHROPIC_API_KEY not set' }));

      const { fields, file } = await parseMultipart(req);
      if (!file) return res.end(JSON.stringify({ ok: false, error: 'No screenshot uploaded' }));

      const screenshotBuf = file.buffer;
      const screenshotB64 = screenshotBuf.toString('base64');
      const mimeType = file.originalname.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

      const client = new Anthropic({ apiKey });

      const prompt = `You are analyzing a screenshot from Manheim auto auction website showing a grid of vehicle cards.

The screenshot dimensions will be provided. Extract ALL vehicles visible in the screenshot.

For each card extract:
- year (number)
- make (string)
- model (string)
- trim (string, may be empty)
- mileage (number, miles)
- engine (e.g. "5.7L 8 Cyl")
- drivetrain (e.g. "4WD", "FWD", "AWD", "RWD")
- fuel (e.g. "Gasoline", "Electric", "Hybrid")
- location (city/state shown, e.g. "TX - HOUSTON", strip "Manheim" from name)
- sale_type: "timed" if card says "Timed Sale", "simulcast" if says "Simulcast Live"
- mmr_low (lower MMR range number, no $ sign)
- mmr_high (upper MMR range number, no $ sign)
- bid_price (the "Bid $X,XXX" or "Starting Bid" price as a number, null if not shown)
- buy_now_price (the "Buy Now $X,XXX" price as a number, null if not shown)
- manheim_id (the 8-digit number shown on each card, e.g. "13501227" — this is the last 8 chars of the VIN)
- sale_date: some cards show a small calendar badge in the TOP-RIGHT corner like "6/24 3-158" or "6/25 5-73" (date followed by lane-run). Extract ONLY the M/D date part (e.g. "6/24"). Return null if there is no such date badge (e.g. plain "Timed Sale" cards).
- cr_score (Condition Report score like "3.8", "4.4" — number or null)
- title_ok (true if no salvage/rebuild badge visible, false if red "Salvage" tag shown)

Return a JSON array of objects, one per vehicle card. No markdown, just raw JSON array.`;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: screenshotB64 }
          }, {
            type: 'text',
            text: prompt
          }]
        }]
      });

      let rawVehicles = [];
      try {
        const text = response.content[0].text.trim();
        const jsonStr = text.startsWith('[') ? text : text.match(/\[[\s\S]*\]/)?.[0] || '[]';
        rawVehicles = JSON.parse(jsonStr);
      } catch(e) {
        return res.end(JSON.stringify({ ok: false, error: 'Failed to parse Claude response: ' + e.message }));
      }

      // Compute mmr_avg and apply markup to buy_now
      const MARKUP = 0.12;
      let vehicles = rawVehicles.map(v => {
        const mmr_avg = (v.mmr_low && v.mmr_high) ? Math.round((v.mmr_low + v.mmr_high) / 2) : (v.mmr_low || v.mmr_high || null);
        const buy_now = v.buy_now_price ? Math.round(v.buy_now_price * (1 + MARKUP)) : null;
        const bid = v.bid_price || mmr_avg || null;
        const start_price = v.bid_price || null; // real starting bid only (no MMR fallback, no markup)
        // Fallback price for listings with no bid/Buy Now: the high MMR + markup.
        const expected_price = v.mmr_high ? Math.round(v.mmr_high * (1 + MARKUP)) : null;
        return {
          year: v.year,
          make: v.make,
          model: v.model,
          trim: v.trim || '',
          mileage: v.mileage,
          engine: v.engine || '',
          drivetrain: v.drivetrain || '',
          fuel: v.fuel || 'Gasoline',
          location: (v.location || '').replace(/\bManheim\s*/gi, '').trim(),
          sale_type: v.sale_type || 'timed',
          mmr_avg: mmr_avg,
          mmr_low: v.mmr_low,
          mmr_high: v.mmr_high,
          buy_now: buy_now,
          bid_price: bid,
          start_price: start_price,
          expected_price: expected_price,
          manheim_id: v.manheim_id || '',
          sale_date: v.sale_date || '',
          cr_score: v.cr_score || null,
          title_status: v.title_ok === false ? 'Salvage' : 'Clean',
          // Never embed the Manheim id in the public-facing masked VIN. The real
          // id is kept admin-only in vehicles_private.manheim_lot.
          vin_masked: '•••••••••••••••••',
          status: 'active',
        };
      });

      // Crop individual car photos from a Manheim grid screenshot. The grid of
      // cards (rows × columns) is detected from the dark-blue "Timed Sale /
      // Simulcast Live" header bars rather than guessed from the parsed car
      // count — so a 2×8 grid of 16 cars crops correctly even if the parser
      // miscounts. For each card we then find the photo top (bottom of the blue
      // header) and bottom (first near-white row before the title). Falls back
      // to an even count-based grid when no header bars are present.
      const croppedPhotos = [];
      if (Jimp && rawVehicles.length > 0) {
        try {
          const img = await Jimp.read(screenshotBuf);
          const W = img.bitmap.width;
          const H = img.bitmap.height;
          const count = Math.min(rawVehicles.length, 16);

          const isBlue = (c) => c.b > 60 && c.b > c.r + 25 && c.b > c.g + 15 && c.r < 130;
          const xStep = Math.max(2, Math.floor(W / 250));
          const blueRowFrac = (y) => {
            let blue = 0, n = 0;
            for (let x = 2; x < W - 2; x += xStep) { if (isBlue(Jimp.intToRGBA(img.getPixelColor(x, y)))) blue++; n++; }
            return n ? blue / n : 0;
          };

          // Detect the dark-blue header bands — one per row of cards.
          let bands = [];
          { let top = -1;
            for (let y = 0; y < H; y++) {
              const f = blueRowFrac(y);
              if (f > 0.35 && top < 0) top = y;
              else if (f < 0.15 && top >= 0) { bands.push({ top, bottom: y }); top = -1; }
            }
            if (top >= 0) bands.push({ top, bottom: H });
          }
          // Drop thin false bands (colored condition circles, dividers); a real
          // header bar is tens of px tall.
          bands = bands.filter(b => b.bottom - b.top >= 10);

          // Columns within a band = runs of x that contain blue somewhere in the
          // band; the white gaps between cards separate them. Immune to the white
          // date badge (the bar is still blue above/below it).
          const detectCols = (band) => {
            const ys = [];
            for (let dy = 1; dy < (band.bottom - band.top) && dy < 30; dy++) ys.push(band.top + dy);
            const runs = [];
            let start = -1;
            for (let x = 0; x < W; x++) {
              let hasBlue = false;
              for (const sy of ys) { if (sy < H && isBlue(Jimp.intToRGBA(img.getPixelColor(x, sy)))) { hasBlue = true; break; } }
              if (hasBlue && start < 0) start = x;
              else if (!hasBlue && start >= 0) { runs.push([start, x]); start = -1; }
            }
            if (start >= 0) runs.push([start, W]);
            return runs.filter(([a, b]) => b - a > W * 0.02);
          };

          // Build the grid of card cells {x,y,w,h}.
          let cells = [];
          if (bands.length >= 1) {
            for (let r = 0; r < bands.length; r++) {
              const cy = bands[r].top;
              const ch = (r + 1 < bands.length ? bands[r + 1].top : H) - cy;
              for (const [x0, x1] of detectCols(bands[r])) cells.push({ x: x0, y: cy, w: x1 - x0, h: ch, photoTop: bands[r].bottom });
            }
          }
          if (cells.length < 2) { // no usable headers — even count-based grid
            cells = [];
            const ROWS = count <= 8 ? 1 : 2;
            const COLS = ROWS === 1 ? count : Math.ceil(count / 2);
            const cw = Math.floor(W / COLS), chh = Math.floor(H / ROWS);
            for (let i = 0; i < count; i++) cells.push({ x: (i % COLS) * cw, y: Math.floor(i / COLS) * chh, w: cw, h: chh });
          }

          // Evenly spaced sample columns across one cell (skip the side borders).
          const colsOf = (cell) => {
            const xs = [];
            const step = Math.max(2, Math.floor(cell.w / 40));
            for (let sx = cell.x + 4; sx < cell.x + cell.w - 4; sx += step) xs.push(sx);
            return xs;
          };
          // Photo top: bottom of the blue header. Header cells already know it
          // (band.bottom); the fallback grid scans for the header per cell.
          const detectPhotoTop = (cell) => {
            if (typeof cell.photoTop === 'number') return cell.photoTop;
            const xs = colsOf(cell);
            const maxScan = Math.round(cell.h * 0.25);
            let sawHeader = false;
            for (let dy = 0; dy <= maxScan && cell.y + dy < H; dy++) {
              let blue = 0;
              for (const sx of xs) if (isBlue(Jimp.intToRGBA(img.getPixelColor(sx, cell.y + dy)))) blue++;
              const frac = xs.length ? blue / xs.length : 0;
              if (frac > 0.5) sawHeader = true;
              else if (sawHeader) return cell.y + dy;
            }
            return cell.y;
          };
          // First near-white full-width row below the photo = photo bottom.
          const detectPhotoBottom = (cell, yTop) => {
            const xs = colsOf(cell);
            const minY = yTop + Math.round(cell.h * 0.10);
            const maxY = yTop + Math.round(cell.h * 0.60);
            for (let y = minY; y <= maxY && y < H; y++) {
              let light = 0;
              for (const sx of xs) { const c = Jimp.intToRGBA(img.getPixelColor(sx, y)); if (c.r > 232 && c.g > 232 && c.b > 232) light++; }
              if (xs.length && light / xs.length > 0.93) return y;
            }
            return yTop + Math.round(cell.h * 0.40);
          };

          // One OCR worker for all cards in this screenshot (degrades to no-OCR
          // if Tesseract can't start — the colour badge pass still runs).
          let ocrWorker = null;
          if (Tesseract) {
            try {
              ocrWorker = await Tesseract.createWorker('eng', 1, {
                langPath: path.join(__dirname, 'tessdata'),
                gzip: true,
                cachePath: require('os').tmpdir(),
              });
            } catch (e) { console.log('OCR init failed:', e.message); ocrWorker = null; }
          }

          for (let i = 0; i < count; i++) {
            const cell = cells[i];
            if (!cell) { croppedPhotos.push(null); continue; }
            const yTop = detectPhotoTop(cell);
            const yBot = detectPhotoBottom(cell, yTop);
            const x = cell.x + 1, y = yTop, w = cell.w - 2, h = yBot - yTop;
            if (x + w > W || y + h > H || h < 10 || w < 10) { croppedPhotos.push(null); continue; }
            // Original photo (no blur, no crop offset); hide only the overlays:
            // the amber DealShield badge by colour, and any real text via OCR.
            const cropped = img.clone().crop(x, y, w, h);
            pixelateAmberBadge(cropped);
            await pixelateTextWords(cropped, ocrWorker);
            const jpgBuf = await cropped.quality(85).getBufferAsync(Jimp.MIME_JPEG);
            croppedPhotos.push(jpgBuf.toString('base64'));
          }

          if (ocrWorker) { try { await ocrWorker.terminate(); } catch (e) {} }
        } catch(e) {
          console.log('Screenshot crop error:', e.message);
        }
      }

      // Manheim often lists the same car twice — once as a Simulcast Live card
      // (carrying the auction date) and once as a Timed Sale card (carrying the
      // Buy Now price). Merge cards that share a Manheim id into a single
      // listing that keeps the starting bid, the Buy Now price and the sale date
      // together, and keep the first available photo for the group.
      const mergedVehicles = [];
      const mergedPhotos = [];
      const indexById = new Map();
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        const id = (v.manheim_id || '').trim().toUpperCase();
        const photo = croppedPhotos[i] || null;
        if (id && indexById.has(id)) {
          const j = indexById.get(id);
          const t = mergedVehicles[j];
          // Fill in whatever the existing entry is missing from this duplicate.
          t.buy_now = t.buy_now || v.buy_now;
          t.bid_price = t.bid_price || v.bid_price;
          t.start_price = t.start_price || v.start_price;
          t.expected_price = t.expected_price || v.expected_price;
          t.sale_date = t.sale_date || v.sale_date;
          t.mmr_avg = t.mmr_avg || v.mmr_avg;
          t.mmr_low = t.mmr_low || v.mmr_low;
          t.mmr_high = t.mmr_high || v.mmr_high;
          t.cr_score = t.cr_score || v.cr_score;
          // A listing with a Buy Now price and a deadline behaves like a timed sale.
          if (t.buy_now) t.sale_type = 'timed';
          if (!mergedPhotos[j] && photo) mergedPhotos[j] = photo;
        } else {
          if (id) indexById.set(id, mergedVehicles.length);
          mergedVehicles.push(v);
          mergedPhotos.push(photo);
        }
      }

      // Report token usage and an approximate cost for this screenshot so the
      // operator can see what the Vision call cost. Sonnet 4.6: $3 / 1M input,
      // $15 / 1M output.
      const u = response.usage || {};
      const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const outTok = u.output_tokens || 0;
      const costUsd = Math.round((inTok / 1e6 * 3 + outTok / 1e6 * 15) * 10000) / 10000;
      console.log(`parse-screenshot usage: in=${inTok} out=${outTok} cost=$${costUsd}`);
      const usage = { input_tokens: inTok, output_tokens: outTok, cost_usd: costUsd };

      return res.end(JSON.stringify({ ok: true, vehicles: mergedVehicles, photos: mergedPhotos, usage }));
    }

    // POST /api/vehicles/bulk — add multiple vehicles at once (from screenshot parser)
    if (pathname === '/api/vehicles/bulk' && req.method === 'POST') {
      const s = getSession(req);
      if (!s || !['owner'].includes(s.role)) return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));

      const body = await readBody(req);
      const { vehicles, photos, markets } = body; // photos: array of base64 strings or nulls
      if (!Array.isArray(vehicles) || !vehicles.length) return res.end(JSON.stringify({ ok: false, error: 'No vehicles' }));

      const results = [];
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        try {
          let processedPhoto = null;
          if (photos && photos[i]) {
            const photoBuf = Buffer.from(photos[i], 'base64');
            processedPhoto = await processImage(photoBuf);
          }

          const vin_full = v.manheim_id ? ('00000000000000000' + v.manheim_id).slice(-17) : '';
          // The date badge maps to the live start for simulcast sales and to the
          // closing time for timed sales, so the catalog countdown targets the
          // right field for each sale type.
          const saleTime = v.sale_date ? parseSaleDate(v.sale_date) : null;
          const isSimulcast = (v.sale_type || 'timed') === 'simulcast';
          const end_time = isSimulcast ? null : saleTime;
          const start_time = isSimulcast ? saleTime : null;

          // Cross-screenshot dedup: if a listing for this Manheim id already
          // exists (e.g. the date came in one screenshot and the Buy Now price
          // in another), merge the new info into it instead of creating a
          // duplicate lot.
          const existingLot = vin_full ? await findLotByVin(vin_full) : null;
          if (existingLot) {
            const existing = await getDoc('vehicles', 'lot', existingLot);
            if (existing) {
              const existDate = existing.end_time || existing.start_time;
              const saleDate = existDate || end_time || start_time;
              const merged = Object.assign({}, existing, {
                buy_now: existing.buy_now || v.buy_now || null,
                mmr_avg: existing.mmr_avg || v.bid_price || v.mmr_avg || null,
                start_price: existing.start_price || v.start_price || null,
                expected_price: existing.expected_price || v.expected_price || null,
                grade: existing.grade || v.cr_score || null,
                condition_report: existing.condition_report || !!v.cr_score,
                status: 'active',
              });
              // A Buy Now price + a deadline behaves like a timed sale, so the
              // countdown targets end_time.
              if (merged.buy_now) {
                merged.sale_type = 'timed';
                merged.end_time = saleDate || null;
                merged.start_time = null;
              } else if (saleDate && !existDate) {
                if ((existing.sale_type || 'timed') === 'simulcast') merged.start_time = saleDate;
                else merged.end_time = saleDate;
              }
              if (!existing.photo && processedPhoto) {
                const { pool } = require('./db');
                await pool.query('INSERT INTO photos (lot, data) VALUES ($1, $2) ON CONFLICT (lot) DO UPDATE SET data = $2', [existingLot, processedPhoto]);
                merged.photo = `/uploads/${existingLot}.jpg`;
              }
              await updateDoc('vehicles', 'lot', existingLot, merged);
              results.push({ ok: true, lot: existingLot, merged: true, make: v.make, model: v.model });
              continue;
            }
          }

          const { lot } = await withNextLotInsert(
            new Date().getFullYear(),
            (lot) => ({
              lot,
              vin_masked: v.vin_masked || '',
              year: v.year,
              make: v.make,
              model: v.model,
              trim: v.trim || '',
              mileage: v.mileage || null,
              engine: v.engine || '',
              transmission: '',
              drivetrain: v.drivetrain || '',
              fuel: v.fuel || 'Gasoline',
              color_ext: '',
              color_int: '',
              body: 'SUV',
              grade: v.cr_score || null,
              autocheck: null,
              owners: null,
              accidents: null,
              title_status: v.title_status || 'Not Specified',
              announcements: null,
              remarks: null,
              seller_comments: null,
              condition_report: !!v.cr_score,
              sale_type: v.sale_type || 'timed',
              end_time,
              start_time,
              mmr_avg: v.bid_price || v.mmr_avg || null,
              start_price: v.start_price || null,
              expected_price: v.expected_price || null,
              buy_now: v.buy_now || null,
              location: v.location || '',
              auction_house: '',
              msrp: null,
              photo: processedPhoto ? `/uploads/${lot}.jpg` : null,
              markets: markets || v.markets || [],
              status: 'active',
              is_sample: false,
              added: new Date().toISOString(),
            }),
            (lot) => ({ lot, vin_full, manheim_lot: v.manheim_id || '', buy_price: null, seller: '' }),
            processedPhoto
          );
          results.push({ ok: true, lot, make: v.make, model: v.model });
        } catch(e) {
          results.push({ ok: false, error: e.message, make: v.make, model: v.model });
        }
      }

      return res.end(JSON.stringify({ ok: true, results }));
    }

    res.writeHead(404);
    return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  }

  // ---- PAGE ROUTES ----
  // Protect catalog
  if (pathname === '/catalog') {
    const s = getSession(req);
    if (!s || !['dealer', 'owner'].includes(s.role)) {
      res.writeHead(302, { Location: '/login' }); return res.end();
    }
  }
  // Protect admin pages
  if (pathname === '/admin' || pathname === '/admin/screenshot') {
    const s = getSession(req);
    if (!s || !['owner'].includes(s.role)) {
      res.writeHead(302, { Location: '/admin/login' }); return res.end();
    }
  }

  const filePath = PAGE_ROUTES[pathname];
  if (filePath) return serveFile(path.join(__dirname, filePath), res);

  // Fallback: try to serve file directly
  const directPath = path.join(__dirname, pathname);
  serveFile(directPath, res);
}
