const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = function (mongoose) {
    const router = express.Router();
    
    // Auth Middleware
    const requireAuth = (req, res, next) => {
        const token = req.cookies.admin_token;
        if (!token) return res.status(401).json({ success: false, error: { message: "Unauthorized" } });
        try {
            const decoded = jwt.verify(token, process.env.SESSION_SECRET || 'fallback_dev_secret');
            req.adminId = decoded.id;
            next();
        } catch (err) { res.status(401).json({ success: false, error: { message: "Invalid session" } }); }
    };

    // ---------------------------------------------
    // Admin APIs
    // ---------------------------------------------
    router.post('/api/login', async (req, res) => {
        try {
            const { username, password } = req.body;
            const Admin = mongoose.model('Admin');
            const admin = await Admin.findOne({ username });
            
            if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
                return res.status(401).json({ success: false, error: { message: "Invalid credentials" } });
            }
            
            const token = jwt.sign({ id: admin._id }, process.env.SESSION_SECRET || 'fallback_dev_secret', { expiresIn: '8h' });
            res.cookie('admin_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 8*60*60*1000 });
            res.json({ success: true, message: "Logged in" });
        } catch (err) { res.status(500).json({ success: false, error: { message: err.message } }); }
    });

    router.post('/api/logout', (req, res) => {
        res.clearCookie('admin_token');
        res.json({ success: true });
    });

    router.get('/api/dashboard', requireAuth, async (req, res) => {
        try {
            const Appointment = mongoose.model('Appointment');
            const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toISOString().split('T')[0];
            
            const [total, pending, confirmed, completed, todayCount] = await Promise.all([
                Appointment.countDocuments(),
                Appointment.countDocuments({ status: 'pending' }),
                Appointment.countDocuments({ status: 'confirmed' }),
                Appointment.countDocuments({ status: 'completed' }),
                Appointment.countDocuments({ date: today })
            ]);
            res.json({ success: true, data: { total, pending, confirmed, completed, todayCount } });
        } catch (err) { res.status(500).json({ success: false }); }
    });

    router.get('/api/appointments', requireAuth, async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = 20;
            const Appointment = mongoose.model('Appointment');
            
            const appointments = await Appointment.find()
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit);
            res.json({ success: true, data: appointments });
        } catch (err) { res.status(500).json({ success: false }); }
    });

    router.patch('/api/appointments/:id', requireAuth, async (req, res) => {
        try {
            const { status } = req.body;
            if (!['pending', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(status)) {
                return res.status(400).json({ success: false, error: { message: "Invalid status" } });
            }
            const Appointment = mongoose.model('Appointment');
            const apt = await Appointment.findByIdAndUpdate(req.params.id, { status }, { new: true });
            res.json({ success: true, data: apt });
        } catch (err) { res.status(500).json({ success: false }); }
    });

    // ---------------------------------------------
    // Admin Static Assets
    // ---------------------------------------------
    router.get('/style.css', (req, res) => {
        res.setHeader('Content-Type', 'text/css');
        res.send(`
            :root {
                --bg: #FFF9F2; --primary: #8B7CF6; --sidebar: #252641;
                --text: #252641; --muted: #777991; --card: #ffffff;
                --shadow: 8px 8px 16px #e3ded8, -8px -8px 16px #ffffff;
                --font: 'Plus Jakarta Sans', sans-serif;
            }
            * { margin:0; padding:0; box-sizing:border-box; font-family: var(--font); }
            body { background: var(--bg); display: flex; height: 100vh; overflow: hidden; }
            
            .login-wrapper { width: 100vw; height: 100vh; display: flex; justify-content: center; align-items: center; position: absolute; top:0; left:0; background: var(--bg); z-index: 1000; }
            .login-box { background: var(--bg); padding: 40px; border-radius: 30px; box-shadow: var(--shadow); width: 100%; max-width: 400px; text-align: center; }
            .login-box input { width: 100%; padding: 15px; margin-bottom: 20px; border-radius: 15px; border:none; background: var(--bg); box-shadow: inset 4px 4px 8px #e3ded8, inset -4px -4px 8px #ffffff; outline:none; }
            .login-box button { width: 100%; padding: 15px; border-radius: 15px; border:none; background: var(--primary); color:white; font-weight:bold; cursor:pointer; }
            
            .sidebar { width: 250px; background: var(--sidebar); color: white; padding: 30px 20px; display: flex; flex-direction: column; gap: 20px; }
            .sidebar h2 { font-size: 1.5rem; margin-bottom: 20px; color: #8BDCC3; }
            .nav-item { padding: 12px 15px; border-radius: 10px; cursor: pointer; transition: 0.2s; color: #b0b1c0; font-weight: 500; display:flex; align-items:center; gap: 10px;}
            .nav-item:hover, .nav-item.active { background: rgba(255,255,255,0.1); color: white; }
            
            .main-content { flex: 1; padding: 40px; overflow-y: auto; }
            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 40px; }
            .stat-card { background: var(--bg); padding: 25px; border-radius: 20px; box-shadow: var(--shadow); text-align: center; }
            .stat-card h3 { font-size: 2.5rem; color: var(--primary); margin-bottom: 5px; }
            .stat-card p { color: var(--muted); font-weight: 500; }
            
            table { width: 100%; border-collapse: collapse; margin-top: 20px; background: var(--bg); box-shadow: var(--shadow); border-radius: 20px; overflow: hidden; }
            th, td { padding: 15px 20px; text-align: left; border-bottom: 1px solid rgba(0,0,0,0.05); }
            th { background: rgba(139, 124, 246, 0.1); font-weight: 600; }
            .status-badge { padding: 5px 10px; border-radius: 99px; font-size: 0.8rem; font-weight:bold; text-transform: uppercase; }
            .status-pending { background: #FFE6A7; color: #b38600; }
            .status-confirmed { background: #A8D8FF; color: #0056b3; }
            .status-completed { background: #8BDCC3; color: #1f7a5c; }
            .status-cancelled { background: #E85D75; color: white; }
            
            .action-btn { padding: 6px 12px; border:none; border-radius:8px; cursor:pointer; font-weight:bold; font-size:0.8rem; margin-right:5px;}
            .btn-confirm { background: #A8D8FF; color: #0056b3;}
            .btn-complete { background: #8BDCC3; color: #1f7a5c;}
            .btn-cancel { background: #E85D75; color: white;}
            
            #toast { position:fixed; bottom:20px; right:20px; background:#333; color:white; padding:15px 25px; border-radius:10px; display:none; }
        `);
    });

    router.get('/main.js', (req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.send(`
            function showToast(msg) {
                const t = document.getElementById('toast');
                t.innerText = msg; t.style.display = 'block';
                setTimeout(() => t.style.display = 'none', 3000);
            }

            async function checkAuth() {
                try {
                    const res = await fetch('/admin/api/dashboard');
                    if(res.status === 401) { document.getElementById('loginWrapper').style.display = 'flex'; }
                    else { 
                        document.getElementById('loginWrapper').style.display = 'none'; 
                        loadDashboard(); loadAppointments();
                    }
                } catch(e) { console.error(e); }
            }

            async function login(e) {
                e.preventDefault();
                const u = document.getElementById('username').value;
                const p = document.getElementById('password').value;
                const res = await fetch('/admin/api/login', {
                    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({username:u, password:p})
                });
                const json = await res.json();
                if(json.success) { showToast('Logged in'); checkAuth(); }
                else { alert(json.error.message); }
            }

            async function logout() {
                await fetch('/admin/api/logout', { method: 'POST' });
                window.location.reload();
            }

            async function loadDashboard() {
                const res = await fetch('/admin/api/dashboard');
                const {data} = await res.json();
                document.getElementById('stat-today').innerText = data.todayCount;
                document.getElementById('stat-pending').innerText = data.pending;
                document.getElementById('stat-confirmed').innerText = data.confirmed;
                document.getElementById('stat-total').innerText = data.total;
            }

            async function loadAppointments() {
                const res = await fetch('/admin/api/appointments');
                const {data} = await res.json();
                const tbody = document.getElementById('apt-body');
                tbody.innerHTML = data.map(apt => \`
                    <tr>
                        <td>\${apt.reference}</td>
                        <td>\${apt.patientName}<br><small style="color:var(--muted)">\${apt.mobile}</small></td>
                        <td>\${apt.doctorSnapshot?.name}</td>
                        <td>\${apt.date} at \${apt.startTime}</td>
                        <td><span class="status-badge status-\${apt.status}">\${apt.status}</span></td>
                        <td>
                            \${apt.status === 'pending' ? \`<button class="action-btn btn-confirm" onclick="updateStatus('\${apt._id}', 'confirmed')">Confirm</button>\` : ''}
                            \${['pending', 'confirmed'].includes(apt.status) ? \`
                                <button class="action-btn btn-complete" onclick="updateStatus('\${apt._id}', 'completed')">Complete</button>
                                <button class="action-btn btn-cancel" onclick="updateStatus('\${apt._id}', 'cancelled')">Cancel</button>
                            \` : ''}
                        </td>
                    </tr>
                \`).join('');
            }

            async function updateStatus(id, status) {
                if(status==='cancelled' && !confirm('Are you sure you want to cancel this appointment?')) return;
                const res = await fetch(\`/admin/api/appointments/\${id}\`, {
                    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({status})
                });
                if(res.ok) { showToast('Status updated'); loadDashboard(); loadAppointments(); }
            }

            document.addEventListener('DOMContentLoaded', () => {
                lucide.createIcons();
                checkAuth();
                document.getElementById('loginForm').addEventListener('submit', login);
            });
        `);
    });

    router.get('/', (req, res) => {
        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>MediBloom Admin Dashboard</title>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700&display=swap" rel="stylesheet">
            <link rel="stylesheet" href="/admin/style.css">
            <script src="https://unpkg.com/lucide@latest"></script>
        </head>
        <body>
            <!-- Login Overlay -->
            <div class="login-wrapper" id="loginWrapper">
                <div class="login-box">
                    <h2 style="margin-bottom:20px; color:var(--primary);"><i data-lucide="shield"></i> Admin Login</h2>
                    <form id="loginForm">
                        <input type="text" id="username" placeholder="Username" required>
                        <input type="password" id="password" placeholder="Password" required>
                        <button type="submit">Secure Login</button>
                    </form>
                </div>
            </div>

            <!-- Dashboard -->
            <div class="sidebar">
                <h2>MediBloom</h2>
                <div class="nav-item active"><i data-lucide="layout-dashboard"></i> Dashboard</div>
                <div class="nav-item" onclick="logout()"><i data-lucide="log-out"></i> Logout</div>
            </div>

            <div class="main-content">
                <h1 style="margin-bottom:30px;">Overview</h1>
                
                <div class="stats-grid">
                    <div class="stat-card"><h3 id="stat-today">-</h3><p>Today's Appointments</p></div>
                    <div class="stat-card"><h3 id="stat-pending">-</h3><p>Pending</p></div>
                    <div class="stat-card"><h3 id="stat-confirmed">-</h3><p>Confirmed</p></div>
                    <div class="stat-card"><h3 id="stat-total">-</h3><p>Total Bookings</p></div>
                </div>

                <h2>Recent Appointments</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Ref #</th>
                            <th>Patient</th>
                            <th>Doctor</th>
                            <th>Date & Time</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="apt-body">
                        <!-- Injected via JS -->
                    </tbody>
                </table>
            </div>

            <div id="toast"></div>
            <script src="/admin/main.js"></script>
        </body>
        </html>
        `);
    });

    return router;
};
