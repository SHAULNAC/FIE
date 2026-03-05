const SB_URL = 'https://fbzewdfubjfhqvlusyrj.supabase.co';
const SB_KEY = 'sb_publishable_2JftgVsArBG2NB-RXp0q4Q_jdd8VfPO';
const client = supabase.createClient(SB_URL, SB_KEY);

let currentUser = null;
let analyticsTimeout = null; 
let userFavorites = [];
let debounceTimeout = null;
let isPlaying = false;
let loadedVideosCount = 0;
const VIDEOS_PER_PAGE = 50; 
let isLoadingVideos = false;
let hasMoreVideos = true;
let currentSearchQuery = ""; 
let userHistoryIds = []; 
let videoWatchCounts = {};
let displayResults = []; 
let activeQueue = [];    

// --- משתנים חדשים לניהול הנגן הרשמי ---
let ytPlayer = null;
let currentPlayingId = null;
let safetyTimer = null;

const categoryMap = {
    "1": "כללי", "2": "רכבים", "10": "כללי", "15": "חיות מחמד",
    "17": "כללי", "20": "כללי", "22": "אנשים ובלוגים", "23": "כללי",
    "24": "כללי", "25": "חדשות ופוליטיקה", "26": "מדריכים וסטייל",
    "27": "חינוך", "28": "מדע וטכנולוגיה"
};

// פונקציית חובה ל-API של יוטיוב
function onYouTubeIframeAPIReady() {
    console.log("YouTube API is ready");
}

// --- פונקציות עזר ---

function cleanForJS(text) {
    if (!text) return "";
    return text.replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDuration(isoDuration) {
    if (!isoDuration || !isoDuration.startsWith('PT')) return "0:00";
    const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    const hours = parseInt(match[1]) || 0;
    const minutes = parseInt(match[2]) || 0;
    const seconds = parseInt(match[3]) || 0;

    const parts = [];
    if (hours > 0) parts.push(hours);
    parts.push(hours > 0 ? minutes.toString().padStart(2, '0') : minutes);
    parts.push(seconds.toString().padStart(2, '0'));
    return parts.join(':');
}

async function init() {
    try {
        const { data: { user } } = await client.auth.getUser();
        currentUser = user;
        
        client.auth.onAuthStateChange((event, session) => {
            currentUser = session?.user || null;
            updateUserUI();
            if (currentUser) loadSidebarLists();
        });

        updateUserUI();
        
        if (currentUser) {
            const { data: favs } = await client.from('favorites')
                .select('video_id')
                .eq('user_id', currentUser.id);
            userFavorites = favs ? favs.map(f => f.video_id) : [];
            loadSidebarLists();
        }

        fetchVideos();
        initDraggable();
        initResizer(); 

    } catch (error) {
        console.error("Error during init:", error);
    }
}

function updateUserUI() {
    const userDiv = document.getElementById('user-profile');
    if (!userDiv) return;

    if (currentUser && currentUser.user_metadata) {
        const avatar = currentUser.user_metadata.avatar_url || "";
        userDiv.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                ${avatar ? `<img src="${avatar}" style="width:35px; border-radius:50%; border: 2px solid #1DB954;">` : ''}
                <div style="display:flex; flex-direction:column;">
                    <span style="font-size:14px; font-weight:bold;">${escapeHtml(currentUser.user_metadata.full_name)}</span>
                    <span onclick="logout()" style="color:#b3b3b3; font-size:11px; cursor:pointer; text-decoration:none;">התנתק</span>
                </div>
            </div>`;
    } else {
        userDiv.innerHTML = `<button class="btn-login" onclick="login()">התחבר עם Google</button>`;
    }
}

async function login() {
    const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: window.location.origin + window.location.pathname 
        }
    });
    if (error) console.error("Login error:", error.message);
}

async function logout() { 
    await client.auth.signOut(); 
    window.location.reload(); 
}

// --- חיפוש ---

async function fetchVideos(query = "", isAppend = false) {
    if (isLoadingVideos) return;
    
    if (!isAppend) {
        currentSearchQuery = query.trim();
        loadedVideosCount = 0;
        hasMoreVideos = true;
    } else if (!hasMoreVideos) {
        return;
    }

    isLoadingVideos = true;
    
    const from = loadedVideosCount;
    const to = from + VIDEOS_PER_PAGE - 1;
    let fetchedData = null;

    if (!currentSearchQuery) {
        const { data } = await client.from('videos')
            .select('id, title, channel_title, thumbnail, duration, views, likes, category_id')
            .order('published_at', { ascending: false })
            .range(from, to);
        fetchedData = data;
    } else {
        const cleanQuery = currentSearchQuery.replace(/[^\w\sא-ת]/g, ' ').trim();
        const { data } = await client.rpc('search_videos_prioritized', { search_term: cleanQuery })
            .range(from, to);
        fetchedData = data || [];

        if (!isAppend) {
            clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(async () => {
                const translated = await getTranslation(cleanQuery);
                if (translated && translated.toLowerCase() !== cleanQuery.toLowerCase()) {
                    const { data: transData } = await client.rpc('search_videos_prioritized', { search_term: translated }).range(0, VIDEOS_PER_PAGE - 1);
                    if (transData && transData.length > 0) {
                        renderVideoGrid(transData, true); 
                    }
                }
            }, 800);
        }
    }

    if (fetchedData && fetchedData.length > 0) {
        renderVideoGrid(fetchedData, isAppend);
        loadedVideosCount += fetchedData.length;
        
        if (fetchedData.length < VIDEOS_PER_PAGE) {
            hasMoreVideos = false;
        }
    } else {
        if (!isAppend) renderVideoGrid([]);
        hasMoreVideos = false;
    }

    isLoadingVideos = false;
}

async function getTranslation(text) {
    try {
        const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=iw&tl=en&dt=t&q=${encodeURI(text)}`);
        const data = await res.json();
        return data[0][0][0];
    } catch (e) { return null; }
}

// --- רינדור ---

function renderVideoGrid(videos, isAppend = false) {
    const grid = document.getElementById('videoGrid');
    if (!grid) return;

    if (!isAppend) {
        displayResults = videos; 
    } else {
        displayResults = [...displayResults, ...videos];
    }

    const htmlString = videos.map(v => {
        const videoId = v.id;
        const safeTitle = escapeHtml(v.title);
        const safeChannel = escapeHtml(v.channel_title);
        
        const videoData = {
            id: videoId,
            t: v.title,
            c: v.channel_title,
            cat: categoryMap[v.category_id] || "כללי",
            v: v.views_count,
            l: v.likes_count,
            duration: v.duration // הוספנו כדי שיהיה זמין לנגן
        };

        const encodedData = btoa(encodeURIComponent(JSON.stringify(videoData)));
        const isFav = userFavorites.includes(videoId);
        const favIconClass = isFav ? 'fa-solid' : 'fa-regular';
        const displayDuration = v.duration ? formatDuration(v.duration) : '';

        return `
            <div class="v-card" onclick="preparePlay('${encodedData}')">
                <div class="v-thumb">
                    <img src="${v.thumbnail}" alt="${safeTitle}" loading="lazy">
                    <span class="v-duration">${displayDuration}</span>
                </div>
                <div class="v-info">
                    <h3 title="${safeTitle}">${safeTitle}</h3>
                    <p>${safeChannel}</p>
                    <div class="card-footer">
                        <span><i class="fa-solid fa-eye"></i> ${v.views_count || 0}</span>
                        <button class="fav-btn" onclick="event.stopPropagation(); toggleFavorite('${videoId}')">
                            <i class="${favIconClass} fa-heart" id="fav-icon-${videoId}"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    if (isAppend) {
        grid.insertAdjacentHTML('beforeend', htmlString);
    } else {
        grid.innerHTML = htmlString;
    }
}

// --- ניהול הנגן (עודכן ל-API רשמי) ---

async function preparePlay(encodedData) {
    window.autoPlayTriggered = false;
    clearTimeout(safetyTimer); // איפוס טיימר בטיחות קודם
    
    try {
        const data = JSON.parse(decodeURIComponent(atob(encodedData)));
        currentPlayingId = data.id; // עדכון המזהה הנוכחי
        activeQueue = [...displayResults];

        // --- שליחה לגוגל אנליטיקס ---
        if (typeof gtag === 'function') {
            gtag('event', 'video_start', {
                'video_title': data.t,
                'video_id': data.id,
                'video_category': data.cat || "כללי"
            });
        }

        const playerWin = document.getElementById('floating-player');
        const playerBar = document.getElementById('main-player-bar'); 
        
        if (!playerWin) return;

        // --- אנימציית פתיחה ---
        playerWin.style.display = 'flex'; 
        playerWin.style.opacity = '0';
        playerWin.style.transform = 'translateY(20px)';
        playerWin.style.transition = 'all 0.5s ease-out';
        
        setTimeout(() => {
            playerWin.style.opacity = '1';
            playerWin.style.transform = 'translateY(0)';
        }, 10);

        if (playerBar) {
            playerBar.classList.remove('hidden-player');
            playerBar.classList.add('show-player'); 
        }

        // פונקציית מעבר פנימית
        function triggerNext() {
            if (window.autoPlayTriggered) return;
            window.autoPlayTriggered = true;
            clearTimeout(safetyTimer);
            console.log("מעבר אוטומטי הופעל...");
            playNextInQueue();
        }

        const myOrigin = "https://shaulnac.github.io/FIE/";
        // --- יצירת או טעינת הנגן ---
        if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
            ytPlayer.loadVideoById(data.id);
        } else {
            ytPlayer = new YT.Player('youtubePlayer', {
                videoId: data.id,
                playerVars: {
                    'autoplay': 1,
                'mute': 0,
                'controls': 1,
                'origin': myOrigin,
                'widget_referrer': myOrigin, // הפניה מלאה כולל התיקייה
                'enablejsapi': 1,
                'rel': 0,
                'showinfo': 0,
                'modestbranding': 1
                    'host': 'https://www.youtube.com' // אופציונלי: שימוש ב-NoCookie גם ב-API
                },
                events: {
                    'onReady': (event) => {
                        event.target.playVideo();
                    },
                    'onStateChange': (event) => {
                        if (event.data === YT.PlayerState.PLAYING) {
                            isPlaying = true;
                            updatePlayStatus(true);
                            
                            // הפעלת טיימר בטיחות (רשת ביטחון לנטפרי)
                            clearTimeout(safetyTimer);
                            const duration = ytPlayer.getDuration() || 300; // ברירת מחדל 5 דקות אם נכשל
                            if (duration > 0) {
                                safetyTimer = setTimeout(() => {
                                    console.warn("טיימר בטיחות פקע - מפעיל מעבר לסרטון הבא");
                                    triggerNext();
                                }, (duration + 5) * 1000); // 5 שניות מרווח
                            }
                            
                        } else if (event.data === YT.PlayerState.PAUSED) {
                            isPlaying = false;
                            updatePlayStatus(false);
                        } else if (event.data === YT.PlayerState.ENDED) {
                            triggerNext();
                        }
                    },
                    'onError': (event) => {
                        console.error("שגיאת יוטיוב API, מדלג...", event.data);
                        triggerNext();
                    }
                }
            });
        }

        // --- עדכון UI ---
        document.getElementById('current-title').textContent = data.t || "ללא כותרת";
        document.getElementById('current-channel').textContent = data.c || "";
        document.getElementById('stat-views').innerHTML = `<i class="fa-solid fa-eye"></i> ${data.v || 0}`;
        document.getElementById('stat-likes').innerHTML = `<i class="fa-solid fa-thumbs-up"></i> ${data.l || 0}`;
        if (document.getElementById('current-category')) document.getElementById('current-category').textContent = data.cat || "כללי";

        const descElem = document.getElementById('bottom-description');
        if (descElem) descElem.textContent = "טוען תיאור...";

        client.from('videos').select('description').eq('id', data.id).single()
            .then(({ data: extra }) => {
                if (extra && descElem) descElem.textContent = extra.description || "אין תיאור זמין";
            });

        if (typeof currentUser !== 'undefined' && currentUser) {
            client.from('history').upsert([{ user_id: currentUser.id, video_id: data.id, created_at: new Date() }])
                .then(() => { if (typeof loadSidebarLists === 'function') loadSidebarLists(); });
        }

    } catch (e) {
        console.error("שגיאה בהפעלת הסרטון:", e);
    }
}

async function playNextInQueue() {
    if (!currentPlayingId) return;

    const currentIndex = activeQueue.findIndex(v => v.id === currentPlayingId);
    let potentialNextVideos = activeQueue.slice(currentIndex + 1);

    if (potentialNextVideos.length === 0) {
        console.log("הגעת לסוף התור.");
        return;
    }

    potentialNextVideos.sort((a, b) => {
        const countA = videoWatchCounts[a.id] || 0;
        const countB = videoWatchCounts[b.id] || 0;
        return countA - countB;
    });

    const nextVid = potentialNextVideos[0];

    const videoData = {
        id: nextVid.id,
        t: nextVid.title,
        c: nextVid.channel_title,
        cat: categoryMap[nextVid.category_id] || "כללי",
        v: nextVid.views_count,
        l: nextVid.likes_count
    };
    
    const encoded = btoa(encodeURIComponent(JSON.stringify(videoData)));
    preparePlay(encoded);
}

function closePlayer() {
    const playerWin = document.getElementById('floating-player');
    const playerBar = document.getElementById('main-player-bar');
    
    if (playerWin) playerWin.style.display = 'none';
    if (playerBar) {
        playerBar.classList.remove('show-player');
        playerBar.classList.add('hidden-player');
    }
    
    // במקום לדרוס את ה-HTML ולהרוס את האובייקט, פשוט עוצרים אותו
    if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
        ytPlayer.stopVideo();
    }
    
    clearTimeout(safetyTimer);
    isPlaying = false;
    updatePlayStatus(false);
}

function initDraggable() {
    const player = document.getElementById('floating-player');
    const handle = document.getElementById('drag-handle');
    if(!player || !handle) return;
    
    let isDragging = false;
    let offsetX, offsetY;

    handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;

        isDragging = true;
        const rect = player.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        
        player.style.right = 'auto';
        player.style.bottom = 'auto';
        player.style.left = rect.left + 'px';
        player.style.top = rect.top + 'px';
        player.style.transition = 'none'; 
        
        // יצירת שכבת מגן שקופה כדי שהעכבר לא "ייתקע" בתוך ה-Iframe בזמן גרירה
        const iframe = document.getElementById('youtubePlayer');
        if(iframe) iframe.style.pointerEvents = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        let x = e.clientX - offsetX;
        let y = e.clientY - offsetY;
        
        x = Math.max(0, Math.min(x, window.innerWidth - player.offsetWidth));
        y = Math.max(0, Math.min(y, window.innerHeight - player.offsetHeight));

        player.style.left = `${x}px`;
        player.style.top = `${y}px`;
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        const iframe = document.getElementById('youtubePlayer');
        if(iframe) iframe.style.pointerEvents = 'auto';
    });
}

function initResizer() {
    const player = document.getElementById('floating-player');
    const resizer = document.getElementById('resizer');
    if(!player || !resizer) return;
    
    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const startWidth = player.offsetWidth;
        const startHeight = player.offsetHeight;
        const startX = e.clientX;
        const startY = e.clientY;
        
        const rect = player.getBoundingClientRect();
        
        player.style.right = 'auto';
        player.style.bottom = 'auto';
        player.style.top = rect.top + 'px';
        player.style.left = rect.left + 'px';
        player.style.transition = 'none';

        const iframe = document.getElementById('youtubePlayer');
        if(iframe) iframe.style.pointerEvents = 'none';

        function doResize(re) {
            const diffX = re.clientX - startX;
            const diffY = re.clientY - startY;

            const newWidth = startWidth - diffX; 
            const newHeight = startHeight + diffY;

            if(newWidth > 280) { 
                player.style.width = newWidth + 'px';
                player.style.left = (rect.left + diffX) + 'px'; 
            }
            if(newHeight > 180) { 
                player.style.height = newHeight + 'px';
            }
        }

        function stopResize() {
            window.removeEventListener('mousemove', doResize);
            window.removeEventListener('mouseup', stopResize);
            if(iframe) iframe.style.pointerEvents = 'auto';
        }

        window.addEventListener('mousemove', doResize);
        window.addEventListener('mouseup', stopResize);
    });
}

function togglePlayPause() {
    if (!ytPlayer || typeof ytPlayer.getPlayerState !== 'function') return;
    
    const state = ytPlayer.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
        ytPlayer.pauseVideo();
    } else {
        ytPlayer.playVideo();
    }
}

function updatePlayStatus(playing) {
    const icon = document.getElementById('play-icon');
    if (icon) icon.className = playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';
}

async function toggleFavorite(videoId) {
    if (!currentUser) return alert("עליך להתחבר כדי להוסיף למועדפים");
    const isFav = userFavorites.includes(videoId);
    if (isFav) {
        await client.from('favorites').delete().eq('user_id', currentUser.id).eq('video_id', videoId);
        userFavorites = userFavorites.filter(id => id !== videoId);
    } else {
        await client.from('favorites').insert([{ user_id: currentUser.id, video_id: videoId }]);
        userFavorites.push(videoId);
    }
    const icon = document.getElementById(`fav-icon-${videoId}`);
    if (icon) icon.className = userFavorites.includes(videoId) ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
}

function showEfficiencyPoll(videoId) {
    const poll = document.createElement('div');
    poll.className = 'feedback-toast';
    poll.innerHTML = `
        <p style="margin:0 0 10px 0; font-size:13px;">כמה הסרטון היה שימושי?</p>
        <button class="feedback-btn" onclick="submitEfficiency('${videoId}', 10, this)">מאוד שימושי</button>
        <button class="feedback-btn" onclick="submitEfficiency('${videoId}', 5, this)">ככה ככה</button>
        <button class="feedback-btn" onclick="submitEfficiency('${videoId}', 0, this)">לא עזר</button>
    `;
    document.body.appendChild(poll);
}

async function submitEfficiency(videoId, score, btn) {
    const { error } = await client.from('videos').update({ efficiency_score: score }).eq('id', videoId);
    if (!error) {
        btn.parentElement.innerHTML = "תודה על המשוב!";
        setTimeout(() => document.querySelectorAll('.feedback-toast').forEach(t => t.remove()), 2000);
    }
}

async function loadSidebarLists() {
    if (!currentUser) return;
    const sidebarList = document.getElementById('favorites-list');
    if (sidebarList) {
        sidebarList.innerHTML = `
            <div class="nav-link" onclick='displayHistory()'>
                <i class="fa-solid fa-clock-rotate-left"></i>
                <span>היסטוריית צפייה</span>
            </div>
            <div class="nav-link" onclick='displayFavorites()'>
                <i class="fa-solid fa-heart"></i>
                <span>סרטונים שאהבתי</span>
            </div>
        `;
    }
}

async function displayHistory() {
    if (!currentUser) return;
    const { data } = await client.from('history').select('*, videos(*)').eq('user_id', currentUser.id).order('created_at', { ascending: false });
    const title = document.getElementById('main-title');
    if (title) title.textContent = "היסטוריית צפייה";
    if (data) renderVideoGrid(data.map(i => i.videos).filter(v => v));
}

async function displayFavorites() {
    if (!currentUser) return;
    const { data } = await client.from('favorites').select('*, videos(*)').eq('user_id', currentUser.id);
    const title = document.getElementById('main-title');
    if (title) title.textContent = "מועדפים";
    if (data) renderVideoGrid(data.map(i => i.videos).filter(v => v));
}

function showPrivacy() {
    const modal = document.getElementById('privacy-modal');
    if (modal) modal.style.display = 'flex';
}

function closePrivacy() {
    const modal = document.getElementById('privacy-modal');
    if (modal) modal.style.display = 'none';
}

window.onclick = function(event) {
    const modal = document.getElementById('privacy-modal');
    if (event.target == modal) {
        closePrivacy();
    }
}

const contentArea = document.querySelector('.content');
if (contentArea) {
    contentArea.addEventListener('scroll', () => {
        if (contentArea.scrollTop + contentArea.clientHeight >= contentArea.scrollHeight - 200) {
            if (!isLoadingVideos && hasMoreVideos) {
                fetchVideos(currentSearchQuery, true);
            }
        }
    });
}

document.getElementById('globalSearch').addEventListener('input', (e) => {
    const query = e.target.value.trim();
    fetchVideos(query);

    clearTimeout(analyticsTimeout); 
    if (query.length > 0) {
        analyticsTimeout = setTimeout(() => {
            if (typeof gtag === 'function') {
                gtag('event', 'search', {
                    'search_term': query
                });
                console.log("Analytics: Search tracked -> " + query);
            }
        }, 2000);
    }
});

init();
