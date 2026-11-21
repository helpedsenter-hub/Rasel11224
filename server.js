require("dotenv").config();
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const crypto = require("crypto");
const path = require("path");

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false } : undefined
});
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || "development-only-change-me",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.notice = req.session.notice || null;
  delete req.session.notice;
  next();
});

const safeUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, referral_code: u.referral_code });
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const requireAuth = (req,res,next) => req.session.user ? next() : res.redirect("/login");
const requireAdmin = (req,res,next) => req.session.user?.role === "admin" ? next() : res.status(403).render("message",{title:"Access denied",message:"Admin access is required."});
const money = n => Number(n).toFixed(2);

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer',
      referral_code TEXT UNIQUE NOT NULL, referred_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      price NUMERIC(10,2) NOT NULL CHECK (price >= 0), image_url TEXT DEFAULT '',
      active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      referral_user_id INTEGER REFERENCES users(id),
      customer_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
      product_id INTEGER REFERENCES products(id), product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1, total NUMERIC(10,2) NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash_on_delivery',
      payment_status TEXT NOT NULL DEFAULT 'pending',
      status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS commissions (
      id SERIAL PRIMARY KEY, referrer_id INTEGER NOT NULL REFERENCES users(id),
      order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
      amount NUMERIC(10,2) NOT NULL, status TEXT NOT NULL DEFAULT 'approved',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Lightweight migrations for an existing starter database.
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER REFERENCES users(id)");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_user_id INTEGER REFERENCES users(id)");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id)");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_name TEXT");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1");
  await pool.query("ALTER TABLE commissions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved'");
  const missing = await pool.query("SELECT id FROM users WHERE referral_code IS NULL");
  for (const row of missing.rows) {
    await pool.query("UPDATE users SET referral_code=$1 WHERE id=$2", [crypto.randomBytes(5).toString("hex").toUpperCase(), row.id]);
  }
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_unique ON users(referral_code)");
  const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO users(name,email,password_hash,role,referral_code)
       VALUES($1,$2,$3,'admin',$4) ON CONFLICT(email) DO NOTHING`,
      ["Shopping BD Admin", email.toLowerCase(), hash, "ADMIN" + crypto.randomBytes(3).toString("hex").toUpperCase()]
    );
  }
}

app.get("/", asyncRoute(async (req,res) => {
  const { rows } = await pool.query("SELECT * FROM products WHERE active=TRUE ORDER BY created_at DESC");
  res.render("home",{products:rows});
}));
app.get("/register",(req,res)=>res.render("register",{ref:req.query.ref || ""}));
app.post("/register",asyncRoute(async(req,res)=>{
  const {name,email,password,referral_code}=req.body;
  if(!name?.trim() || !email?.trim() || !password || password.length<8)
    return res.status(400).render("register",{error:"Enter your name, valid email and a password of at least 8 characters.",ref:referral_code||""});
  let referrerId = null;
  if (referral_code?.trim()) {
    const r = await pool.query("SELECT id FROM users WHERE referral_code=$1 AND role='customer'", [referral_code.trim().toUpperCase()]);
    if (!r.rows[0]) return res.status(400).render("register",{error:"Referral code is invalid.",ref:referral_code});
    referrerId = r.rows[0].id;
  }
  const hash=await bcrypt.hash(password,12);
  const code=crypto.randomBytes(5).toString("hex").toUpperCase();
  try {
    const {rows}=await pool.query(
      "INSERT INTO users(name,email,password_hash,referral_code,referred_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [name.trim(),email.trim().toLowerCase(),hash,code,referrerId]);
    req.session.user=safeUser(rows[0]); res.redirect("/dashboard");
  } catch(e) {
    if(e.code==="23505") return res.status(409).render("register",{error:"That email is already registered.",ref:referral_code||""});
    throw e;
  }
}));
app.get("/login",(req,res)=>res.render("login"));
app.post("/login",asyncRoute(async(req,res)=>{
  const {rows}=await pool.query("SELECT * FROM users WHERE email=$1",[String(req.body.email||"").toLowerCase().trim()]);
  if(!rows[0] || !(await bcrypt.compare(req.body.password||"",rows[0].password_hash)))
    return res.status(401).render("login",{error:"Email or password is incorrect."});
  req.session.user=safeUser(rows[0]);
  res.redirect(rows[0].role==="admin"?"/admin":"/dashboard");
}));
app.post("/logout",(req,res)=>req.session.destroy(()=>res.redirect("/")));

app.get("/dashboard",requireAuth,asyncRoute(async(req,res)=>{
  const [orders,commissions,referrals]=await Promise.all([
    pool.query("SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC",[req.session.user.id]),
    pool.query("SELECT c.*,o.product_name FROM commissions c JOIN orders o ON o.id=c.order_id WHERE c.referrer_id=$1 ORDER BY c.created_at DESC",[req.session.user.id]),
    pool.query("SELECT COUNT(*)::int AS count FROM users WHERE referred_by=$1",[req.session.user.id])
  ]);
  const total=commissions.rows.reduce((s,c)=>s+Number(c.amount),0);
  res.render("dashboard",{orders:orders.rows,commissions:commissions.rows,referralCount:referrals.rows[0].count,totalCommission:total});
}));

app.post("/checkout",requireAuth,asyncRoute(async(req,res)=>{
  const {name,phone,address,productId,paymentMethod}=req.body;
  const p=await pool.query("SELECT id,name,price FROM products WHERE id=$1 AND active=TRUE",[productId]);
  if(!p.rows[0]) return res.status(400).render("message",{title:"Unavailable",message:"This product is not available."});
  if(!name?.trim() || !phone?.trim() || !address?.trim()) return res.status(400).render("message",{title:"Missing details",message:"Please provide your name, phone and delivery address."});
  const product=p.rows[0];
  const method=["cash_on_delivery","bkash_manual","nagad_manual"].includes(paymentMethod)?paymentMethod:"cash_on_delivery";
  await pool.query(
    `INSERT INTO orders(user_id,referral_user_id,customer_name,phone,address,product_id,product_name,total,payment_method)
     VALUES($1,(SELECT referred_by FROM users WHERE id=$1),$2,$3,$4,$5,$6,$7,$8)`,
    [req.session.user.id,name.trim(),phone.trim(),address.trim(),product.id,product.name,product.price,method]
  );
  req.session.notice="Order submitted. It will appear in your dashboard after confirmation.";
  res.redirect("/dashboard");
}));

app.get("/admin",requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const [products,orders,users]=await Promise.all([
    pool.query("SELECT * FROM products ORDER BY created_at DESC"),
    pool.query("SELECT o.*,u.email FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC"),
    pool.query("SELECT id,name,email,role,referral_code,created_at FROM users ORDER BY created_at DESC LIMIT 200")
  ]);
  res.render("admin",{products:products.rows,orders:orders.rows,users:users.rows,commissionPercent:Number(process.env.REFERRAL_COMMISSION_PERCENT||5)});
}));
app.post("/admin/products",requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const {name,description,price,image_url}=req.body;
  if(!name?.trim() || !Number.isFinite(Number(price)) || Number(price)<0) return res.redirect("/admin");
  await pool.query("INSERT INTO products(name,description,price,image_url) VALUES($1,$2,$3,$4)",[name.trim(),description||"",price,image_url||""]);
  res.redirect("/admin");
}));
app.post("/admin/products/:id/hide",requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  await pool.query("UPDATE products SET active=FALSE WHERE id=$1",[req.params.id]); res.redirect("/admin");
}));
app.post("/admin/orders/:id/status",requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const allowed=["pending","processing","shipped","completed","cancelled"];
  const status=req.body.status;
  if(!allowed.includes(status)) return res.redirect("/admin");
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const result=await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE",[req.params.id]);
    const order=result.rows[0];
    if(order) {
      await client.query("UPDATE orders SET status=$1 WHERE id=$2",[status,order.id]);
      // Referral credit is generated only once, after a real order is marked completed.
      if(status==="completed" && order.referral_user_id && order.referral_user_id !== order.user_id) {
        const rate=Math.min(20,Math.max(0,Number(process.env.REFERRAL_COMMISSION_PERCENT||5)));
        const amount=(Number(order.total)*rate/100).toFixed(2);
        await client.query(
          "INSERT INTO commissions(referrer_id,order_id,amount) VALUES($1,$2,$3) ON CONFLICT(order_id) DO NOTHING",
          [order.referral_user_id,order.id,amount]
        );
      }
      if(status!=="completed") {
        // Do not silently claw back a previously credited commission; admin must handle adjustments transparently.
      }
    }
    await client.query("COMMIT");
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  res.redirect("/admin");
}));
app.use((err,req,res,next)=>{console.error(err);res.status(500).render("message",{title:"Something went wrong",message:"Please try again later."});});
const port=process.env.PORT||3000;
initDb().then(()=>app.listen(port,()=>console.log(`Shopping BD running on ${port}`)))
  .catch(err=>{console.error("Database initialization failed:",err);process.exit(1);});
