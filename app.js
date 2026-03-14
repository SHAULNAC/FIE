const SB_URL = 'https://fbzewdfubjfhqvlusyrj.supabase.co';
const SB_KEY = 'sb_publishable_2JftgVsArBG2NB-RXp0q4Q_jdd8VfPO';
const client = supabase.createClient(SB_URL, SB_KEY);

let currentUser = null;
let analyticsTimeout = null; 
let userFavorites = [];
let isPlaying = false;
let loadedVideosCount = 0;
const VIDEOS_PER_PAGE = 50; 
let isLoadingVideos = false;
let hasMoreVideos = true;
let currentSearchQuery = ""; 
let currentResolvedSearchQuery = "";
let currentSearchToken = 0;
let channelMatchResults = [];
let pinnedSearchResults = null;
let playbackMode = 'playlist'; // 'playlist' | 'smart'

let currentChannelFilter = null;
let userHistoryIds = []; 
let videoWatchCounts = {};
let displayResults = []; 
let activeQueue = [];    
let currentAppMode = 'home'; // יכול להיות 'home', 'history', או 'favorites'
// --- משתנים חדשים לניהול הנגן הרשמי ---
let ytPlayer = null;
let currentPlayingId = null;
let safetyTimer = null;
let lastPlayedEncodedData = null;
const TRANSLATION_TABLE = 'translation_cache'; // שם הטבלה ב-Supabase
const COL_ORIGINAL = 'original_text';     // שם העמודה של הטקסט המקורי
const COL_TRANSLATED = 'translated_text'; // שם העמודה של הטקסט המתורגם

const APP_STATE_STORAGE_KEY = 'fie:last-app-state';

function saveAppState() {
    try {
        const searchInput = document.getElementById('globalSearch');
        const state = {
            appMode: currentAppMode,
            searchQuery: searchInput ? searchInput.value : currentSearchQuery,
            channelFilter: currentChannelFilter,
            playbackMode,
            lastPlayedEncodedData,
            currentPlayingId
        };
        localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
        console.warn('לא ניתן לשמור מצב אחרון:', err);
    }
}

function loadSavedAppState() {
    try {
        const raw = localStorage.getItem(APP_STATE_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        console.warn('לא ניתן לקרוא מצב שמור:', err);
        return null;
    }
}

const categoryMap = {
    "1": "סרטים ואנימציה",
    "2": "רכבים וכלי רכב",
    "10": "מוזיקה",
    "15": "חיות מחמד ובעלי חיים",
    "17": "ספורט",
    "19": "טיולים ואירועים",
    "20": "גיימינג",
    "22": "אנשים ובלוגים",
    "23": "קומדיה",
    "24": "בידור",
    "25": "חדשות ופוליטיקה",
    "26": "מדריכים וסטייל",
    "27": "חינוך",
    "28": "מדע וטכנולוגיה",
    "29": "עמותות ואקטיביזם"
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

// --- ניהול מודל מותאם אישית ---
function showCustomAlert(title, message, btnText, action) {
    document.getElementById('alert-title').textContent = title;
    document.getElementById('alert-message').textContent = message;
    const actionBtn = document.getElementById('alert-action-btn');
    actionBtn.textContent = btnText;
    actionBtn.onclick = () => {
        if(action) action();
        closeCustomAlert();
    };
    document.getElementById('custom-alert-modal').style.display = 'flex';
}

function closeCustomAlert() {
    document.getElementById('custom-alert-modal').style.display = 'none';
}

// --- חיפוש קולי ---
function startVoiceSearch() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        showCustomAlert('אופס', 'הדפדפן שלך לא תומך בחיפוש קולי. אנא נסה להקליד את החיפוש.', 'הבנתי', null);
        return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'he-IL';
    
    recognition.onstart = function() {
        document.getElementById('voiceSearchBtn').classList.add('recording');
        document.getElementById('globalSearch').placeholder = "מקשיב...";
    };
    
    recognition.onresult = function(event) {
        const transcript = event.results[0][0].transcript;
        const searchInput = document.getElementById('globalSearch');
        searchInput.value = transcript;
        fetchVideos(transcript);
        triggerAnalytics(transcript);
    };
    
    recognition.onend = function() {
        document.getElementById('voiceSearchBtn').classList.remove('recording');
        document.getElementById('globalSearch').placeholder = "חפש סרטונים...";
    };
    
    recognition.start();
}

// מעבר יזום לסרטון הבא בתור
function playNextVideo() {
    if (!currentPlayingId || activeQueue.length === 0) return;
    const currentIndex = activeQueue.findIndex(v => v.id === currentPlayingId);
    
    if (currentIndex >= 0 && currentIndex < activeQueue.length - 1) {
        const nextVid = activeQueue[currentIndex + 1];
        playVideoFromObject(nextVid);
    } else {
        console.log("אין סרטון הבא בתור");
    }
}

// מעבר יזום לסרטון הקודם בתור
function playPreviousVideo() {
    if (!currentPlayingId || activeQueue.length === 0) return;
    const currentIndex = activeQueue.findIndex(v => v.id === currentPlayingId);
    
    if (currentIndex > 0) {
        const prevVid = activeQueue[currentIndex - 1];
        playVideoFromObject(prevVid);
    } else {
        console.log("אין סרטון קודם בתור");
    }
}

function getQueuePlaybackState() {
    const queueLength = activeQueue.length;
    const currentIndex = activeQueue.findIndex(v => v.id === currentPlayingId);
    return {
        queueLength,
        currentIndex,
        hasPrevious: currentIndex > 0,
        hasNext: currentIndex >= 0 && currentIndex < queueLength - 1
    };
}

function safeSetMediaActionHandler(action, handler) {
    try {
        navigator.mediaSession.setActionHandler(action, handler);
    } catch (err) {
        console.warn(`MediaSession action not supported: ${action}`, err);
    }
}

function updateMediaSessionMetadata(videoData) {
    if (!('mediaSession' in navigator) || !videoData) return;

    const { queueLength, currentIndex, hasNext, hasPrevious } = getQueuePlaybackState();
    const inPlaylist = queueLength > 1 && currentIndex >= 0;
    const albumLabel = inPlaylist
        ? `VideoStation • Playlist ${currentIndex + 1}/${queueLength}`
        : 'VideoStation';

    navigator.mediaSession.metadata = new MediaMetadata({
        title: videoData.t || "ללא כותרת",
        artist: videoData.c || "FIE Player",
        album: albumLabel,
        artwork: [
            { src: `https://i.ytimg.com/vi/${videoData.id}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' },
            { src: `https://i.ytimg.com/vi/${videoData.id}/maxresdefault.jpg`, sizes: '1280x720', type: 'image/jpeg' }
        ]
    });

    safeSetMediaActionHandler('play', () => {
        if (ytPlayer && ytPlayer.playVideo) ytPlayer.playVideo();
    });
    safeSetMediaActionHandler('pause', () => {
        if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
    });
    safeSetMediaActionHandler('nexttrack', hasNext ? () => {
        console.log("MediaSession: Next Track Clicked");
        playNextVideo();
    } : null);
    safeSetMediaActionHandler('previoustrack', hasPrevious ? () => {
        console.log("MediaSession: Previous Track Clicked");
        playPreviousVideo();
    } : null);
}

// פונקציית עזר להמרת אובייקט סרטון לקידוד והפעלה
function playVideoFromObject(vid) {
    const videoData = {
        id: vid.id,
        t: vid.title,
        c: vid.channel_title,
        cat: categoryMap[vid.category_id] || "כללי",
        v: vid.views_count,
        l: vid.likes_count
    };
    const encoded = btoa(encodeURIComponent(JSON.stringify(videoData)));
    preparePlay(encoded);
}

async function init() {
    try {
        const savedState = loadSavedAppState();

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

        if (savedState?.playbackMode || typeof savedState?.isSearchPlaybackPinned === 'boolean') {
            playbackMode = savedState.playbackMode || (savedState.isSearchPlaybackPinned ? 'playlist' : 'smart');
        }

        if (savedState?.searchQuery) {
            const searchInput = document.getElementById('globalSearch');
            if (searchInput) searchInput.value = savedState.searchQuery;
            currentChannelFilter = savedState.channelFilter || null;
            fetchVideos(savedState.searchQuery, false, { preserveChannelFilter: Boolean(savedState.channelFilter) });
        } else {
            fetchVideos();
        }

        if (savedState?.appMode === 'history' && currentUser) {
            displayHistory();
        } else if (savedState?.appMode === 'favorites' && currentUser) {
            displayFavorites();
        }

        if (savedState?.lastPlayedEncodedData) {
            preparePlay(savedState.lastPlayedEncodedData);
        }

        initDraggable();
        initResizer(); 
        renderSearchControls();

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
            <div style="display:flex; align-items:center; gap:15px; width: 100%;">
                ${avatar ? `<img src="${avatar}" class="profile-avatar">` : '<div class="profile-avatar"><i class="fa-solid fa-user"></i></div>'}
                <div class="user-text-details" style="display:flex; flex-direction:column;">
                    <span style="font-size:14px; font-weight:bold;">${escapeHtml(currentUser.user_metadata.full_name)}</span>
                    <span onclick="logout()" style="color:#b3b3b3; font-size:11px; cursor:pointer; text-decoration:none;">התנתק</span>
                </div>
            </div>`;
    } else {
        userDiv.innerHTML = `<button class="btn-login" onclick="login()" title="התחבר עם Google"><span>התחבר עם Google</span></button>`;
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

function normalizeSearchTerm(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function normalizeChannelKey(text) {
    const normalized = normalizeSearchTerm(text)
        .toLowerCase()
        .replace(/[\u0591-\u05C7]/g, '')
        .replace(/['"`.,!?()-]/g, '')
        .replace(/ו/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized;
}

function detectChannelMatchesFromResults(videos, query) {
    const normalized = normalizeSearchTerm(query);
    if (!normalized || normalized.length < 2 || !Array.isArray(videos) || videos.length === 0) return [];

    const channelsMap = new Map();
    for (const row of videos) {
        if (!row?.channel_title) continue;
        const key = normalizeChannelKey(row.channel_title);
        if (!channelsMap.has(key)) {
            channelsMap.set(key, {
                name: row.channel_title,
                thumbnail: row.thumbnail || '',
                sampleCount: 0
            });
        }
        channelsMap.get(key).sampleCount += 1;
        if (!channelsMap.get(key).thumbnail && row.thumbnail) {
            channelsMap.get(key).thumbnail = row.thumbnail;
        }
    }

    const names = [...channelsMap.values()];
    if (names.length === 0) return [];

    const rankingQuery = normalized.toLowerCase();
    const rankingQueryKey = normalizeChannelKey(normalized);

    return names
        .map((channel) => {
            const n = channel.name.toLowerCase();
            const nKey = normalizeChannelKey(channel.name);
            const words = rankingQuery.split(' ').filter(Boolean);
            const keyWords = rankingQueryKey.split(' ').filter(Boolean);
            let score = 0;

            if (n === rankingQuery) score += 100;
            if (n.startsWith(rankingQuery)) score += 70;
            if (n.includes(rankingQuery)) score += 40;
            if (nKey === rankingQueryKey) score += 100;
            if (nKey.startsWith(rankingQueryKey)) score += 65;
            if (nKey.includes(rankingQueryKey)) score += 45;

            const covered = words.filter((w) => n.includes(w)).length;
            const coveredKey = keyWords.filter((w) => nKey.includes(w)).length;
            score += covered * 8;
            score += coveredKey * 10;

            score += Math.min(channel.sampleCount, 10);
            return { ...channel, score };
        })
        .filter((item) => item.score >= 40)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
}



function renderSearchControls() {
    const controls = document.getElementById('search-controls');
    if (!controls) return;

    const playbackIsPlaylist = playbackMode === 'playlist';
    const modeLabel = playbackIsPlaylist
        ? 'ניגון תוצאות החיפוש כפלייליסט'
        : 'הפעלה חכמה מבוססת אלגוריתם';

    const channelsToRender = channelMatchResults.length > 0
        ? channelMatchResults
        : (currentChannelFilter
            ? [{
                name: currentChannelFilter,
                thumbnail: '',
                sampleCount: 0
            }]
            : []);

    const channelCards = channelsToRender.length > 0
        ? `
        <div class="channel-cards-row">
            ${channelsToRender.map((channel) => {
                const safeName = escapeHtml(channel.name);
                const safeThumb = escapeHtml(channel.thumbnail || '');
                const countText = channel.sampleCount > 0 ? `${channel.sampleCount} סרטונים לדוגמה` : 'ערוץ תואם';
                const safeCountText = escapeHtml(countText);
                const isActive = currentChannelFilter && normalizeChannelKey(currentChannelFilter) === normalizeChannelKey(channel.name);
                const activeClass = isActive ? 'active' : '';
                const encodedName = btoa(encodeURIComponent(channel.name));

                return `
                    <button class="channel-card ${activeClass}" onclick="applyChannelFilterByName('${encodedName}')" title="הצג תוצאות מהערוץ בלבד">
                        <div class="channel-card-thumb v-thumb">
                            ${safeThumb ? `<img src="${safeThumb}" alt="${safeName}" loading="lazy">` : '<div class="channel-card-fallback"><i class="fa-solid fa-tv"></i></div>'}
                        </div>
                        <div class="channel-card-info v-info">
                            <h3>${safeName}</h3>
                            <p>${safeCountText}</p>
                        </div>
                        <div class="channel-card-footer card-footer">
                            <span><i class="fa-solid fa-tv"></i> ערוץ</span>
                            <span>סנן תוצאות</span>
                        </div>
                    </button>
                `;
            }).join('')}
        </div>
        `
        : '';

    const modeHelpText = playbackIsPlaylist
        ? 'מצב פלייליסט: מנגן ברצף את תוצאות החיפוש הנוכחיות'
        : 'מצב חכם: בוחר עבורך סרטון מומלץ אוטומטית בסיום הניגון';

    const modeToggle = `
        <div class="search-controls-top">
            <span class="playback-mode-label">${modeLabel}</span>
            <div class="playback-toggle-wrap ${playbackIsPlaylist ? 'mode-playlist' : 'mode-smart'}">
                <span class="playback-toggle-icon playback-toggle-icon-left" aria-hidden="true"><i class="fa-solid fa-list-ul"></i></span>
                <button class="playback-toggle ${playbackIsPlaylist ? 'playlist' : 'smart'}" onclick="togglePlaybackMode()" title="${modeHelpText}" aria-label="${modeHelpText}">
                    <span class="playback-toggle-track">
                        <span class="playback-toggle-thumb"></span>
                    </span>
                </button>
                <span class="playback-toggle-icon playback-toggle-icon-right" aria-hidden="true"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
                <span class="playback-toggle-hint">${modeHelpText}</span>
            </div>
        </div>
    `;

    controls.innerHTML = `${channelCards}${modeToggle}`;
}



async function fetchVideos(query = "", isAppend = false, options = {}) {
    if (isLoadingVideos) return;
    currentAppMode = 'home';
    
    const preserveChannelFilter = Boolean(options.preserveChannelFilter);

    if (!isAppend) {
        currentSearchQuery = normalizeSearchTerm(query);
        currentResolvedSearchQuery = "";
        loadedVideosCount = 0;
        hasMoreVideos = true;
        if (!preserveChannelFilter) {
            channelMatchResults = [];
            currentChannelFilter = null;
        }
    } else if (!hasMoreVideos) {
        return;
    }

    const searchToken = !isAppend ? ++currentSearchToken : currentSearchToken;
    isLoadingVideos = true;
    
    const from = loadedVideosCount;
    const to = from + VIDEOS_PER_PAGE - 1;
    let fetchedData = null;

    if (currentChannelFilter) {
        // חיפוש ממוקד ערוץ
        const { data } = await client.from('videos')
            .select('id, title, channel_title, thumbnail, duration, views, likes, category_id')
            .ilike('channel_title', currentChannelFilter)
            .order('published_at', { ascending: false })
            .range(from, to);
        fetchedData = data || [];
    } else if (!currentSearchQuery) {
        // דף הבית - סרטונים אחרונים
        const { data } = await client.from('videos')
            .select('id, title, channel_title, thumbnail, duration, views, likes, category_id')
            .order('published_at', { ascending: false })
            .range(from, to);
        fetchedData = data;
    } else {
        // חיפוש טקסט חופשי
        const cleanQuery = currentSearchQuery.replace(/[^\w\sא-ת]/g, ' ').trim();

        if (!cleanQuery) {
            fetchedData = [];
        } else {
            if (!isAppend || !currentResolvedSearchQuery) {
                const translated = await getTranslationWithDB(cleanQuery);
                currentResolvedSearchQuery = translated && translated.trim()
                    ? translated.trim()
                    : cleanQuery;
            }

            if (searchToken !== currentSearchToken || currentChannelFilter) {
                isLoadingVideos = false;
                return;
            }

            const { data } = await client.rpc('search_videos_prioritized', { search_term: currentResolvedSearchQuery })
            .range(from, to);
            fetchedData = data || [];
        }

        if (!isAppend) {
            // זיהוי ערוצים מתוך אותן תוצאות חיפוש (ללא שאילתה נוספת)
            const channelQuery = currentResolvedSearchQuery || cleanQuery;
            channelMatchResults = detectChannelMatchesFromResults(fetchedData, channelQuery);
        }
    }

    if (searchToken !== currentSearchToken) {
        isLoadingVideos = false;
        return;
    }

    renderSearchControls();

    if (fetchedData && fetchedData.length > 0) {
        renderVideoGrid(fetchedData, isAppend);
        if (playbackMode === 'playlist' && !isAppend) pinnedSearchResults = [...displayResults];
        loadedVideosCount += fetchedData.length;
        
        if (fetchedData.length < VIDEOS_PER_PAGE) {
            hasMoreVideos = false;
        }
    } else {
        if (!isAppend) {
            renderVideoGrid([]);
            if (playbackMode === 'playlist') pinnedSearchResults = [];
        }
        hasMoreVideos = false;
    }

    isLoadingVideos = false;
    saveAppState();

    if (currentPlayingId) {
        updateMediaSessionMetadata({ 
            id: currentPlayingId, 
            t: document.getElementById('current-title')?.textContent, 
            c: document.getElementById('current-channel')?.textContent 
        });
    }
}

async function getTranslationWithDB(text) {
    if (!text) return null;
    
    try {
        const { data: existingTranslation, error: fetchError } = await client
            .from(TRANSLATION_TABLE)
            .select(COL_TRANSLATED)
            .eq(COL_ORIGINAL, text)
            .single();

        if (existingTranslation && existingTranslation[COL_TRANSLATED]) {
            return existingTranslation[COL_TRANSLATED];
        }

        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=iw&tl=en&dt=t&dt=rm&q=${encodeURI(text)}`;
        const res = await fetch(url);
        const data = await res.json();

        const translation = data[0][0][0];
        
        let transliteration = "";
        if (data[0][1] && (data[0][1][3] || data[0][1][2])) {
            transliteration = data[0][1][3] || data[0][1][2];
        }

        const combinedResult = transliteration 
            ? `${translation} ${transliteration}` 
            : translation;

        if (combinedResult && combinedResult.toLowerCase() !== text.toLowerCase()) {
            await client.from(TRANSLATION_TABLE).insert([
                { 
                    [COL_ORIGINAL]: text, 
                    [COL_TRANSLATED]: combinedResult 
                }
            ]);
        }
        
        return combinedResult;
    } catch (e) {
        console.error("שגיאה בתהליך התרגום והתעתיק:", e);
        return null;
    }
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
            v: v.views,
            l: v.likes,
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
    if (typeof safetyTimer !== 'undefined') clearTimeout(safetyTimer); 
    
    try {
        const data = JSON.parse(decodeURIComponent(atob(encodedData)));
        lastPlayedEncodedData = encodedData;
        currentPlayingId = data.id; 
        activeQueue = playbackMode === 'playlist' && pinnedSearchResults ? [...pinnedSearchResults] : [...displayResults];
        saveAppState();

        // --- שליחה לגוגל אנליטיקס ---
        if (typeof gtag === 'function') {
            const userName = currentUser ? currentUser.user_metadata.full_name : 'Guest';
            gtag('event', 'video_start', {
                'video_title': data.t,
                'video_id': data.id,
                'video_category': data.cat || "כללי",
                'user_name': userName
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

        // פונקציית מעבר פנימית (Fallback)
        function triggerNext() {
            if (window.autoPlayTriggered) return;
            window.autoPlayTriggered = true;
            if (typeof safetyTimer !== 'undefined') clearTimeout(safetyTimer);
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
                host: 'https://www.youtube.com',
                playerVars: {
                    'autoplay': 1,
                    'mute': 0,
                    'controls': 1,
                    'origin': myOrigin,
                    'widget_referrer': myOrigin,
                    'enablejsapi': 1,
                    'rel': 0,
                    'showinfo': 0,
                    'modestbranding': 1
                },
                events: {
                    'onReady': (event) => {
                        event.target.playVideo();
                    },
                    'onStateChange': async (event) => {
                        if (event.data === YT.PlayerState.PLAYING) {
                            isPlaying = true;
                            updatePlayStatus(true);
                            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = "playing";
                        } else if (event.data === YT.PlayerState.PAUSED) {
                            isPlaying = false;
                            updatePlayStatus(false);
                            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = "paused";
                        } else if (event.data === YT.PlayerState.ENDED) {
                            console.log("הסרטון הסתיים, מחפש המלצה חכמה...");
                            const nextVid = await fetchSmartRecommendation();

                            if (nextVid) {
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
                            } else {
                                triggerNext();
                            }
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

        // --- עדכון היסטוריה ---
        if (currentUser) {
            client.from('history')
                .upsert(
                    { 
                        user_id: currentUser.id, 
                        video_id: data.id, 
                        created_at: new Date().toISOString() 
                    }, 
                    { onConflict: 'user_id,video_id' }
                )
                .then(({ error }) => {
                    if (error) console.error("שגיאה בעדכון היסטוריה:", error.message);
                    if (typeof loadSidebarLists === 'function') loadSidebarLists(); 
                });
        }

        // --- הגדרת Media Session (שלט רחוק ומסך נעילה) ---
        if ('mediaSession' in navigator) {
            updateMediaSessionMetadata(data);
            navigator.mediaSession.playbackState = "playing";
        }

    } catch (e) {
        console.error("שגיאה בהפעלת הסרטון:", e);
    }
}

async function fetchSmartRecommendation() {
    if (playbackMode === 'playlist') {
        return null;
    }

    // 1. בדיקת בסיס: האם יש משתמש מחובר וסרטון פעיל
    if (!currentUser || !currentPlayingId) {
        console.log("Smart Recommendation: No user or no active video.");
        return null;
    }

    try {
        // שלב א': שליפת מטא-דאטה של הסרטון הנוכחי
        // אנחנו מוודאים ששולפים את ה-tags וה-category_id המדויקים
        const { data: currentVid, error: vidError } = await client
            .from('videos')
            .select('category_id, tags, channel_title')
            .eq('id', currentPlayingId)
            .single();

        if (vidError || !currentVid) throw new Error("Could not fetch current video metadata");

        // שלב ב': הכנת התגיות
        // מכיוון שה-DB שלך מגדיר 'tags' כ-ARRAY, עלינו להפוך אותו למחרוזת טקסט (String)
        // כדי שה-RPC יוכל לבצע עליו פעולות טקסטואליות (ts_rank)
        const tagsArray = currentVid.tags || [];
        const tagsString = Array.isArray(tagsArray) ? tagsArray.join(' ') : String(tagsArray);

        // שלב ג': קריאה ל-RPC
        const { data: recommendations, error: rpcError } = await client.rpc('get_smart_recommendations', {
    p_user_id: currentUser.id,
    p_current_video_id: currentPlayingId,
    p_category_id: currentVid.category_id,
    p_current_tags: tagsString, 
    p_channel_title: currentVid.channel_title, // הוספת פסיק כאן
    p_limit: 1 
});

        if (rpcError) {
            console.error("RPC Error details:", rpcError);
            throw rpcError;
        }

        // בדיקה אם חזרה תוצאה
        if (recommendations && recommendations.length > 0) {
            const rec = recommendations[0];
            console.log("Smart Recommendation found:", rec.title);
            
            // אנחנו מוודאים שהאובייקט כולל את כל השדות שה-preparePlay צריך
            return {
                id: rec.id,
                title: rec.title,
                channel_title: rec.channel_title,
                thumbnail: rec.thumbnail,
                duration: rec.duration,
                views_count: rec.views_count,
                likes_count: rec.likes_count,
                category_id: rec.category_id
            };
        }

        console.log("Smart Recommendation: No suitable videos found.");
        return null;

    } catch (err) {
        console.error("Smart Recommendation System Error:", err.message);
        return null;
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
    if (!currentUser) {
        showCustomAlert(
            'רוצה לשמור את הסרטון?',
            'התחבר עכשיו בחינם כדי לשמור את הסרטונים שאתה הכי אוהב ולגשת אליהם מכל מכשיר בקלות ובמהירות!',
            'התחבר עם Google',
            login
        );
        return;
    }
    // ... המשך הקוד הקיים של הפונקציה 
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
            <div class="nav-link" onclick='displayHistory()' title="היסטוריית צפייה">
                <i class="fa-solid fa-clock-rotate-left"></i>
                <span class="nav-text">היסטוריית צפייה</span>
            </div>
            <div class="nav-link" onclick='displayFavorites()' title="סרטונים שאהבתי">
                <i class="fa-solid fa-heart"></i>
                <span class="nav-text">סרטונים שאהבתי</span>
            </div>
        `;
    }
}
function goHome() {
    // 1. עדכון המצב חזרה לדף הבית כדי שהגלילה תעבוד שוב
    currentAppMode = 'home';

    // 2. עדכון הכותרת הראשית (אם יש לך אחת כזו)
    const title = document.getElementById('main-title');
    if (title) title.textContent = "דף הבית"; // שנה לטקסט שמתאים לך

    // 3. איפוס שורת החיפוש (כדי למחוק חיפוש קודם אם היה)
    const searchInput = document.getElementById('globalSearch');
    if (searchInput) searchInput.value = "";

    channelMatchResults = [];
    currentChannelFilter = null;
    renderSearchControls();

    // 4. קריאה לפונקציית טעינת הסרטונים
    // כשאנחנו קוראים לה ככה, היא כבר מאפסת את המשתנים (loadedVideosCount, hasMoreVideos)
    // בזכות בלוק ה- if (!isAppend) שכבר קיים אצלך בקוד!
    fetchVideos("");
    saveAppState();
}

async function displayHistory() {
    if (!currentUser) return;
    currentAppMode = 'history';
    const { data } = await client.from('history').select('*, videos(*)').eq('user_id', currentUser.id).order('created_at', { ascending: false });
    const title = document.getElementById('main-title');
    if (title) title.textContent = "היסטוריית צפייה";
    if (data) renderVideoGrid(data.map(i => i.videos).filter(v => v));
    saveAppState();
}

async function displayFavorites() {
    if (!currentUser) return;
    currentAppMode = 'favorites';
    const { data } = await client.from('favorites').select('*, videos(*)').eq('user_id', currentUser.id);
    const title = document.getElementById('main-title');
    if (title) title.textContent = "מועדפים";
    if (data) renderVideoGrid(data.map(i => i.videos).filter(v => v));
    saveAppState();
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
            // טוען רק אם אנחנו בעמוד הראשי (או חיפוש) ולא בהיסטוריה/מועדפים
            if (currentAppMode === 'home' && !isLoadingVideos && hasMoreVideos) {
                fetchVideos(currentSearchQuery, true);
            }
        }
    });
}

let searchDebounceTimeout = null;
const searchInput = document.getElementById('globalSearch');

// אירוע הקלדה (Input) - מפעיל טיימר של 1000 מילישניות
searchInput.addEventListener('input', (e) => {
    const query = normalizeSearchTerm(e.target.value);

    // איפוס הטיימר הקודם בכל הקלדה חדשה
    clearTimeout(searchDebounceTimeout);
    clearTimeout(analyticsTimeout);

    // הגדרת טיימר חדש לחיפוש
    searchDebounceTimeout = setTimeout(() => {
        // קריאה ל-fetchVideos ללא פרמטר שני אומרת לו לרנדר מהתחלה (isAppend = false)
        fetchVideos(query);
        triggerAnalytics(query);
    }, 500);
});

// אירוע מקלדת (Keydown) - מזהה לחיצה על אנטר לביצוע מיידי
searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const query = normalizeSearchTerm(e.target.value);
        
        // ביטול הטיימר הממתין כדי שלא ירוץ החיפוש פעמיים
        clearTimeout(searchDebounceTimeout);
        clearTimeout(analyticsTimeout);
        
        // הפעלה מיידית של החיפוש
        fetchVideos(query);
        triggerAnalytics(query);
    }
});



async function applyChannelFilter(channelName) {
    if (!channelName) return;

    const normalizedChannelName = normalizeSearchTerm(channelName);
    if (!normalizedChannelName) return;

    const searchInput = document.getElementById('globalSearch');
    if (searchInput) searchInput.value = normalizedChannelName;

    currentChannelFilter = normalizedChannelName;
    currentSearchQuery = normalizedChannelName;
    currentAppMode = 'home';

    if (!channelMatchResults.some(c => normalizeChannelKey(c.name) === normalizeChannelKey(normalizedChannelName))) {
        channelMatchResults = [{ name: normalizedChannelName, thumbnail: '', sampleCount: 0 }];
    }

    await fetchVideos(normalizedChannelName, false, { preserveChannelFilter: true });
}


function applyChannelFilterByName(encodedChannelName) {
    try {
        const decoded = decodeURIComponent(atob(encodedChannelName));
        applyChannelFilter(decoded);
    } catch (err) {
        console.error('Failed to decode channel name:', err);
    }
}

function togglePlaybackMode() {
    playbackMode = playbackMode === 'playlist' ? 'smart' : 'playlist';
    pinnedSearchResults = playbackMode === 'playlist' ? [...displayResults] : null;
    renderSearchControls();
    saveAppState();

    if (currentPlayingId) updateMediaSessionMetadata({ id: currentPlayingId, t: document.getElementById('current-title')?.textContent, c: document.getElementById('current-channel')?.textContent });
}

window.applyChannelFilter = applyChannelFilter;
window.applyChannelFilterByName = applyChannelFilterByName;
window.togglePlaybackMode = togglePlaybackMode;

window.playNextVideo = async function() {
    console.log("מדלג לסרטון הבא (מתעדף המלצה חכמה)...");
    
    // 1. נסיון להביא המלצה חכמה (כמו בסיום סרטון)
    try {
        const nextVid = await fetchSmartRecommendation();

        if (nextVid) {
            console.log("נמצאה המלצה חכמה לדילוג:", nextVid.title);
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
            return; // מצאנו המלצה, עוצרים כאן
        }
    } catch (err) {
        console.error("שגיאה בניסיון להביא המלצה חכמה בדילוג:", err);
    }

    // 2. אם הגענו לכאן, סימן שאין המלצה חכמה - עוברים לתור הרגיל
    console.log("לא נמצאה המלצה חכמה, עובר לסרטון הבא בתור החיפוש.");
    playNextInQueue();
};

window.playPreviousVideo = function() {
    playPreviousVideo();
};
// פונקציית עזר לטיפול באנליטיקס כדי למנוע כפילות קוד
// עדכון בתוך triggerAnalytics:
function triggerAnalytics(query) {
    if (query.length > 0) {
        analyticsTimeout = setTimeout(() => {
            if (typeof gtag === 'function') {
                const userName = currentUser ? currentUser.user_metadata.full_name : 'Guest';
                gtag('event', 'search', {
                    'search_term': query,
                    'user_name': userName
                });
                console.log("Analytics: Search tracked -> " + query + " by " + userName);
            }
        }, 2000); 
    }
}



renderSearchControls();
init();
