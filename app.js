const SB_URL = 'https://fbzewdfubjfhqvlusyrj.supabase.co';
const SB_KEY = 'sb_publishable_2JftgVsArBG2NB-RXp0q4Q_jdd8VfPO';
const client = supabase.createClient(SB_URL, SB_KEY);

let currentUser = null;
let analyticsTimeout = null; // טיימר ייעודי לאנליטיקס
let userFavorites = [];
let debounceTimeout = null;
let isPlaying = false;
let loadedVideosCount = 0;
const VIDEOS_PER_PAGE = 50; // כמה סרטונים לטעון בכל פעם
let isLoadingVideos = false;
let hasMoreVideos = true;
let currentSearchQuery = ""; 

const categoryMap = {
    "1": "כללי", "2": "רכבים", "10": "כללי", "15": "חיות מחמד",
    "17": "כללי", "20": "כללי", "22": "אנשים ובלוגים", "23": "כללי",
    "24": "כללי", "25": "חדשות ופוליטיקה", "26": "מדריכים וסטייל",
    "27": "חינוך", "28": "מדע וטכנולוגיה"
};

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
    
    // אם זו שאילתה חדשה, נאפס את מצב הטעינה
    if (!isAppend) {
        currentSearchQuery = query.trim();
        loadedVideosCount = 0;
        hasMoreVideos = true;
    } else if (!hasMoreVideos) {
        // אם אין יותר סרטונים לטעון בגלילה, נעצור
        return;
    }

    isLoadingVideos = true;
    
    // הגדרת טווח הסרטונים לטעינה נוכחית
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

        // טיפול בתרגום (יתבצע רק בחיפוש הראשוני, לא בגלילה)
        if (!isAppend) {
            clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(async () => {
                const translated = await getTranslation(cleanQuery);
                if (translated && translated.toLowerCase() !== cleanQuery.toLowerCase()) {
                    const { data: transData } = await client.rpc('search_videos_prioritized', { search_term: translated }).range(0, VIDEOS_PER_PAGE - 1);
                    if (transData && transData.length > 0) {
                        renderVideoGrid(transData, true); // נוסיף את התוצאות המתורגמות
                    }
                }
            }, 800);
        }
    }

    if (fetchedData && fetchedData.length > 0) {
        renderVideoGrid(fetchedData, isAppend);
        loadedVideosCount += fetchedData.length;
        
        // אם קיבלנו פחות סרטונים ממה שביקשנו, סימן שאין יותר סרטונים במסד הנתונים
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
// הוסף את הפרמטר isAppend עם ערך ברירת מחדל
function renderVideoGrid(videos, isAppend = false) {
    const grid = document.getElementById('videoGrid');
    if (!grid) return;

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
            l: v.likes_count
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


async function preparePlay(encodedData) {
    try {
        const data = JSON.parse(decodeURIComponent(atob(encodedData)));

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
        const container = document.getElementById('youtubePlayer');
        
        if (!playerWin || !container) return;

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

        // --- הגדרת הנגן ---
        const videoParams = new URLSearchParams({
            autoplay: 1,
            enablejsapi: 1,
            rel: 0,
            cc_load_policy: 1, 
            origin: window.location.origin
        });

        container.innerHTML = `
            <div id="player-loader" class="player-loader">
                <i class="fa-solid fa-play"></i>
            </div>
            <iframe id="yt-iframe" 
                src="https://www.youtube.com/embed/${data.id}?${videoParams.toString()}" 
                frameborder="0" 
                allow="autoplay; encrypted-media; picture-in-picture" 
                allowfullscreen
                style="opacity: 0; width: 100%; height: 100%; transition: opacity 0.5s ease; position: absolute; top: 0; left: 0; z-index: 2;"
                onload="const loader = document.getElementById('player-loader'); if(loader) loader.style.display='none'; this.style.opacity='1';">
            </iframe>`;
        
        // --- עדכון UI מיידי מה-Base64 (כולל צפיות, לייקים וקטגוריה) ---
        if (document.getElementById('current-title')) 
            document.getElementById('current-title').textContent = data.t || "ללא כותרת";
            
        if (document.getElementById('current-channel')) 
            document.getElementById('current-channel').textContent = data.c || "";

        // הוספת צפיות ולייקים מה-Base64
        if (document.getElementById('stat-views')) 
            document.getElementById('stat-views').innerHTML = `<i class="fa-solid fa-eye"></i> ${data.v || 0}`;
        
        if (document.getElementById('stat-likes')) 
            document.getElementById('stat-likes').innerHTML = `<i class="fa-solid fa-thumbs-up"></i> ${data.l || 0}`;

        // הוספת קטגוריה מה-Base64
        const catElem = document.getElementById('current-category');
        if (catElem) catElem.textContent = data.cat || "כללי";

        // הכנה לתיאור שיגיע מהשרת
        const descElem = document.getElementById('bottom-description');
        if (descElem) descElem.textContent = "טוען תיאור...";

        // --- השלמת נתונים כבדים מסופבייס (רק תיאור) ---
        client.from('videos')
            .select('description')
            .eq('id', data.id)
            .single()
            .then(({ data: extra }) => {
                if (extra && descElem) {
                    descElem.textContent = extra.description || "אין תיאור זמין";
                }
            });

        // --- עדכון היסטוריה ---
        if (typeof currentUser !== 'undefined' && currentUser) {
            client.from('history').upsert([
                { user_id: currentUser.id, video_id: data.id, created_at: new Date() }
            ]).then(() => {
                if (typeof loadSidebarLists === 'function') loadSidebarLists();
            });
        }

    } catch (e) { 
        console.error("שגיאה בהפעלת הסרטון:", e); 
    }
}

function closePlayer() {
    const playerWin = document.getElementById('floating-player');
    const container = document.getElementById('youtubePlayer');
    const playerBar = document.getElementById('main-player-bar');
    
    if (playerWin) playerWin.style.display = 'none';
    if (container) container.innerHTML = ''; 
    if (playerBar) {
        playerBar.classList.remove('show-player');
        playerBar.classList.add('hidden-player');
    }
    
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
        // מונע גרירה אם לוחצים על כפתור הסגירה
        if (e.target.closest('button')) return;

        isDragging = true;
        const rect = player.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        
        // ממיר את ה-right/bottom למיקומים אבסולוטיים כדי שהגרירה תעבוד מושלם
        player.style.right = 'auto';
        player.style.bottom = 'auto';
        player.style.left = rect.left + 'px';
        player.style.top = rect.top + 'px';
        player.style.transition = 'none'; 
        
        const iframe = document.getElementById('yt-iframe');
        if(iframe) iframe.style.pointerEvents = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        let x = e.clientX - offsetX;
        let y = e.clientY - offsetY;
        
        // שומר שהחלון לא ייצא מגבולות המסך
        x = Math.max(0, Math.min(x, window.innerWidth - player.offsetWidth));
        y = Math.max(0, Math.min(y, window.innerHeight - player.offsetHeight));

        player.style.left = `${x}px`;
        player.style.top = `${y}px`;
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        const iframe = document.getElementById('yt-iframe');
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

        const iframe = document.getElementById('yt-iframe');
        if(iframe) iframe.style.pointerEvents = 'none';

        function doResize(re) {
            // חישוב מתמטי לפינה השמאלית-תחתונה:
            const diffX = re.clientX - startX;
            const diffY = re.clientY - startY;

            // מאחר ומושכים שמאלה, diffX הוא שלילי - לכן מחסרים אותו כדי להגדיל את הרוחב
            const newWidth = startWidth - diffX; 
            const newHeight = startHeight + diffY;

            if(newWidth > 280) { // רוחב מינימלי
                player.style.width = newWidth + 'px';
                player.style.left = (rect.left + diffX) + 'px'; 
            }
            if(newHeight > 180) { // גובה מינימלי
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
    const iframe = document.getElementById('yt-iframe');
    if (!iframe) return;
    const action = isPlaying ? 'pauseVideo' : 'playVideo';
    iframe.contentWindow.postMessage(JSON.stringify({"event": "command", "func": action, "args": ""}), "*");
    isPlaying = !isPlaying;
    updatePlayStatus(isPlaying);
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

// מאזין לאירועי גלילה של אזור התוכן הראשי
const contentArea = document.querySelector('.content');
if (contentArea) {
    contentArea.addEventListener('scroll', () => {
        // בודק אם הגענו כמעט לתחתית של אזור התוכן (במרחק 200 פיקסלים)
        if (contentArea.scrollTop + contentArea.clientHeight >= contentArea.scrollHeight - 200) {
            if (!isLoadingVideos && hasMoreVideos) {
                // מפעיל את פונקציית הטעינה במצב שרשור (isAppend = true)
                fetchVideos(currentSearchQuery, true);
            }
        }
    });
}// --- אתחול ---

// מאזין לחיפוש: חיפוש מיידי, דיווח לאנליטיקס מושהה
document.getElementById('globalSearch').addEventListener('input', (e) => {
    const query = e.target.value.trim();
    
    // 1. ביצוע החיפוש עצמו - קורה מיד ללא המתנה
    fetchVideos(query);

    // 2. ניהול הדיווח לאנליטיקס - המתנה של 2 שניות מסיום ההקלדה
    clearTimeout(analyticsTimeout); // מאפס את הטיימר בכל לחיצת מקש

    if (query.length > 0) {
        analyticsTimeout = setTimeout(() => {
            if (typeof gtag === 'function') {
                gtag('event', 'search', {
                    'search_term': query
                });
                console.log("Analytics: Search tracked (2s idle) -> " + query);
            }
        }, 2000);
    }
});

init();
