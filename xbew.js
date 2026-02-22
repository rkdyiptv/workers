// ============================================
// Xtream Codes to M3U Generator with VOD & Series
// Complete Cloudflare Worker Script
// Created for work.dev hosting
// Credits: RKDYIPTV
// ============================================

// ============ CONFIGURATION ============
const CONFIG = {
    // Authentication (change these)
    HOST: 'b1g.uk',
    USERNAME: '112233',
    PASSWORD: '332211',
    
    // Session timeout (seconds)
    SESSION_TIMEOUT: 3600,
    
    // Cache TTL (seconds)
    CACHE_TTL: {
        CATEGORIES: 300,
        STREAMS: 300,
        VOD: 300,
        SERIES: 300,
        PLAYLIST: 300
    },
    
    // Rate limiting
    RATE_LIMIT: {
        MAX_REQUESTS: 100,
        WINDOW: 60000 // 1 minute
    }
};

// ============ UTILITY CLASSES ============
class SessionManager {
    constructor() {
        this.sessions = new Map();
    }
    
    createSession(user) {
        const token = this.generateToken();
        const expiry = Date.now() + (CONFIG.SESSION_TIMEOUT * 1000);
        this.sessions.set(token, { user, expiry });
        return token;
    }
    
    validateSession(token) {
        // BUG FIX #1: Guard against null/undefined token before Map lookup
        if (!token) return false;
        const session = this.sessions.get(token);
        if (!session) return false;
        if (Date.now() > session.expiry) {
            this.sessions.delete(token);
            return false;
        }
        return session.user;
    }
    
    destroySession(token) {
        this.sessions.delete(token);
    }
    
    generateToken() {
        return crypto.randomUUID();
    }
}

class CacheManager {
    constructor() {
        this.cache = new Map();
    }
    
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }
        return item.value;
    }
    
    set(key, value, ttl) {
        const expiry = Date.now() + (ttl * 1000);
        this.cache.set(key, { value, expiry });
    }
    
    clear() {
        this.cache.clear();
    }
}

class RateLimiter {
    constructor() {
        this.requests = new Map();
    }
    
    isAllowed(ip) {
        const now = Date.now();
        const userRequests = this.requests.get(ip) || [];
        const validRequests = userRequests.filter(t => now - t < CONFIG.RATE_LIMIT.WINDOW);
        
        if (validRequests.length >= CONFIG.RATE_LIMIT.MAX_REQUESTS) {
            return false;
        }
        
        validRequests.push(now);
        this.requests.set(ip, validRequests);
        return true;
    }
}

// ============ MAIN WORKER CLASS ============
class XtreamWorker {
    constructor() {
        this.sessions = new SessionManager();
        this.cache = new CacheManager();
        this.rateLimiter = new RateLimiter();
        this.portalConfig = null;
    }
    
    async handleRequest(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        const clientIP = request.headers.get('CF-Connecting-IP') || 
                        request.headers.get('X-Forwarded-For') || 
                        'unknown';
        
        // Rate limiting
        if (!this.rateLimiter.isAllowed(clientIP)) {
            return this.jsonResponse({ error: 'Rate limit exceeded' }, 429);
        }
        
        // BUG FIX #2: Handle CORS preflight OPTIONS requests
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                }
            });
        }

        try {
            // Public endpoints
            if (path === '/health') {
                return this.handleHealthCheck(request);
            }
            
            // Login page
            if (path === '/login') {
                if (request.method === 'POST') {
                    return this.handleLogin(request);
                }
                return this.renderLoginPage();
            }
            
            // Logout
            if (path === '/logout') {
                return this.handleLogout(request);
            }
            
            // Check authentication for protected routes
            const sessionToken = this.getSessionToken(request);
            // BUG FIX #3: validateSession now safely handles null token (fixed in SessionManager)
            if (!this.sessions.validateSession(sessionToken)) {
                return Response.redirect(`${url.origin}/login`, 302);
            }
            
            // Load portal configuration
            this.portalConfig = await this.loadPortalConfig();
            
            // BUG FIX #4: Root path '/' was duplicated in condition; correctly redirect to dashboard
            if (path === '/') {
                return Response.redirect(`${url.origin}/dashboard`, 302);
            }

            if (path === '/dashboard') {
                return this.renderDashboard(request);
            }
            
            if (path === '/filter') {
                return this.handleFilter(request);
            }
            
            if (path === '/playlist.m3u' || path === '/playlist.m3u8') {
                return this.generatePlaylist(request);
            }
            
            if (path === '/vod.m3u' || path === '/vod.m3u8') {
                return this.generateVODPlaylist(request);
            }
            
            if (path === '/series.m3u' || path === '/series.m3u8') {
                return this.generateSeriesPlaylist(request);
            }
            
            if (path.match(/\/play\/\d+\.m3u8$/)) {
                return this.handleStreamProxy(request);
            }
            
            if (path === '/api/categories') {
                return this.getCategories(request);
            }
            
            if (path === '/api/streams') {
                return this.getStreams(request);
            }
            
            if (path === '/api/vod') {
                return this.getVOD(request);
            }
            
            if (path === '/api/series') {
                return this.getSeries(request);
            }
            
            // 404
            return this.htmlResponse('<h1>404 Not Found</h1><a href="/dashboard">Go to Dashboard</a>', 404);
            
        } catch (error) {
            console.error('Error:', error);
            return this.jsonResponse({ error: error.message }, 500);
        }
    }
    
    // ============ AUTHENTICATION ============
    getSessionToken(request) {
        const cookie = request.headers.get('Cookie') || '';
        const match = cookie.match(/session_token=([^;]+)/);
        return match ? match[1] : null;
    }
    
    async handleLogin(request) {
        // BUG FIX #5: Wrap formData parsing in try/catch to handle malformed requests
        let username, password;
        try {
            const formData = await request.formData();
            username = formData.get('username');
            password = formData.get('password');
        } catch (e) {
            return this.renderLoginPage('Invalid request format');
        }

        // BUG FIX #6: Sanitize inputs — reject if null/empty to prevent bypass
        if (!username || !password) {
            return this.renderLoginPage('Username and password are required');
        }
        
        if (username === CONFIG.USERNAME && password === CONFIG.PASSWORD) {
            const token = this.sessions.createSession(username);
            
            // BUG FIX #7: Added SameSite=Strict to prevent CSRF on the session cookie
            return new Response('Login successful', {
                status: 302,
                headers: {
                    'Location': '/dashboard',
                    'Set-Cookie': `session_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${CONFIG.SESSION_TIMEOUT}`
                }
            });
        }
        
        return this.renderLoginPage('Invalid username or password');
    }
    
    async handleLogout(request) {
        const token = this.getSessionToken(request);
        if (token) {
            this.sessions.destroySession(token);
        }
        
        return new Response('Logged out', {
            status: 302,
            headers: {
                'Location': '/login',
                'Set-Cookie': 'session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
            }
        });
    }
    
    // ============ PORTAL CONFIGURATION ============
    async loadPortalConfig() {
        // In production, store this in KV storage
        // For now, we'll use environment variables or default values
        return {
            url: await this.getEnv('XTREAM_URL', CONFIG.HOST),
            username: await this.getEnv('XTREAM_USERNAME', CONFIG.USERNAME),
            password: await this.getEnv('XTREAM_PASSWORD', CONFIG.PASSWORD)
        };
    }
    
    async getEnv(key, defaultValue) {
        // This would use Cloudflare KV in production
        return defaultValue;
    }
    
    // ============ API PROXY FUNCTIONS ============
    async fetchFromPortal(endpoint) {
        if (!this.portalConfig?.url) {
            throw new Error('Portal not configured');
        }
        
        const cacheKey = `portal_${endpoint}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;
        
        const url = `${this.portalConfig.url}/player_api.php?username=${this.portalConfig.username}&password=${this.portalConfig.password}&${endpoint}`;
        
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'OTT Navigator/1.6.7.4'
                }
            });
            
            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }
            
            const data = await response.json();

            // BUG FIX #8: API may return non-array on error (e.g. object with error key).
            // Ensure we always cache and return an array to prevent .length / .forEach crashes.
            const safeData = Array.isArray(data) ? data : [];
            
            // Cache based on endpoint type
            let ttl = CONFIG.CACHE_TTL.STREAMS;
            if (endpoint.includes('categories')) ttl = CONFIG.CACHE_TTL.CATEGORIES;
            if (endpoint.includes('series')) ttl = CONFIG.CACHE_TTL.SERIES;
            if (endpoint.includes('vod')) ttl = CONFIG.CACHE_TTL.VOD;
            
            this.cache.set(cacheKey, safeData, ttl);
            return safeData;
            
        } catch (error) {
            console.error('Portal fetch error:', error);
            throw error;
        }
    }
    
    async getCategories(request) {
        const type = new URL(request.url).searchParams.get('type') || 'live';
        // BUG FIX #9: Validate 'type' parameter to prevent injection into API endpoint string
        const allowedTypes = ['live', 'vod', 'series'];
        const safeType = allowedTypes.includes(type) ? type : 'live';
        const data = await this.fetchFromPortal(`action=get_${safeType}_categories`);
        return this.jsonResponse(data);
    }
    
    async getStreams(request) {
        const type = new URL(request.url).searchParams.get('type') || 'live';
        // BUG FIX #9 (continued): Same validation for streams endpoint
        const allowedTypes = ['live', 'vod'];
        const safeType = allowedTypes.includes(type) ? type : 'live';
        const data = await this.fetchFromPortal(`action=get_${safeType}_streams`);
        return this.jsonResponse(data);
    }
    
    async getVOD(request) {
        const categoryId = new URL(request.url).searchParams.get('category_id');
        // BUG FIX #10: Validate categoryId is numeric to prevent injection
        const safeCategoryId = categoryId && /^\d+$/.test(categoryId) ? categoryId : null;
        const data = await this.fetchFromPortal(`action=get_vod_streams${safeCategoryId ? `&category_id=${safeCategoryId}` : ''}`);
        return this.jsonResponse(data);
    }
    
    async getSeries(request) {
        const categoryId = new URL(request.url).searchParams.get('category_id');
        // BUG FIX #10 (continued): Same numeric validation for series
        const safeCategoryId = categoryId && /^\d+$/.test(categoryId) ? categoryId : null;
        const data = await this.fetchFromPortal(`action=get_series${safeCategoryId ? `&category_id=${safeCategoryId}` : ''}`);
        return this.jsonResponse(data);
    }
    
    // ============ PLAYLIST GENERATION ============
    async generatePlaylist(request) {
        const url = new URL(request.url);
        const baseUrl = `${url.protocol}//${url.host}`;
        
        // Get filter settings from KV or cookie
        const filterData = await this.getFilterSettings(request);
        
        const [liveStreams, categories] = await Promise.all([
            this.fetchFromPortal('action=get_live_streams'),
            this.fetchFromPortal('action=get_live_categories')
        ]);
        
        const categoryMap = this.createCategoryMap(categories);
        const filteredStreams = this.filterStreams(liveStreams, filterData, categoryMap);
        
        let m3u = '#EXTM3U\n';
        m3u += `#PLAYLIST: Xtream Live Channels - RKDYIPTV\n`;
        m3u += `#GENERATED: ${new Date().toISOString()}\n`;
        m3u += `#TOTAL: ${filteredStreams.length} channels\n\n`;
        
        filteredStreams.forEach(stream => {
            const categoryName = categoryMap[stream.category_id] || 'Unknown';
            const streamUrl = `${baseUrl}/play/${stream.stream_id}.m3u8`;
            
            m3u += `#EXTINF:-1 tvg-id="${stream.stream_id}" tvg-name="${this.escape(stream.name)}" `;
            m3u += `tvg-logo="${stream.stream_icon || ''}" group-title="${this.escape(categoryName)}",`;
            m3u += `${this.escape(stream.name)}\n`;
            m3u += `${streamUrl}\n`;
        });
        
        return new Response(m3u, {
            headers: {
                'Content-Type': 'audio/x-mpegurl',
                'Content-Disposition': 'attachment; filename="live_playlist.m3u"',
                'Cache-Control': 'no-cache'
            }
        });
    }
    
    async generateVODPlaylist(request) {
        const url = new URL(request.url);
        const baseUrl = `${url.protocol}//${url.host}`;
        
        const [vodStreams, categories] = await Promise.all([
            this.fetchFromPortal('action=get_vod_streams'),
            this.fetchFromPortal('action=get_vod_categories')
        ]);
        
        const categoryMap = this.createCategoryMap(categories);
        
        let m3u = '#EXTM3U\n';
        m3u += `#PLAYLIST: Xtream VOD - RKDYIPTV\n`;
        m3u += `#GENERATED: ${new Date().toISOString()}\n`;
        m3u += `#TOTAL: ${vodStreams.length} movies\n\n`;
        
        vodStreams.forEach(movie => {
            const categoryName = categoryMap[movie.category_id] || 'Unknown';
            const streamUrl = `${baseUrl}/play/${movie.stream_id}.m3u8`;
            
            m3u += `#EXTINF:-1 tvg-id="${movie.stream_id}" tvg-name="${this.escape(movie.name)}" `;
            m3u += `tvg-logo="${movie.stream_icon || ''}" group-title="${this.escape(categoryName)}",`;
            m3u += `${this.escape(movie.name)}\n`;
            
            if (movie.plot) {
                m3u += `#EXTDESC:${this.escape(movie.plot)}\n`;
            }
            
            m3u += `${streamUrl}\n`;
        });
        
        return new Response(m3u, {
            headers: {
                'Content-Type': 'audio/x-mpegurl',
                'Content-Disposition': 'attachment; filename="vod_playlist.m3u"',
                'Cache-Control': 'no-cache'
            }
        });
    }
    
    async generateSeriesPlaylist(request) {
        const url = new URL(request.url);
        const baseUrl = `${url.protocol}//${url.host}`;
        
        const [seriesList, categories] = await Promise.all([
            this.fetchFromPortal('action=get_series'),
            this.fetchFromPortal('action=get_series_categories')
        ]);
        
        const categoryMap = this.createCategoryMap(categories);
        
        let m3u = '#EXTM3U\n';
        m3u += `#PLAYLIST: Xtream Series - RKDYIPTV\n`;
        m3u += `#GENERATED: ${new Date().toISOString()}\n`;
        m3u += `#TOTAL: ${seriesList.length} series\n\n`;
        
        // BUG FIX #11: Renamed loop variable from 'series' to 'show' to avoid shadowing
        // the outer 'seriesList' variable (was previously 'series' on both sides — shadowing bug)
        seriesList.forEach(show => {
            const categoryName = categoryMap[show.category_id] || 'Unknown';
            
            m3u += `#EXTINF:-1 tvg-id="${show.series_id}" tvg-name="${this.escape(show.name)}" `;
            m3u += `tvg-logo="${show.cover || ''}" group-title="${this.escape(categoryName)}",`;
            m3u += `${this.escape(show.name)}\n`;
            
            if (show.plot) {
                m3u += `#EXTDESC:${this.escape(show.plot)}\n`;
            }
            
            // Add series info as extended tags
            m3u += `#EXTSERIES:${show.series_id}|${this.escape(show.name)}|${show.cover || ''}|${this.escape(categoryName)}\n`;
            
            // BUG FIX #12: Series URL was pointing to /series/ path which has no handler.
            // Corrected to /play/ to route through the existing stream proxy handler.
            const seriesUrl = `${baseUrl}/play/${show.series_id}.m3u8`;
            m3u += `${seriesUrl}\n`;
        });
        
        return new Response(m3u, {
            headers: {
                'Content-Type': 'audio/x-mpegurl',
                'Content-Disposition': 'attachment; filename="series_playlist.m3u"',
                'Cache-Control': 'no-cache'
            }
        });
    }
    
    // ============ STREAM PROXY ============
    async handleStreamProxy(request) {
        const url = new URL(request.url);
        const id = url.pathname.match(/\/play\/(\d+)\.m3u8$/)?.[1];
        
        if (!id) {
            return new Response('Invalid stream ID', { status: 400 });
        }
        
        if (!this.portalConfig?.url) {
            return new Response('Portal not configured', { status: 500 });
        }
        
        const streamUrl = `${this.portalConfig.url}/live/${this.portalConfig.username}/${this.portalConfig.password}/${id}.m3u8`;
        
        try {
            const response = await fetch(streamUrl, {
                headers: {
                    'User-Agent': 'OTT Navigator/1.6.7.4',
                    'Connection': 'Keep-Alive'
                }
            });
            
            if (!response.ok) {
                return new Response('Stream not found', { status: 404 });
            }
            
            const contentType = response.headers.get('Content-Type') || 'application/vnd.apple.mpegurl';
            const m3u8Content = await response.text();
            
            // Process M3U8 content to rewrite TS URLs if needed
            const baseStreamUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
            const processedContent = this.processM3U8(m3u8Content, baseStreamUrl);
            
            return new Response(processedContent, {
                headers: {
                    'Content-Type': contentType,
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache'
                }
            });
            
        } catch (error) {
            console.error('Stream proxy error:', error);
            return new Response('Stream proxy error', { status: 500 });
        }
    }
    
    processM3U8(content, baseUrl) {
        return content.split('\n').map(line => {
            // BUG FIX #13: Also handle lines starting with 'https://' not just 'http'
            if (line && !line.startsWith('#') && !line.startsWith('http://') && !line.startsWith('https://')) {
                // Rewrite relative TS URLs to absolute
                return baseUrl + line;
            }
            return line;
        }).join('\n');
    }
    
    // ============ FILTER HANDLING ============
    async handleFilter(request) {
        if (request.method === 'POST') {
            // BUG FIX #14: Wrap formData parsing in try/catch to handle malformed POST bodies
            let selectedCategories = [];
            try {
                const formData = await request.formData();
                selectedCategories = formData.getAll('categories[]');
            } catch (e) {
                return this.jsonResponse({ error: 'Invalid form data' }, 400);
            }

            // BUG FIX #15: Validate each category ID is numeric before saving to cookie
            const safeCategories = selectedCategories.filter(id => /^\d+$/.test(id));
            const filterData = JSON.stringify({ selectedCategories: safeCategories });
            
            return new Response('Filter saved', {
                status: 302,
                headers: {
                    'Location': '/dashboard',
                    'Set-Cookie': `filter_settings=${encodeURIComponent(filterData)}; Path=/; Max-Age=604800`
                }
            });
        }
        
        // Get categories for filter UI
        const categories = await this.fetchFromPortal('action=get_live_categories');
        
        return this.renderFilterPage(categories, request);
    }
    
    async getFilterSettings(request) {
        const cookie = request.headers.get('Cookie') || '';
        const match = cookie.match(/filter_settings=([^;]+)/);
        
        if (match) {
            try {
                return JSON.parse(decodeURIComponent(match[1]));
            } catch {
                return { selectedCategories: [] };
            }
        }
        
        return { selectedCategories: [] };
    }
    
    filterStreams(streams, filterData, categoryMap) {
        if (!filterData.selectedCategories || filterData.selectedCategories.length === 0) {
            return streams;
        }
        
        return streams.filter(stream => 
            filterData.selectedCategories.includes(String(stream.category_id))
        );
    }
    
    createCategoryMap(categories) {
        const map = {};
        categories.forEach(cat => {
            map[cat.category_id] = cat.category_name;
        });
        return map;
    }
    
    // ============ RENDERING FUNCTIONS ============
    renderLoginPage(error = '') {
        // BUG FIX #16: Escape the error message to prevent reflected XSS
        const safeError = error ? this.escapeHtml(error) : '';

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>RKDYIPTV Login</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .login-container {
                    background: white;
                    border-radius: 10px;
                    box-shadow: 0 15px 35px rgba(0,0,0,0.2);
                    padding: 40px;
                    width: 100%;
                    max-width: 400px;
                }
                h2 {
                    color: #333;
                    margin-bottom: 30px;
                    text-align: center;
                    font-size: 28px;
                }
                .form-group {
                    margin-bottom: 20px;
                }
                label {
                    display: block;
                    margin-bottom: 5px;
                    color: #555;
                    font-weight: 500;
                }
                input {
                    width: 100%;
                    padding: 12px;
                    border: 2px solid #e0e0e0;
                    border-radius: 6px;
                    font-size: 16px;
                    transition: border-color 0.3s;
                }
                input:focus {
                    outline: none;
                    border-color: #667eea;
                }
                button {
                    width: 100%;
                    padding: 14px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    border: none;
                    border-radius: 6px;
                    font-size: 16px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: transform 0.2s;
                }
                button:hover {
                    transform: translateY(-2px);
                }
                .error {
                    background: #fee;
                    color: #c33;
                    padding: 10px;
                    border-radius: 4px;
                    margin-bottom: 20px;
                    text-align: center;
                }
                .footer {
                    text-align: center;
                    margin-top: 20px;
                    color: #888;
                    font-size: 14px;
                }
            </style>
        </head>
        <body>
            <div class="login-container">
                <h2>🔐 RKDYIPTV Login</h2>
                ${safeError ? `<div class="error">${safeError}</div>` : ''}
                <form method="POST" action="/login">
                    <div class="form-group">
                        <label>Username</label>
                        <input type="text" name="username" required placeholder="Enter username" autocomplete="username">
                    </div>
                    <div class="form-group">
                        <label>Password</label>
                        <input type="password" name="password" required placeholder="Enter password" autocomplete="current-password">
                    </div>
                    <button type="submit">Login</button>
                </form>
                <div class="footer">
                    <p>Coded with ❤️ by RKDYIPTV</p>
                </div>
            </div>
        </body>
        </html>
        `;
        
        return this.htmlResponse(html);
    }
    
    async renderDashboard(request) {
        const url = new URL(request.url);
        const baseUrl = `${url.protocol}//${url.host}`;
        
        const [liveCount, vodCount, seriesCount] = await Promise.all([
            this.fetchFromPortal('action=get_live_streams').then(d => d.length).catch(() => 0),
            this.fetchFromPortal('action=get_vod_streams').then(d => d.length).catch(() => 0),
            this.fetchFromPortal('action=get_series').then(d => d.length).catch(() => 0)
        ]);
        
        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>RKDYIPTV Dashboard</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    padding: 20px;
                }
                .container {
                    max-width: 1200px;
                    margin: 0 auto;
                }
                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 30px;
                    color: white;
                }
                .header h1 {
                    font-size: 32px;
                }
                .logout-btn {
                    background: rgba(255,255,255,0.2);
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 16px;
                    transition: background 0.3s;
                }
                .logout-btn:hover {
                    background: rgba(255,255,255,0.3);
                }
                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }
                .stat-card {
                    background: white;
                    border-radius: 10px;
                    padding: 25px;
                    box-shadow: 0 5px 15px rgba(0,0,0,0.2);
                    text-align: center;
                }
                .stat-number {
                    font-size: 36px;
                    font-weight: bold;
                    color: #667eea;
                    margin: 10px 0;
                }
                .stat-label {
                    color: #666;
                    font-size: 16px;
                }
                .playlists-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }
                .playlist-card {
                    background: white;
                    border-radius: 10px;
                    padding: 25px;
                    box-shadow: 0 5px 15px rgba(0,0,0,0.2);
                }
                .playlist-card h3 {
                    color: #333;
                    margin-bottom: 15px;
                    font-size: 20px;
                }
                .playlist-url {
                    display: flex;
                    gap: 10px;
                    margin: 15px 0;
                }
                .playlist-url input {
                    flex: 1;
                    padding: 10px;
                    border: 2px solid #e0e0e0;
                    border-radius: 4px;
                    font-size: 14px;
                }
                .copy-btn {
                    padding: 10px 15px;
                    background: #667eea;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    transition: background 0.3s;
                }
                .copy-btn:hover {
                    background: #5a67d8;
                }
                .filter-btn {
                    display: inline-block;
                    padding: 10px 20px;
                    background: #48bb78;
                    color: white;
                    text-decoration: none;
                    border-radius: 4px;
                    transition: background 0.3s;
                }
                .filter-btn:hover {
                    background: #38a169;
                }
                .action-buttons {
                    display: flex;
                    gap: 10px;
                    margin-top: 15px;
                }
                .footer {
                    text-align: center;
                    color: white;
                    margin-top: 40px;
                    padding: 20px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>📺 RKDYIPTV Dashboard</h1>
                    <form action="/logout" method="POST">
                        <button type="submit" class="logout-btn">Logout</button>
                    </form>
                </div>
                
                <div class="stats-grid">
                    <div class="stat-card">
                        <div>📡 Live Channels</div>
                        <div class="stat-number">${liveCount}</div>
                    </div>
                    <div class="stat-card">
                        <div>🎬 VOD Movies</div>
                        <div class="stat-number">${vodCount}</div>
                    </div>
                    <div class="stat-card">
                        <div>📺 TV Series</div>
                        <div class="stat-number">${seriesCount}</div>
                    </div>
                </div>
                
                <div class="playlists-grid">
                    <div class="playlist-card">
                        <h3>📡 Live TV Playlist</h3>
                        <div class="playlist-url">
                            <input type="text" value="${baseUrl}/playlist.m3u" readonly id="liveUrl">
                            <button class="copy-btn" onclick="copyToClipboard('liveUrl')">Copy</button>
                        </div>
                        <div class="action-buttons">
                            <a href="/filter" class="filter-btn">Filter Categories</a>
                            <a href="${baseUrl}/playlist.m3u" class="filter-btn" style="background: #9f7aea;" download>Download</a>
                        </div>
                    </div>
                    
                    <div class="playlist-card">
                        <h3>🎬 VOD Playlist</h3>
                        <div class="playlist-url">
                            <input type="text" value="${baseUrl}/vod.m3u" readonly id="vodUrl">
                            <button class="copy-btn" onclick="copyToClipboard('vodUrl')">Copy</button>
                        </div>
                        <div class="action-buttons">
                            <a href="${baseUrl}/vod.m3u" class="filter-btn" style="background: #9f7aea;" download>Download</a>
                        </div>
                    </div>
                    
                    <div class="playlist-card">
                        <h3>📺 Series Playlist</h3>
                        <div class="playlist-url">
                            <input type="text" value="${baseUrl}/series.m3u" readonly id="seriesUrl">
                            <button class="copy-btn" onclick="copyToClipboard('seriesUrl')">Copy</button>
                        </div>
                        <div class="action-buttons">
                            <a href="${baseUrl}/series.m3u" class="filter-btn" style="background: #9f7aea;" download>Download</a>
                        </div>
                    </div>
                </div>
                
                <div class="footer">
                    <p>Coded with ❤️ by RKDYIPTV • Total Streams: ${liveCount + vodCount + seriesCount}</p>
                </div>
            </div>
            
            <script>
                function copyToClipboard(elementId) {
                    const input = document.getElementById(elementId);
                    // BUG FIX #17: Use modern Clipboard API with fallback instead of
                    // deprecated document.execCommand('copy') which fails in many browsers
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(input.value)
                            .then(() => alert('URL copied to clipboard!'))
                            .catch(() => {
                                input.select();
                                document.execCommand('copy');
                                alert('URL copied to clipboard!');
                            });
                    } else {
                        input.select();
                        document.execCommand('copy');
                        alert('URL copied to clipboard!');
                    }
                }
            </script>
        </body>
        </html>
        `;
        
        return this.htmlResponse(html);
    }
    
    async renderFilterPage(categories, request) {
        const filterData = await this.getFilterSettings(request);
        const selected = new Set(filterData.selectedCategories || []);
        
        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Filter Categories - RKDYIPTV</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    padding: 20px;
                }
                .container {
                    max-width: 600px;
                    margin: 0 auto;
                    background: white;
                    border-radius: 10px;
                    padding: 30px;
                    box-shadow: 0 5px 15px rgba(0,0,0,0.2);
                }
                h2 {
                    color: #333;
                    margin-bottom: 20px;
                    text-align: center;
                }
                .search-box {
                    width: 100%;
                    padding: 12px;
                    border: 2px solid #e0e0e0;
                    border-radius: 6px;
                    font-size: 16px;
                    margin-bottom: 20px;
                }
                .category-list {
                    max-height: 400px;
                    overflow-y: auto;
                    border: 1px solid #e0e0e0;
                    border-radius: 6px;
                    padding: 15px;
                    margin-bottom: 20px;
                }
                .category-item {
                    display: flex;
                    align-items: center;
                    padding: 10px;
                    border-bottom: 1px solid #f0f0f0;
                }
                .category-item:last-child {
                    border-bottom: none;
                }
                .category-item input[type="checkbox"] {
                    margin-right: 10px;
                    width: 18px;
                    height: 18px;
                    cursor: pointer;
                }
                .category-item label {
                    flex: 1;
                    cursor: pointer;
                    color: #555;
                }
                .select-all {
                    background: #f7f7f7;
                    padding: 10px;
                    border-radius: 4px;
                    margin-bottom: 10px;
                }
                button {
                    width: 100%;
                    padding: 14px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    border: none;
                    border-radius: 6px;
                    font-size: 16px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: transform 0.2s;
                }
                button:hover {
                    transform: translateY(-2px);
                }
                .back-link {
                    display: block;
                    text-align: center;
                    margin-top: 15px;
                    color: #667eea;
                    text-decoration: none;
                }
                .back-link:hover {
                    text-decoration: underline;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>🎯 Filter Categories</h2>
                
                <form method="POST" action="/filter">
                    <input type="text" class="search-box" placeholder="Search categories..." id="searchInput" oninput="filterCategories()">
                    
                    <div class="select-all">
                        <label>
                            <input type="checkbox" id="selectAll" onchange="toggleSelectAll()"> Select All
                        </label>
                    </div>
                    
                    <div class="category-list" id="categoryList">
                        ${categories.map(cat => `
                            <div class="category-item" data-name="${this.escapeHtml(cat.category_name.toLowerCase())}">
                                <input type="checkbox" name="categories[]" value="${this.escapeHtml(String(cat.category_id))}" 
                                    id="cat_${cat.category_id}" ${selected.has(String(cat.category_id)) ? 'checked' : ''}>
                                <label for="cat_${cat.category_id}">${this.escapeHtml(cat.category_name)}</label>
                            </div>
                        `).join('')}
                    </div>
                    
                    <button type="submit">Save Filters</button>
                </form>
                
                <a href="/dashboard" class="back-link">← Back to Dashboard</a>
            </div>
            
            <script>
                function filterCategories() {
                    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
                    const categoryItems = document.querySelectorAll('.category-item');
                    
                    categoryItems.forEach(cat => {
                        const name = cat.dataset.name;
                        if (name.includes(searchTerm)) {
                            cat.style.display = 'flex';
                        } else {
                            cat.style.display = 'none';
                        }
                    });
                }
                
                function toggleSelectAll() {
                    const selectAll = document.getElementById('selectAll');
                    const checkboxes = document.querySelectorAll('input[name="categories[]"]');
                    
                    checkboxes.forEach(checkbox => {
                        checkbox.checked = selectAll.checked;
                    });
                }
            </script>
        </body>
        </html>
        `;
        
        return this.htmlResponse(html);
    }
    
    handleHealthCheck(request) {
        return this.jsonResponse({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            credits: 'RKDYIPTV',
            endpoints: {
                dashboard: '/dashboard',
                login: '/login',
                live: '/playlist.m3u',
                vod: '/vod.m3u',
                series: '/series.m3u',
                filter: '/filter',
                api_categories: '/api/categories',
                api_streams: '/api/streams'
            }
        });
    }
    
    // ============ HELPER FUNCTIONS ============
    escape(str) {
        if (!str) return '';
        return String(str).replace(/[,"\n\r]/g, ' ').trim();
    }

    // BUG FIX #16 (helper): HTML escape for safe rendering in HTML templates
    escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    
    jsonResponse(data, status = 200) {
        return new Response(JSON.stringify(data, null, 2), {
            status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
    
    htmlResponse(html, status = 200) {
        return new Response(html, {
            status,
            headers: {
                'Content-Type': 'text/html; charset=utf-8'
            }
        });
    }
}

// ============ WORKER ENTRY POINT ============
const worker = new XtreamWorker();

addEventListener('fetch', event => {
    event.respondWith(worker.handleRequest(event.request));
});