require('dotenv').config();
const express = require('express');
const session = require('express-session');
const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const FIREBASE_WEB_API_KEY = 'AIzaSyDJArijI7yB_Gx9pZPjR_Jh3-gXPJBo7zc';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Helper: normalize a project doc for both public and admin consumption
function normalizeProject(id, d) {
  const price = Number(d.priceNGN ?? d.price ?? 0);
  const isReleased = d.released === true || d.published === true || d.status === 'Released';
  return {
    id,
    title: d.title || 'Untitled',
    description: d.longDescription || d.description || '',
    shortDescription: d.description || '',
    longDescription: d.longDescription || '',
    price,
    priceNGN: price,   // alias for legacy frontends
    type: d.type || d.category || 'module',
    category: d.category || d.type || 'module',
    image: d.image || d.coverImage || '',
    coverImage: d.coverImage || d.image || '',
    tags: Array.isArray(d.tags) ? d.tags : (Array.isArray(d.technologies) ? d.technologies : []),
    technologies: Array.isArray(d.technologies) ? d.technologies : (Array.isArray(d.tags) ? d.tags : []),
    released: isReleased,
    published: d.published === true,
    status: d.status || (isReleased ? 'Released' : 'Draft'),
    demoUrl: d.demoUrl || '',
    docsUrl: d.docsUrl || '',
    sourceUrl: d.sourceUrl || '',
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
  };
}

// ---------- Public: released projects ----------
app.get('/api/projects', async (req, res) => {
  try {
    const snap = await db.collection('projects').get();
    const projects = snap.docs
      .map(d => normalizeProject(d.id, d.data()))
      .filter(p => p.released)
      .sort((a, b) => {
        const as = a.createdAt?._seconds || 0;
        const bs = b.createdAt?._seconds || 0;
        return bs - as;
      });
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Public: single project ----------
app.get('/api/project/:id', async (req, res) => {
  try {
    const doc = await db.collection('projects').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const p = normalizeProject(doc.id, doc.data());
    if (!p.released) return res.status(404).json({ error: 'Not available' });
    res.json({ project: p });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Public: lessons ----------
app.get('/api/lessons', async (req, res) => {
  try {
    const snap = await db.collection('lessons').where('released', '==', true).get();
    const lessons = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    lessons.sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    res.json({ lessons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Public: contact ----------
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'Name, email, message required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
    await db.collection('messages').add({
      name, email, subject: subject || '', message, read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Admin: session check ----------
app.get('/api/admin/check', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.admin) });
});

// ---------- Admin: login ----------
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }) }
    );
    const data = await response.json();
    if (!response.ok) throw new Error('Invalid credentials');
    const adminDoc = await db.collection('admins').doc(data.localId).get();
    if (!adminDoc.exists) throw new Error('Not an administrator');
    req.session.admin = true;
    req.session.uid = data.localId;
    res.json({ ok: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- Admin: projects CRUD ----------
app.get('/api/admin/projects', requireAdmin, async (req, res) => {
  const snap = await db.collection('projects').get();
  const projects = snap.docs.map(d => normalizeProject(d.id, d.data()));
  projects.sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
  res.json({ projects });
});

app.post('/api/admin/projects', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const price = Number(body.price ?? body.priceNGN ?? 0);
  const tags = Array.isArray(body.tags) ? body.tags : (Array.isArray(body.technologies) ? body.technologies : []);
  const category = body.category || body.type || 'module';
  const released = body.released === true || body.published === true;
  const ref = await db.collection('projects').add({
    title: body.title || 'Untitled',
    description: body.shortDescription || body.description || '',
    longDescription: body.longDescription || body.description || '',
    price,
    priceNGN: price,
    image: body.image || body.coverImage || '',
    coverImage: body.coverImage || body.image || '',
    tags,
    technologies: tags,
    type: body.type || category,
    category,
    released,
    published: released,
    status: released ? 'Released' : 'Draft',
    demoUrl: body.demoUrl || '',
    docsUrl: body.docsUrl || '',
    sourceUrl: body.sourceUrl || '',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  res.json({ id: ref.id });
});

app.patch('/api/admin/projects/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

  if (b.title !== undefined) patch.title = b.title;
  if (b.shortDescription !== undefined) patch.description = b.shortDescription;
  if (b.description !== undefined) patch.description = b.description;
  if (b.longDescription !== undefined) patch.longDescription = b.longDescription;
  if (b.price !== undefined || b.priceNGN !== undefined) {
    const p = Number(b.price ?? b.priceNGN) || 0;
    patch.price = p;
    patch.priceNGN = p;
  }
  if (b.image !== undefined || b.coverImage !== undefined) {
    const img = b.image || b.coverImage || '';
    patch.image = img;
    patch.coverImage = img;
  }
  if (b.tags !== undefined || b.technologies !== undefined) {
    const raw = b.tags ?? b.technologies;
    const arr = Array.isArray(raw) ? raw : String(raw).split(',').map(t => t.trim()).filter(Boolean);
    patch.tags = arr;
    patch.technologies = arr;
  }
  if (b.type !== undefined || b.category !== undefined) {
    const c = b.category || b.type || 'module';
    patch.type = b.type || c;
    patch.category = c;
  }
  if (b.released !== undefined || b.published !== undefined) {
    const r = b.released === true || b.published === true;
    patch.released = r;
    patch.published = r;
    patch.status = r ? 'Released' : 'Draft';
  }
  if (b.demoUrl !== undefined) patch.demoUrl = b.demoUrl;
  if (b.docsUrl !== undefined) patch.docsUrl = b.docsUrl;
  if (b.sourceUrl !== undefined) patch.sourceUrl = b.sourceUrl;

  await db.collection('projects').doc(req.params.id).update(patch);
  res.json({ ok: true });
});

app.delete('/api/admin/projects/:id', requireAdmin, async (req, res) => {
  await db.collection('projects').doc(req.params.id).delete();
  res.json({ ok: true });
});

// ---------- Admin: lessons CRUD ----------
app.get('/api/admin/lessons', requireAdmin, async (req, res) => {
  const snap = await db.collection('lessons').orderBy('createdAt', 'desc').get();
  res.json({ lessons: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

app.post('/api/admin/lessons', requireAdmin, async (req, res) => {
  const ref = await db.collection('lessons').add({
    title: req.body.title || 'Untitled',
    description: req.body.description || '',
    content: req.body.content || '',
    category: req.body.category || 'General',
    released: Boolean(req.body.released),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  res.json({ id: ref.id });
});

app.patch('/api/admin/lessons/:id', requireAdmin, async (req, res) => {
  const patch = {};
  ['title', 'description', 'content', 'category', 'released'].forEach(k => {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  });
  await db.collection('lessons').doc(req.params.id).update(patch);
  res.json({ ok: true });
});

app.delete('/api/admin/lessons/:id', requireAdmin, async (req, res) => {
  await db.collection('lessons').doc(req.params.id).delete();
  res.json({ ok: true });
});

// ---------- Admin: messages ----------
app.get('/api/admin/messages', requireAdmin, async (req, res) => {
  const snap = await db.collection('messages').orderBy('createdAt', 'desc').get();
  res.json({ messages: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

app.patch('/api/admin/messages/:id', requireAdmin, async (req, res) => {
  await db.collection('messages').doc(req.params.id).update({ read: Boolean(req.body.read) });
  res.json({ ok: true });
});

app.delete('/api/admin/messages/:id', requireAdmin, async (req, res) => {
  await db.collection('messages').doc(req.params.id).delete();
  res.json({ ok: true });
});

// ---------- Admin: purchases (reads from `orders`) ----------
app.get('/api/admin/purchases', requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('orders').orderBy('paidAt', 'desc').limit(200).get();
    res.json({ purchases: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    // If paidAt index doesn't exist yet, fall back to unordered
    const snap = await db.collection('orders').limit(200).get();
    res.json({ purchases: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  }
});

// ---------- Paystack: initialize ----------
app.post('/api/pay/initialize', async (req, res) => {
  try {
    const { projectId, email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const doc = await db.collection('projects').doc(projectId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Project not found' });

    const project = normalizeProject(doc.id, doc.data());
    if (!project.released) return res.status(403).json({ error: 'Project not available' });
    if (!project.price || project.price <= 0) return res.status(400).json({ error: 'Project has no valid price' });

    const origin = req.headers.origin || `http://localhost:${process.env.PORT || 3000}`;

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        amount: Math.round(project.price * 100),
        currency: 'NGN',
        callback_url: `${origin}/payment/complete`,
        metadata: { projectId: project.id, projectTitle: project.title }
      })
    });
    const data = await response.json();
    if (!data.status) throw new Error(data.message || 'Paystack init failed');
    res.json({ authorizationUrl: data.data.authorization_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Paystack: verify + record order ----------
app.get('/payment/complete', async (req, res) => {
  const { reference } = req.query;
  let success = false, title = '', message = 'No reference.';
  if (reference) {
    try {
      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
      );
      const data = await response.json();
      if (data.status && data.data.status === 'success') {
        success = true;
        title = data.data.metadata?.projectTitle || '';
        message = 'Payment confirmed. Access granted.';
        const ref = db.collection('orders').doc(reference);
        const existing = await ref.get();
        if (!existing.exists) {
          await ref.set({
            reference,
            projectId: data.data.metadata?.projectId || '',
            projectTitle: title,
            email: data.data.customer?.email || '',
            amountNGN: (data.data.amount || 0) / 100,
            amount: (data.data.amount || 0) / 100,
            paidAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      } else {
        message = `Status: ${data.data?.status || 'unknown'}`;
      }
    } catch (err) { message = err.message; }
  }
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment</title>
<style>body{background:#050507;color:#e4e4e9;font-family:monospace;text-align:center;padding:100px 20px}
h1{color:${success ? '#29ff7a' : '#ff2b2b'};letter-spacing:.2em}
a{color:#29ff7a;border:1px solid #ff2b2b;padding:12px 24px;text-decoration:none;display:inline-block;margin-top:24px;font-size:11px;letter-spacing:.2em;text-transform:uppercase}</style></head>
<body><h1>${success ? 'TRANSACTION COMPLETE' : 'TRANSACTION FAILED'}</h1>
${title ? `<p style="color:#fff">${title}</p>` : ''}<p>${message}</p>
<a href="/">Return to Portal</a></body></html>`);
});

// ---------- Serve admin ----------
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`ETHICAL DARK X → http://localhost:${process.env.PORT || 3000}`);
});