require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const adminRouter = require('./admin');

const app = express();

// Security & Middleware
app.use(helmet({ contentSecurityPolicy: false })); // Relaxed for embedded UI
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// Rate Limiting
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { success: false, error: { message: "Too many requests" } } });
app.use('/api/', apiLimiter);

// MongoDB Serverless Connection Strategy
let cachedDb = global.mongoose;
if (!cachedDb) cachedDb = global.mongoose = { conn: null, promise: null };

async function connectDB() {
    if (cachedDb.conn) return cachedDb.conn;
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');
    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(process.env.MONGODB_URI, {
            dbName: process.env.MONGODB_DB_NAME || 'medibloom',
            serverSelectionTimeoutMS: 5000,
        }).then(m => m);
    }
    cachedDb.conn = await cachedDb.promise;
    await initializeData();
    return cachedDb.conn;
}

// Database Connection Middleware
app.use(async (req, res, next) => {
    try { await connectDB(); next(); }
    catch (err) { res.status(503).json({ success: false, error: { message: "Database connection failed", details: err.message } }); }
});

// ---------------------------------------------
// MongoDB Schemas
// ---------------------------------------------
const doctorSchema = new mongoose.Schema({
    name: String, specialty: String, qualification: String, experience: Number,
    bio: String, image: String, fee: Number, isActive: { type: Boolean, default: true },
    schedule: { start: { type: String, default: "09:00" }, end: { type: String, default: "18:00" } }
}, { timestamps: true });

const appointmentSchema = new mongoose.Schema({
    reference: { type: String, unique: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
    doctorSnapshot: Object,
    patientName: String, mobile: String, email: String, age: Number, reason: String,
    date: String, // YYYY-MM-DD
    startTime: String, // HH:MM
    status: { type: String, enum: ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'], default: 'pending' },
    feeSnapshot: Number
}, { timestamps: true });

// Prevent Concurrent Double Bookings via Unique Index
appointmentSchema.index(
    { doctorId: 1, date: 1, startTime: 1 },
    { unique: true, partialFilterExpression: { status: { $in: ['pending', 'confirmed'] } } }
);

const AdminSchema = new mongoose.Schema({ username: { type: String, unique: true }, passwordHash: String }, { timestamps: true });
const ClinicSettingSchema = new mongoose.Schema({ name: String, tagline: String, phone: String, address: String, slotDuration: Number }, { timestamps: true });

const Doctor = mongoose.models.Doctor || mongoose.model('Doctor', doctorSchema);
const Appointment = mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema);
const Admin = mongoose.models.Admin || mongoose.model('Admin', AdminSchema);
const ClinicSetting = mongoose.models.ClinicSetting || mongoose.model('ClinicSetting', ClinicSettingSchema);

// ---------------------------------------------
// Data Initialization
// ---------------------------------------------
async function initializeData() {
    if (await Doctor.countDocuments() === 0) {
        const demoDoctors = [
            { name: "Dr. Aanya Sharma", specialty: "General Physician", qualification: "MBBS, MD", experience: 12, fee: 500, image: "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=300&q=80&fit=crop" },
            { name: "Dr. Rohan Verma", specialty: "Cardiologist", qualification: "MBBS, MD, DM", experience: 15, fee: 800, image: "https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=300&q=80&fit=crop" },
            { name: "Dr. Meera Singh", specialty: "Pediatrician", qualification: "MBBS, MD Pediatrics", experience: 10, fee: 600, image: "https://images.unsplash.com/photo-1594824436998-d40d5b5ebda8?w=300&q=80&fit=crop" },
            { name: "Dr. Arjun Das", specialty: "Dermatologist", qualification: "MBBS, MD Dermatology", experience: 8, fee: 700, image: "https://images.unsplash.com/photo-1622253692010-333f2da6031d?w=300&q=80&fit=crop" },
            { name: "Dr. Priya Nair", specialty: "Gynecologist", qualification: "MBBS, MS OBGYN", experience: 11, fee: 600, image: "https://images.unsplash.com/photo-1614608682850-e0d6ed316d47?w=300&q=80&fit=crop" },
            { name: "Dr. Kabir Malhotra", specialty: "Orthopedic", qualification: "MBBS, MS Ortho", experience: 9, fee: 750, image: "https://images.unsplash.com/photo-1537368910025-700350fe46c7?w=300&q=80&fit=crop" }
        ];
        await Doctor.insertMany(demoDoctors);
    }
    if (await ClinicSetting.countDocuments() === 0) {
        await ClinicSetting.create({ name: "MediBloom Multispeciality Clinic", tagline: "Your Health, Our Heart", phone: "+91 98765 43210", address: "Saraidhela, Dhanbad, Jharkhand", slotDuration: 20 });
    }
    if (await Admin.countDocuments() === 0 && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
        const bcrypt = require('bcryptjs');
        await Admin.create({ username: process.env.ADMIN_USERNAME, passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 10) });
    }
}

// ---------------------------------------------
// Public APIs
// ---------------------------------------------
app.get('/api/health', (req, res) => res.json({ success: true, message: "MediBloom API is running" }));
app.get('/api/clinic', async (req, res) => res.json({ success: true, data: await ClinicSetting.findOne() }));
app.get('/api/doctors', async (req, res) => res.json({ success: true, data: await Doctor.find({ isActive: true }).select('-__v') }));

app.get('/api/availability', async (req, res) => {
    try {
        const { doctorId, date } = req.query;
        if (!doctorId || !date) return res.status(400).json({ success: false, error: { message: "Doctor ID and date required" } });
        
        const doctor = await Doctor.findById(doctorId);
        if (!doctor) return res.status(404).json({ success: false, error: { message: "Doctor not found" } });
        
        const settings = await ClinicSetting.findOne();
        const duration = settings.slotDuration || 20;

        const booked = await Appointment.find({ doctorId, date, status: { $in: ['pending', 'confirmed'] } }).select('startTime');
        const bookedTimes = booked.map(b => b.startTime);

        let slots = [];
        let [hour, minute] = doctor.schedule.start.split(':').map(Number);
        const [endHour, endMinute] = doctor.schedule.end.split(':').map(Number);
        
        // India Time check for past slots
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const isToday = (date === now.toISOString().split('T')[0]);

        while (hour < endHour || (hour === endHour && minute < endMinute)) {
            const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            const slotTime = new Date(`${date}T${timeStr}:00`);
            
            if (!bookedTimes.includes(timeStr)) {
                if (!isToday || (isToday && slotTime > now)) {
                    slots.push(timeStr);
                }
            }
            minute += duration;
            if (minute >= 60) { hour += 1; minute -= 60; }
        }
        res.json({ success: true, data: slots });
    } catch (err) { res.status(500).json({ success: false, error: { message: err.message } }); }
});

app.post('/api/appointments', async (req, res) => {
    try {
        const { doctorId, date, startTime, patientName, mobile, email, age, reason } = req.body;
        if (!patientName || !mobile || !mobile.match(/^[6-9]\d{9}$/) || !doctorId || !date || !startTime) {
            return res.status(400).json({ success: false, error: { message: "Invalid or missing fields. Require valid Indian mobile." } });
        }
        const doctor = await Doctor.findById(doctorId);
        if (!doctor || !doctor.isActive) return res.status(404).json({ success: false, error: { message: "Doctor unavailable" } });

        const reference = 'MB-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        
        const apt = new Appointment({
            reference, doctorId, patientName, mobile, email, age, reason, date, startTime,
            feeSnapshot: doctor.fee, doctorSnapshot: { name: doctor.name, specialty: doctor.specialty }
        });
        
        await apt.save();
        res.json({ success: true, data: apt, message: "Appointment booked successfully" });
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ success: false, error: { message: "This slot was just booked. Please choose another." } });
        res.status(500).json({ success: false, error: { message: err.message } });
    }
});

app.get('/api/appointments/:ref', async (req, res) => {
    const apt = await Appointment.findOne({ reference: req.params.ref }).select('-__v');
    if (!apt) return res.status(404).json({ success: false, error: { message: "Not found" } });
    res.json({ success: true, data: apt });
});

// ---------------------------------------------
// Mount Admin Router
// ---------------------------------------------
app.use('/admin', adminRouter(mongoose));

// ---------------------------------------------
// Frontend HTML/CSS/JS Generators
// ---------------------------------------------
app.get('/style.css', (req, res) => {
    res.setHeader('Content-Type', 'text/css');
    res.send(`
        :root {
            --bg: #FFF9F2; --primary: #8B7CF6; --primary-hover: #7563f5;
            --secondary: #8BDCC3; --accent: #FF907D; --yellow: #FFE6A7;
            --text: #252641; --muted: #777991; --danger: #E85D75; --success: #35B982;
            --clay-shadow: 8px 8px 16px #e3ded8, -8px -8px 16px #ffffff;
            --clay-inset: inset 4px 4px 8px rgba(255,255,255,0.7), inset -4px -4px 8px rgba(0,0,0,0.05);
            --font-main: 'Plus Jakarta Sans', sans-serif;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: var(--font-main); background: var(--bg); color: var(--text); overflow-x: hidden; line-height: 1.6; }
        
        /* Layouts & Typography */
        .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; }
        h1, h2, h3 { font-weight: 700; color: var(--text); }
        h1 { font-size: 3.5rem; line-height: 1.2; margin-bottom: 20px; }
        h2 { font-size: 2.5rem; margin-bottom: 40px; text-align: center; }
        
        /* Claymorphism Utils */
        .clay-card {
            background: var(--bg); border-radius: 30px; box-shadow: var(--clay-shadow);
            border: 2px solid rgba(255,255,255,0.6); transition: transform 0.3s ease;
        }
        .clay-card:hover { transform: translateY(-5px); }
        .clay-btn {
            background: var(--primary); color: white; border: none; border-radius: 99px;
            padding: 14px 28px; font-size: 1.1rem; font-family: inherit; font-weight: 600; cursor: pointer;
            box-shadow: 6px 6px 12px rgba(139,124,246,0.3), inset 3px 3px 6px rgba(255,255,255,0.4), inset -3px -3px 6px rgba(0,0,0,0.1);
            transition: all 0.2s; display: inline-flex; align-items: center; gap: 8px; text-decoration: none;
        }
        .clay-btn:hover { background: var(--primary-hover); transform: translateY(-2px); }
        .clay-btn:active { box-shadow: inset 4px 4px 8px rgba(0,0,0,0.15), inset -4px -4px 8px rgba(255,255,255,0.2); transform: translateY(2px); }
        .clay-btn.secondary { background: var(--bg); color: var(--primary); box-shadow: var(--clay-shadow); }
        .clay-input {
            width: 100%; padding: 14px 20px; border-radius: 20px; border: 2px solid transparent;
            background: var(--bg); box-shadow: inset 4px 4px 8px #e3ded8, inset -4px -4px 8px #ffffff;
            font-family: inherit; font-size: 1rem; color: var(--text); outline: none; transition: border 0.2s;
        }
        .clay-input:focus { border-color: var(--primary); }
        
        /* Navbar */
        nav { padding: 20px 0; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(10px); }
        .nav-content { display: flex; justify-content: space-between; align-items: center; }
        .logo { font-size: 1.5rem; font-weight: 700; display: flex; align-items: center; gap: 10px; color: var(--primary); text-decoration: none; }
        .nav-links { display: flex; gap: 30px; }
        .nav-links a { text-decoration: none; color: var(--text); font-weight: 600; transition: color 0.2s; }
        .nav-links a:hover { color: var(--primary); }
        
        /* Hero Section */
        .hero { display: flex; align-items: center; min-height: 80vh; padding: 40px 0; position: relative; }
        .hero-text { flex: 1; padding-right: 40px; z-index: 2; }
        .hero-text p { font-size: 1.2rem; color: var(--muted); margin-bottom: 30px; }
        .hero-visual { flex: 1; position: relative; display: flex; justify-content: center; }
        .hero-blob { position: absolute; width: 400px; height: 400px; background: var(--secondary); border-radius: 40% 60% 70% 30% / 40% 50% 60% 50%; filter: blur(50px); opacity: 0.5; animation: morph 8s ease-in-out infinite; z-index: 0; }
        @keyframes morph { 0%, 100% { border-radius: 40% 60% 70% 30% / 40% 50% 60% 50%; } 50% { border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%; } }
        .hero-visual img { position: relative; z-index: 1; width: 100%; max-width: 450px; border-radius: 30px; box-shadow: var(--clay-shadow); object-fit: cover; border: 4px solid white; animation: float 6s ease-in-out infinite; }
        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-15px); } }

        /* Doctors Grid */
        .doctors { padding: 80px 0; position: relative; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 40px; }
        .doc-card { padding: 25px; text-align: center; }
        .doc-img { width: 120px; height: 120px; border-radius: 50%; margin: 0 auto 20px; object-fit: cover; border: 4px solid var(--bg); box-shadow: var(--clay-shadow); }
        .doc-spec { color: var(--primary); font-weight: 600; margin: 10px 0; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px; }
        .doc-fee { font-size: 1.2rem; font-weight: 700; margin: 15px 0; }
        
        /* Modal & Booking */
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(37,38,65,0.4); backdrop-filter: blur(5px); z-index: 999; display: none; justify-content: center; align-items: center; opacity: 0; transition: opacity 0.3s; }
        .modal-overlay.active { display: flex; opacity: 1; }
        .modal { width: 90%; max-width: 600px; background: var(--bg); border-radius: 40px; padding: 40px; box-shadow: var(--clay-shadow); position: relative; max-height: 90vh; overflow-y: auto; }
        .close-btn { position: absolute; top: 20px; right: 20px; background: none; border: none; cursor: pointer; color: var(--muted); }
        .step { display: none; animation: fadeIn 0.4s; }
        .step.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        
        .slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 15px; margin-top: 20px; }
        .slot-btn { padding: 12px; border-radius: 15px; border: none; background: var(--bg); box-shadow: var(--clay-shadow); font-weight: 600; cursor: pointer; transition: all 0.2s; color: var(--text); }
        .slot-btn:hover { color: var(--primary); transform: scale(1.05); }
        .slot-btn.selected { background: var(--primary); color: white; box-shadow: inset 3px 3px 6px rgba(0,0,0,0.1); }
        
        .form-group { margin-bottom: 20px; text-align: left; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 600; color: var(--text); }
        
        /* Toast */
        #toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%) translateY(100px); background: var(--text); color: white; padding: 15px 30px; border-radius: 99px; opacity: 0; transition: all 0.3s; z-index: 1000; box-shadow: 0 10px 20px rgba(0,0,0,0.2); }
        #toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
        #toast.error { background: var(--danger); }

        footer { padding: 40px 0; text-align: center; border-top: 2px solid rgba(0,0,0,0.05); margin-top: 80px; color: var(--muted); }

        @media (max-width: 768px) {
            h1 { font-size: 2.5rem; }
            .hero { flex-direction: column; text-align: center; }
            .hero-text { padding-right: 0; margin-bottom: 40px; }
            .nav-links { display: none; } /* Simplified mobile for demo */
        }
    `);
});

app.get('/main.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`
        let state = { doctorId: null, date: null, time: null, doctorObj: null };
        const modal = document.getElementById('bookingModal');
        const overlay = document.getElementById('modalOverlay');
        
        async function fetchDoctors() {
            try {
                const res = await fetch('/api/doctors');
                const json = await res.json();
                if (json.success) renderDoctors(json.data);
            } catch (e) { showToast('Failed to load doctors', true); }
        }

        function renderDoctors(docs) {
            const grid = document.getElementById('doctorsGrid');
            grid.innerHTML = '';
            docs.forEach(doc => {
                grid.innerHTML += \`
                    <div class="clay-card doc-card">
                        <img src="\${doc.image}" class="doc-img" alt="\${doc.name}" onerror="this.src='https://ui-avatars.com/api/?name=\${doc.name}&background=8B7CF6&color=fff'">
                        <h3>\${doc.name}</h3>
                        <p class="doc-spec">\${doc.specialty}</p>
                        <p style="color: var(--muted); font-size: 0.9rem;">\${doc.experience} Years Exp. | \${doc.qualification}</p>
                        <p class="doc-fee">₹\${doc.fee} / Visit</p>
                        <button class="clay-btn w-100" onclick='startBooking(\${JSON.stringify(doc)})' style="width:100%; justify-content:center;">Book Now</button>
                    </div>
                \`;
            });
        }

        function startBooking(doc) {
            state.doctorId = doc._id; state.doctorObj = doc; state.date = null; state.time = null;
            document.getElementById('b-doc-name').innerText = doc.name;
            const today = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
            document.getElementById('b-date').min = new Date(today).toISOString().split('T')[0];
            document.getElementById('b-date').value = '';
            showStep(1); overlay.classList.add('active');
        }

        function closeBooking() { overlay.classList.remove('active'); }
        
        function showStep(n) {
            document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
            document.getElementById('step' + n).classList.add('active');
        }

        async function fetchSlots() {
            const date = document.getElementById('b-date').value;
            if(!date) return showToast('Select a date', true);
            state.date = date;
            
            const btn = document.getElementById('btn-fetch-slots');
            btn.innerText = "Loading..."; btn.disabled = true;
            
            try {
                const res = await fetch(\`/api/availability?doctorId=\${state.doctorId}&date=\${date}\`);
                const json = await res.json();
                if(json.success) {
                    renderSlots(json.data);
                    showStep(2);
                } else showToast(json.error.message, true);
            } catch(e) { showToast('Error fetching slots', true); }
            btn.innerText = "Check Availability"; btn.disabled = false;
        }

        function renderSlots(slots) {
            const grid = document.getElementById('slotGrid');
            if(slots.length === 0) {
                grid.innerHTML = '<p style="grid-column: 1/-1; color: var(--danger);">No slots available on this date.</p>';
                document.getElementById('btn-to-details').style.display = 'none';
                return;
            }
            document.getElementById('btn-to-details').style.display = 'inline-flex';
            grid.innerHTML = slots.map(s => \`<button class="slot-btn" onclick="selectSlot(this, '\${s}')">\${s}</button>\`).join('');
        }

        function selectSlot(btn, time) {
            document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            state.time = time;
        }

        function goToDetails() {
            if(!state.time) return showToast('Please select a time slot', true);
            document.getElementById('summary-text').innerText = \`\${state.doctorObj.name} on \${state.date} at \${state.time}\`;
            showStep(3);
        }

        async function submitBooking(e) {
            e.preventDefault();
            const btn = document.getElementById('btn-submit-booking');
            btn.innerText = "Booking..."; btn.disabled = true;
            
            const payload = {
                doctorId: state.doctorId, date: state.date, startTime: state.time,
                patientName: document.getElementById('p-name').value,
                mobile: document.getElementById('p-mobile').value,
                email: document.getElementById('p-email').value,
                age: document.getElementById('p-age').value,
                reason: document.getElementById('p-reason').value
            };

            try {
                const res = await fetch('/api/appointments', {
                    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
                });
                const json = await res.json();
                if(json.success) {
                    document.getElementById('success-ref').innerText = json.data.reference;
                    showStep(4);
                } else { showToast(json.error.message, true); }
            } catch(e) { showToast('Server error', true); }
            btn.innerText = "Confirm Booking"; btn.disabled = false;
        }

        function showToast(msg, isError = false) {
            const t = document.getElementById('toast');
            t.innerText = msg;
            t.className = isError ? 'error show' : 'show';
            setTimeout(() => t.classList.remove('show'), 3000);
        }

        document.addEventListener('DOMContentLoaded', () => {
            lucide.createIcons();
            fetchDoctors();
            document.getElementById('bookingForm').addEventListener('submit', submitBooking);
            
            // Close modal on escape
            document.addEventListener('keydown', (e) => { if(e.key === 'Escape') closeBooking(); });
        });
    `);
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>MediBloom Clinic | Online OPD Booking</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="/style.css">
        <script src="https://unpkg.com/lucide@latest"></script>
    </head>
    <body>
        <nav>
            <div class="container nav-content">
                <a href="/" class="logo"><i data-lucide="heart-pulse"></i> MediBloom</a>
                <div class="nav-links">
                    <a href="#about">About</a>
                    <a href="#doctors">Doctors</a>
                    <a href="#contact">Contact</a>
                    <a href="/admin" style="color: var(--primary);">Admin</a>
                </div>
            </div>
        </nav>

        <header class="container hero">
            <div class="hero-text">
                <h1>Better Healthcare Starts With One Simple Booking.</h1>
                <p>Skip the waiting room. Book your OPD appointment securely online with our top-rated specialists at MediBloom Multispeciality Clinic.</p>
                <div style="display:flex; gap: 15px;">
                    <a href="#doctors" class="clay-btn"><i data-lucide="calendar-check"></i> Book Your Appointment</a>
                </div>
                <div style="margin-top: 30px; display:flex; gap:20px; color: var(--muted); font-size:0.9rem;">
                    <span><i data-lucide="check-circle" style="width:16px; margin-bottom:-3px;"></i> Verified Doctors</span>
                    <span><i data-lucide="clock" style="width:16px; margin-bottom:-3px;"></i> Instant Confirmation</span>
                </div>
            </div>
            <div class="hero-visual">
                <div class="hero-blob"></div>
                <img src="https://images.unsplash.com/photo-1638202993928-7267aad84c31?w=600&q=80" alt="Clinic Welcome">
            </div>
        </header>

        <section id="doctors" class="container doctors">
            <h2>Our Specialists</h2>
            <div class="grid" id="doctorsGrid">
                <!-- Doctors injected here via JS -->
            </div>
        </section>

        <!-- Booking Modal -->
        <div class="modal-overlay" id="modalOverlay">
            <div class="modal">
                <button class="close-btn" onclick="closeBooking()"><i data-lucide="x"></i></button>
                
                <div class="step" id="step1">
                    <h2>Select Date</h2>
                    <p style="text-align:center; margin-bottom:20px;">Booking for <strong id="b-doc-name" style="color:var(--primary);"></strong></p>
                    <div class="form-group">
                        <label>Appointment Date</label>
                        <input type="date" id="b-date" class="clay-input" required>
                    </div>
                    <button class="clay-btn w-100" id="btn-fetch-slots" onclick="fetchSlots()" style="width:100%; justify-content:center;">Check Availability</button>
                </div>

                <div class="step" id="step2">
                    <h2>Select Time</h2>
                    <div id="slotGrid" class="slot-grid"></div>
                    <div style="display:flex; gap:10px; margin-top:30px;">
                        <button class="clay-btn secondary" onclick="showStep(1)" style="flex:1; justify-content:center;">Back</button>
                        <button class="clay-btn" id="btn-to-details" onclick="goToDetails()" style="flex:1; justify-content:center;">Next</button>
                    </div>
                </div>

                <div class="step" id="step3">
                    <h2>Patient Details</h2>
                    <p style="margin-bottom: 20px; font-size:0.9rem; text-align:center; background: var(--yellow); padding: 10px; border-radius: 10px;">Summary: <span id="summary-text"></span></p>
                    <form id="bookingForm">
                        <div class="form-group"><label>Full Name *</label><input type="text" id="p-name" class="clay-input" required maxlength="50"></div>
                        <div style="display:flex; gap:15px;">
                            <div class="form-group" style="flex:2;"><label>Mobile * (10-digit)</label><input type="tel" pattern="^[6-9]\\d{9}$" id="p-mobile" class="clay-input" required title="Valid Indian Mobile Number"></div>
                            <div class="form-group" style="flex:1;"><label>Age</label><input type="number" id="p-age" class="clay-input" min="0" max="120"></div>
                        </div>
                        <div class="form-group"><label>Email (Optional)</label><input type="email" id="p-email" class="clay-input"></div>
                        <div class="form-group"><label>Reason for Visit</label><input type="text" id="p-reason" class="clay-input" maxlength="100"></div>
                        <p style="font-size:0.8rem; color:var(--muted); margin-bottom: 20px;">By confirming, you agree to our privacy policy and demo disclaimer.</p>
                        <div style="display:flex; gap:10px;">
                            <button type="button" class="clay-btn secondary" onclick="showStep(2)" style="flex:1; justify-content:center;">Back</button>
                            <button type="submit" class="clay-btn" id="btn-submit-booking" style="flex:2; justify-content:center;">Confirm Booking</button>
                        </div>
                    </form>
                </div>

                <div class="step" id="step4" style="text-align:center;">
                    <div style="color: var(--success); margin-bottom: 20px;"><i data-lucide="check-circle" style="width:64px; height:64px;"></i></div>
                    <h2>Booking Confirmed!</h2>
                    <p>Your appointment reference is:</p>
                    <h3 style="font-size:2rem; color:var(--primary); margin:20px 0;" id="success-ref"></h3>
                    <p style="color:var(--muted); margin-bottom:30px;">Please keep this reference number for your records. Show it at the reception.</p>
                    <button class="clay-btn" onclick="closeBooking()">Done</button>
                </div>
            </div>
        </div>

        <div id="toast"></div>

        <footer class="container">
            <p><strong>MediBloom Multispeciality Clinic</strong> | Saraidhela, Dhanbad, Jharkhand, India</p>
            <p style="font-size: 0.9rem; margin-top: 10px;">Demo Disclaimer: This is a fictional demonstration application. No real bookings are processed.</p>
        </footer>

        <script src="/main.js"></script>
    </body>
    </html>
    `);
});

module.exports = app;
