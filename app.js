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
let currentSearchToken = 0;
let channelMatchResults = [];
let pinnedSearchResults = null;
let playbackMode = 'playlist'; // 'playlist' | 'smart'

let currentChannelFilter = null;
let userHistoryIds = []; 
let videoWatchCounts = {};
let displayResults = []; 
let activeQueue = [];    
let currentAppMode = 'home'; // יכול להיות 'home', 'history', 'favorites' או 'recent'
// --- משתנים חדשים לניהול הנגן הרשמי ---
let ytPlayer = null;
let currentPlayingId = null;
let safetyTimer = null;
let playbackEngagementTimer = null;
let playbackSessionToken = 0;
let lastPlayedEncodedData = null;
let upNextRecommendations = [];
let isLoadingMoreRecommendations = false;
let isMiniPlayerMode = false;
let youtubePlayerBootstrapped = false;
const sessionLikedVideoIds = new Set();
const recentWatchedVideoIds = new Set();

const APP_STATE_STORAGE_KEY = 'fie:last-app-state';
const LAST_PLAYED_TIME_STORAGE_KEY = 'lastPlayedTime';
const LAST_PLAYED_TIME_VIDEO_ID_STORAGE_KEY = 'lastPlayedTimeVideoId';
const RECOVERY_TOAST_TIMEOUT_MS = 10000;
const THEME_PREFERENCE_STORAGE_KEY = 'fie:theme-preference';

let playbackTrackingInterval = null;
let pendingSeekTime = null;
let recoveryToastTimeout = null;
let currentThemePreference = 'system';
let draggedUpNextElement = null;
let playbackHistoryEncoded = [];
let playbackHistoryCursor = -1;

function saveAppState() {
    try {
        const state = {
            appMode: currentAppMode,
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

function applyThemePreference(preference = 'system') {
    currentThemePreference = preference;
    localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, preference);

    const body = document.body;
    if (!body) return;

    if (preference === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        body.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
        body.setAttribute('data-theme', preference);
    }
    updateThemeModalSelection();
}

function initThemePreference() {
    const savedPreference = localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY) || 'system';
    applyThemePreference(savedPreference);

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', () => {
        if (currentThemePreference === 'system') applyThemePreference('system');
    });
}

function updateThemeModalSelection() {
    const options = document.querySelectorAll('.theme-option');
    options.forEach((option) => {
        option.classList.toggle('is-active', option.dataset.theme === currentThemePreference);
    });
}

function openPreferencesModal() {
    if (!currentUser) {
        showCustomAlert('נדרש להתחבר', 'אפשרויות העדפה זמינות רק למשתמשים מחוברים.', 'התחבר עם גוגל', () => login());
        return;
    }
    const modal = document.getElementById('preferences-modal');
    if (!modal) return;
    updateThemeModalSelection();
    modal.style.display = 'flex';
}

function showLoginRequiredPrompt(featureLabel) {
    showCustomAlert(
        'נדרשת התחברות',
        `כדי לפתוח את "${featureLabel}" צריך להתחבר עם Google.`,
        'התחבר עם גוגל',
        () => login()
    );
}

function handleSidebarAuthAction(target) {
    if (!currentUser) {
        const labels = {
            history: 'היסטוריית צפייה',
            favorites: 'סרטונים שאהבתי',
            recent: 'אחרונים שנוספו',
            preferences: 'העדפות'
        };
        showLoginRequiredPrompt(labels[target] || 'אפשרות זו');
        return;
    }

    if (target === 'history') displayHistory();
    else if (target === 'favorites') displayFavorites();
    else if (target === 'recent') displayRecentlyAdded();
    else if (target === 'preferences') openPreferencesModal();
}

function closePreferencesModal() {
    const modal = document.getElementById('preferences-modal');
    if (modal) modal.style.display = 'none';
}

function selectTheme(theme) {
    applyThemePreference(theme);
}

function saveLastPlaybackTime() {
    if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function' || !currentPlayingId) return;
    const currentTime = Math.floor(ytPlayer.getCurrentTime() || 0);
    localStorage.setItem(LAST_PLAYED_TIME_STORAGE_KEY, String(currentTime));
    localStorage.setItem(LAST_PLAYED_TIME_VIDEO_ID_STORAGE_KEY, currentPlayingId);
}

function startPlaybackTracking() {
    if (playbackTrackingInterval) return;
    playbackTrackingInterval = setInterval(() => {
        if (isPlaying) saveLastPlaybackTime();
    }, 5000);
}

function stopPlaybackTracking() {
    if (!playbackTrackingInterval) return;
    clearInterval(playbackTrackingInterval);
    playbackTrackingInterval = null;
}

function clearSavedPlaybackData(clearAppState = true) {
    localStorage.removeItem(LAST_PLAYED_TIME_STORAGE_KEY);
    localStorage.removeItem(LAST_PLAYED_TIME_VIDEO_ID_STORAGE_KEY);
    pendingSeekTime = null;

    if (clearAppState) {
        lastPlayedEncodedData = null;
        currentPlayingId = null;
        saveAppState();
    }
}

function getThreeDaysAgoIso() {
    const date = new Date();
    date.setDate(date.getDate() - 3);
    return date.toISOString();
}

function isRecentlyWatched(videoId) {
    return recentWatchedVideoIds.has(videoId);
}

async function refreshRecentWatchedVideos() {
    recentWatchedVideoIds.clear();
    if (!currentUser) return;

    try {
        const { data, error } = await client
            .from('history')
            .select('video_id, created_at')
            .eq('user_id', currentUser.id)
            .gte('created_at', getThreeDaysAgoIso());

        if (error) throw error;
        (data || []).forEach((item) => {
            if (item.video_id) recentWatchedVideoIds.add(item.video_id);
        });
    } catch (err) {
        console.warn('Failed to refresh recent watched videos:', err);
    }
}

function showRecoveryToast(encodedData, savedTimestamp) {
    const content = document.querySelector('.content');
    if (!content) return;

    const existing = document.getElementById('recovery-toast');
    if (existing) existing.remove();
    if (recoveryToastTimeout) clearTimeout(recoveryToastTimeout);

    const toast = document.createElement('div');
    toast.id = 'recovery-toast';
    toast.className = 'recovery-toast';
    toast.innerHTML = `
        <div class="recovery-toast-text">להמשיך בצפייה מאיפה שהפסקת?</div>
        <div class="recovery-toast-actions">
            <button class="recovery-btn recovery-btn-continue" id="recovery-continue-btn">המשך</button>
            <button class="recovery-btn recovery-btn-cancel" id="recovery-cancel-btn">ביטול / התחל מחדש</button>
        </div>
        <div class="recovery-progress"><div class="recovery-progress-bar"></div></div>
    `;
    content.appendChild(toast);

    const closeToast = ({ clearSaved = false } = {}) => {
        if (recoveryToastTimeout) {
            clearTimeout(recoveryToastTimeout);
            recoveryToastTimeout = null;
        }
        toast.remove();
        if (clearSaved) clearSavedPlaybackData(true);
    };

    toast.querySelector('#recovery-continue-btn')?.addEventListener('click', () => {
        pendingSeekTime = Math.max(0, Number(savedTimestamp) || 0);
        closeToast();
        preparePlay(encodedData);
    });

    toast.querySelector('#recovery-cancel-btn')?.addEventListener('click', () => {
        closeToast({ clearSaved: true });
    });

    recoveryToastTimeout = setTimeout(() => {
        closeToast({ clearSaved: true });
    }, RECOVERY_TOAST_TIMEOUT_MS);
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
    if (!currentPlayingId) return;

    const nextVid = upNextRecommendations.find((video) => video.id !== currentPlayingId);
    if (nextVid) {
        playVideoFromObject(nextVid);
        return;
    }

    if (typeof window.playNextVideo === 'function' && window.playNextVideo !== playNextVideo) {
        window.playNextVideo();
        return;
    }
    console.log("אין סרטון הבא בתור");
}

// מעבר יזום לסרטון הקודם בתור
function playPreviousVideo() {
    if (playbackHistoryCursor <= 0 || playbackHistoryEncoded.length < 2) {
        console.log("אין סרטון קודם בתור");
        return;
    }

    const targetCursor = playbackHistoryCursor - 1;
    const previousEncoded = playbackHistoryEncoded[targetCursor];
    if (!previousEncoded) return;
    playbackHistoryCursor = targetCursor;
    preparePlay(previousEncoded, { source: 'history-nav', historyCursor: targetCursor });
}

function getQueuePlaybackState() {
    const playlistIndex = activeQueue.findIndex((video) => video.id === currentPlayingId);
    if (playbackMode === 'playlist' && playlistIndex >= 0) {
        const queueLength = activeQueue.length;
        return {
            queueLength,
            currentIndex: playlistIndex,
            hasPrevious: playbackHistoryCursor > 0 || playlistIndex > 0,
            hasNext: playlistIndex < queueLength - 1
        };
    }

    const queueIds = currentPlayingId ? [currentPlayingId] : [];
    upNextRecommendations.forEach((video) => {
        if (video.id !== currentPlayingId) queueIds.push(video.id);
    });
    const queueLength = queueIds.length;
    const currentIndex = currentPlayingId ? 0 : -1;
    return {
        queueLength,
        currentIndex,
        hasPrevious: playbackHistoryCursor > 0,
        hasNext: queueLength > 1
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
        v: getVideoViews(vid),
        l: getVideoLikes(vid)
    };
    const encoded = btoa(encodeURIComponent(JSON.stringify(videoData)));
    preparePlay(encoded);
}

async function init() {
    try {
        initThemePreference();
        const savedState = loadSavedAppState();

        const { data: { user } } = await client.auth.getUser();
        currentUser = user;
        
        client.auth.onAuthStateChange((event, session) => {
            currentUser = session?.user || null;
            updateUserUI();
            loadSidebarLists();
            refreshRecentWatchedVideos();
            if (!currentUser && playbackMode === 'smart') {
                playbackMode = 'playlist';
            }
            renderSearchControls();
            renderPlayerModeToggle();
            updatePlayerBarFavoriteButton();
        });

        updateUserUI();
        loadSidebarLists();
        
        if (currentUser) {
            const { data: favs } = await client.from('favorites')
                .select('video_id')
                .eq('user_id', currentUser.id);
            userFavorites = favs ? favs.map(f => f.video_id) : [];
            updatePlayerBarFavoriteButton();
            refreshRecentWatchedVideos();
        }

        if (savedState?.playbackMode || typeof savedState?.isSearchPlaybackPinned === 'boolean') {
            playbackMode = savedState.playbackMode || (savedState.isSearchPlaybackPinned ? 'playlist' : 'smart');
        }
        if (playbackMode === 'smart' && !currentUser) {
            playbackMode = 'playlist';
        }

        fetchVideos();

        if (savedState?.appMode === 'history' && currentUser) {
            displayHistory();
        } else if (savedState?.appMode === 'favorites' && currentUser) {
            displayFavorites();
        } else if (savedState?.appMode === 'recent') {
            displayRecentlyAdded();
        }

        if (savedState?.lastPlayedEncodedData) {
            const savedTime = Number(localStorage.getItem(LAST_PLAYED_TIME_STORAGE_KEY) || 0);
            const savedTimeVideoId = localStorage.getItem(LAST_PLAYED_TIME_VIDEO_ID_STORAGE_KEY);
            const shouldOfferResume = savedTime > 0 && savedTimeVideoId && savedTimeVideoId === savedState.currentPlayingId;

            if (shouldOfferResume) {
                showRecoveryToast(savedState.lastPlayedEncodedData, savedTime);
            } else {
                clearSavedPlaybackData(true);
            }
        }

        initPlayerInteractions();
        renderSearchControls();
        renderPlayerModeToggle();
        startPlaybackTracking();
        window.addEventListener('beforeunload', saveLastPlaybackTime);
        window.addEventListener('popstate', handlePlaybackPopState);

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

function getVideoViews(video) {
    return video?.views_count ?? video?.views ?? 0;
}

function getVideoLikes(video) {
    return video?.likes_count ?? video?.likes ?? 0;
}

function updatePlayerBarFavoriteButton(videoId = currentPlayingId) {
    const icon = document.getElementById('player-fav-icon');
    const btn = document.getElementById('player-fav-btn');
    if (!icon || !btn) return;

    const hasVideo = Boolean(videoId);
    const isFav = hasVideo && userFavorites.includes(videoId);
    icon.className = isFav ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
    btn.title = isFav ? 'הסר ממועדפים' : 'הוסף למועדפים';
    btn.setAttribute('aria-label', btn.title);
    btn.disabled = !hasVideo;
}

function schedulePlaybackEngagement(videoId, sessionToken) {
    clearTimeout(playbackEngagementTimer);

    playbackEngagementTimer = setTimeout(async () => {
        if (sessionToken !== playbackSessionToken || currentPlayingId !== videoId) return;

        try {
            const { data: existing } = await client
                .from('videos')
                .select('views')
                .eq('id', videoId)
                .single();

            const nextViews = (existing?.views || 0) + 1;
            await client.from('videos').update({ views: nextViews }).eq('id', videoId);

            if (sessionToken === playbackSessionToken && currentPlayingId === videoId) {
                const statViews = document.getElementById('stat-views');
                if (statViews) statViews.innerHTML = `<i class="fa-solid fa-eye"></i> ${nextViews}`;
            }
        } catch (err) {
            console.warn('View counter update failed:', err);
        }

        if (currentUser && sessionToken === playbackSessionToken && currentPlayingId === videoId) {
            client.from('history')
                .upsert(
                    {
                        user_id: currentUser.id,
                        video_id: videoId,
                        created_at: new Date().toISOString()
                    },
                    { onConflict: 'user_id,video_id' }
                )
                .then(({ error }) => {
                    if (error) console.error('שגיאה בעדכון היסטוריה:', error.message);
                    if (!error && videoId) recentWatchedVideoIds.add(videoId);
                    if (typeof loadSidebarLists === 'function') loadSidebarLists();
                });
        }
    }, 30000);
}

function toggleCurrentPlayingFavorite() {
    if (!currentPlayingId) return;
    toggleFavorite(currentPlayingId);
}

function updateLikeButtonState(videoId = currentPlayingId) {
    const btn = document.getElementById('player-like-btn');
    const icon = document.getElementById('player-like-icon');
    if (!btn || !icon) return;

    const isLiked = Boolean(videoId) && sessionLikedVideoIds.has(videoId);
    icon.className = isLiked ? 'fa-solid fa-thumbs-up' : 'fa-regular fa-thumbs-up';
    btn.classList.toggle('is-active', isLiked);
    btn.title = isLiked ? 'בטל לייק' : 'לייק';
}

async function toggleCurrentVideoLike() {
    if (!currentPlayingId) return;

    const isLiked = sessionLikedVideoIds.has(currentPlayingId);
    const delta = isLiked ? -1 : 1;

    if (isLiked) {
        sessionLikedVideoIds.delete(currentPlayingId);
    } else {
        sessionLikedVideoIds.add(currentPlayingId);
    }
    updateLikeButtonState(currentPlayingId);

    const likesNode = document.getElementById('stat-likes');
    const currentLikes = Number((likesNode?.textContent || '').replace(/[^\d]/g, '')) || 0;
    const nextLikes = Math.max(currentLikes + delta, 0);
    if (likesNode) likesNode.innerHTML = `<i class="fa-solid fa-thumbs-up"></i> ${nextLikes}`;

    try {
        const { data: existing } = await client.from('videos').select('likes').eq('id', currentPlayingId).single();
        const dbNextLikes = Math.max((existing?.likes || 0) + delta, 0);
        await client.from('videos').update({ likes: dbNextLikes }).eq('id', currentPlayingId);
    } catch (err) {
        console.warn('Like update failed:', err);
    }
}

function expandPlayerView() {
    if (!currentPlayingId) return;
    setPlayerMode(false);
}

function detectChannelMatchesFromResults(videos, query) {
    const normalized = normalizeSearchTerm(query);
    if (!normalized || normalized.length < 2 || !Array.isArray(videos) || videos.length === 0) return [];

    const channelsMap = new Map();
    for (const row of videos) {
        const primaryName = row?.channel_title || row?.channel_title_he;
        if (!primaryName) continue;

        const key = normalizeChannelKey(primaryName);
        const heName = normalizeSearchTerm(row.channel_title_he || "");
        const enName = normalizeSearchTerm(row.channel_title || "");

        if (!channelsMap.has(key)) {
            channelsMap.set(key, {
                name: primaryName,
                aliases: [],
                thumbnail: row.thumbnail || '',
                sampleCount: 0
            });
        }

        const channel = channelsMap.get(key);
        channel.sampleCount += 1;
        if (!channel.thumbnail && row.thumbnail) {
            channel.thumbnail = row.thumbnail;
        }

        if (heName && !channel.aliases.some((alias) => normalizeChannelKey(alias) === normalizeChannelKey(heName))) {
            channel.aliases.push(heName);
        }
        if (enName && !channel.aliases.some((alias) => normalizeChannelKey(alias) === normalizeChannelKey(enName))) {
            channel.aliases.push(enName);
        }
    }

    const names = [...channelsMap.values()];
    if (names.length === 0) return [];

    const rankingQuery = normalized.toLowerCase();
    const rankingQueryKey = normalizeChannelKey(normalized);

    return names
        .map((channel) => {
            const words = rankingQuery.split(' ').filter(Boolean);
            const keyWords = rankingQueryKey.split(' ').filter(Boolean);

            const candidateNames = [channel.name, ...(channel.aliases || [])]
                .filter(Boolean)
                .map((name) => normalizeSearchTerm(name))
                .filter(Boolean);

            let score = 0;
            for (const candidate of candidateNames) {
                const n = candidate.toLowerCase();
                const nKey = normalizeChannelKey(candidate);
                let candidateScore = 0;

                if (n === rankingQuery) candidateScore += 100;
                if (n.startsWith(rankingQuery)) candidateScore += 70;
                if (n.includes(rankingQuery)) candidateScore += 40;
                if (nKey === rankingQueryKey) candidateScore += 100;
                if (nKey.startsWith(rankingQueryKey)) candidateScore += 65;
                if (nKey.includes(rankingQueryKey)) candidateScore += 45;

                const covered = words.filter((w) => n.includes(w)).length;
                const coveredKey = keyWords.filter((w) => nKey.includes(w)).length;
                candidateScore += covered * 8;
                candidateScore += coveredKey * 10;

                score = Math.max(score, candidateScore);
            }

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

    controls.innerHTML = `${channelCards}
        <div class="search-controls-top">
            <span class="playback-mode-label">${modeLabel}</span>
        </div>`;
}

function renderPlayerModeToggle() {
    const wrap = document.getElementById('player-mode-toggle-wrap');
    if (!wrap) return;

    const playbackIsPlaylist = playbackMode === 'playlist';
    const modeHelpText = playbackIsPlaylist
        ? 'מצב פלייליסט: מנגן ברצף את תוצאות החיפוש הנוכחיות'
        : 'מצב חכם: בוחר עבורך סרטון מומלץ אוטומטית בסיום הניגון';

    wrap.innerHTML = `
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
    `;
}



async function fetchVideos(query = "", isAppend = false, options = {}) {
    if (isLoadingVideos && isAppend) return;
    currentAppMode = 'home';
    
    const preserveChannelFilter = Boolean(options.preserveChannelFilter);

    if (!isAppend) {
        currentSearchQuery = normalizeSearchTerm(query);
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
            .select('id, title, channel_title, channel_title_he, thumbnail, duration, views, likes, category_id')
            .or(`channel_title.ilike.%${currentChannelFilter}%,channel_title_he.ilike.%${currentChannelFilter}%`)
            .order('published_at', { ascending: false })
            .range(from, to);
        fetchedData = data || [];
    } else if (!currentSearchQuery) {
        // דף הבית - סרטונים אחרונים
        const { data } = await client.from('videos')
            .select('id, title, channel_title, channel_title_he, thumbnail, duration, views, likes, category_id')
            .order('published_at', { ascending: false })
            .range(from, to);
        fetchedData = data;
    } else {
        // חיפוש טקסט חופשי
        const cleanQuery = currentSearchQuery.replace(/[^\w\sא-ת]/g, ' ').trim();

        if (!cleanQuery) {
            fetchedData = [];
        } else {
            if (searchToken !== currentSearchToken || currentChannelFilter) {
                isLoadingVideos = false;
                return;
            }

            const { data } = await client.rpc('search_videos_prioritized', { search_term: cleanQuery })
            .range(from, to);
            fetchedData = data || [];
        }

        if (!isAppend) {
            // זיהוי ערוצים מתוך אותן תוצאות חיפוש (ללא שאילתה נוספת)
            channelMatchResults = detectChannelMatchesFromResults(fetchedData, cleanQuery);
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

        const favoriteClass = isFav ? 'is-favorite' : '';
        return `
            <div class="v-card ${favoriteClass}" onclick="preparePlay('${encodedData}', { source: 'grid' })">
                <div class="v-thumb">
                    <img src="${v.thumbnail}" alt="${safeTitle}" loading="lazy">
                    <span class="v-duration">${displayDuration}</span>
                </div>
                <div class="v-info">
                    <h3 title="${safeTitle}">${safeTitle}</h3>
                    <p>${safeChannel}</p>
                    <div class="card-footer">
                        <span><i class="fa-solid fa-eye"></i> ${getVideoViews(v)}</span>
                        <div class="card-actions">
                            <button class="queue-btn" onclick="addVideoToUpNextFromGrid('${videoId}', event)" title="הוסף לבאים בתור">
                                <i class="fa-solid fa-list-plus"></i>
                            </button>
                            <button class="fav-btn" onclick="event.stopPropagation(); toggleFavorite('${videoId}')">
                                <i class="${favIconClass} fa-heart" id="fav-icon-${videoId}"></i>
                            </button>
                        </div>
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

function addVideoToUpNextFromGrid(videoId, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    const video = displayResults.find((item) => item.id === videoId);
    if (!video) return;
    if (upNextRecommendations.some((item) => item.id === videoId)) return;

    upNextRecommendations.push(video);
    renderUpNextList();
}

// --- ניהול הנגן (עודכן ל-API רשמי) ---

function setPlayerMode(miniMode) {
    const player = document.getElementById('floating-player');
    const body = document.body;
    const miniSlot = document.getElementById('mini-player-slot');
    if (!player || !body || !miniSlot) return;

    isMiniPlayerMode = miniMode;
    player.classList.toggle('is-mini', miniMode);

    if (miniMode) {
        miniSlot.classList.add('has-mini');
        body.classList.remove('player-open');
        updateMiniPlayerPosition();
    } else {
        miniSlot.classList.remove('has-mini');
        body.classList.toggle('player-open', player.style.display === 'flex');
        player.style.removeProperty('--mini-top');
        player.style.removeProperty('--mini-right');
    }
}

function scrollToSearch() {
    const searchInput = document.getElementById('globalSearch');
    if (!searchInput) return;
    searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => searchInput.focus(), 280);
}

function updateMiniPlayerPosition() {
    if (!isMiniPlayerMode) return;
    const player = document.getElementById('floating-player');
    const miniSlot = document.getElementById('mini-player-slot');
    if (!player || !miniSlot) return;

    const rect = miniSlot.getBoundingClientRect();
    const miniWidth = player.offsetWidth || 360;
    const rightOffset = Math.max(window.innerWidth - rect.right, 8);

    player.style.setProperty('--mini-top', `${Math.max(rect.top, 8)}px`);
    player.style.setProperty('--mini-right', `${Math.max(rightOffset, 8)}px`);
    player.style.setProperty('--mini-left', 'auto');
    player.style.setProperty('--mini-width', `${miniWidth}px`);
}

function renderUpNextList() {
    const list = document.getElementById('up-next-list');
    if (!list) return;

    if (!upNextRecommendations.length) {
        list.innerHTML = '<p style="color:#b3b3b3; font-size:13px; margin:0;">אין כרגע הצעות זמינות.</p>';
        return;
    }

    list.innerHTML = upNextRecommendations.map((video, index) => buildUpNextItemHtml(video, index)).join('');
}

function buildUpNextItemHtml(video, index) {
    const safeTitle = escapeHtml(video.title || 'ללא כותרת');
    const safeChannel = escapeHtml(video.channel_title || '');
    const safeThumb = escapeHtml(video.thumbnail || '');
    const activeClass = video.id === currentPlayingId ? 'active' : '';
    const videoData = {
        id: video.id,
        t: video.title,
        c: video.channel_title,
        cat: categoryMap[video.category_id] || "כללי",
        v: getVideoViews(video),
        l: getVideoLikes(video),
        duration: video.duration
    };
    const encodedData = btoa(encodeURIComponent(JSON.stringify(videoData)));

    return `
        <div class="up-next-item ${activeClass}" 
            draggable="true"
            data-index="${index}"
            data-video-id="${video.id}"
            ondragstart="handleUpNextDragStart(event)"
            ondragover="handleUpNextDragOver(event)"
            ondrop="handleUpNextDrop(event)"
            ondragend="handleUpNextDragEnd(event)"
            onclick="preparePlay('${encodedData}')">
            <div class="up-next-thumb"><img src="${safeThumb}" alt="${safeTitle}" loading="lazy"></div>
            <div class="up-next-info">
                <strong>${safeTitle}</strong>
                <p>${safeChannel}</p>
            </div>
            <button class="up-next-remove-btn" onclick="removeUpNextVideo('${video.id}', event)" title="הסר מהבא בתור" aria-label="הסר מהבא בתור">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    `;
}

function handleUpNextDragStart(event) {
    draggedUpNextElement = event.currentTarget;
    if (!draggedUpNextElement) return;
    event.dataTransfer.effectAllowed = 'move';
    draggedUpNextElement.classList.add('is-dragging');
}

function handleUpNextDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const target = event.currentTarget;
    if (!draggedUpNextElement || !target || draggedUpNextElement === target) return;

    const list = target.parentElement;
    if (!list) return;

    const items = Array.from(list.querySelectorAll('.up-next-item'));
    const beforeRects = new Map(items.map((item) => [item.dataset.videoId, item.getBoundingClientRect()]));

    const rect = target.getBoundingClientRect();
    const shouldInsertAfter = event.clientY > rect.top + rect.height / 2;

    if (shouldInsertAfter) {
        if (target.nextSibling !== draggedUpNextElement) {
            list.insertBefore(draggedUpNextElement, target.nextSibling);
        }
    } else {
        if (target.previousSibling !== draggedUpNextElement) {
            list.insertBefore(draggedUpNextElement, target);
        }
    }

    animateUpNextReflow(list, beforeRects);
}

function handleUpNextDrop(event) {
    event.preventDefault();
    syncUpNextOrderFromDom();
}

function handleUpNextDragEnd(event) {
    syncUpNextOrderFromDom();
    draggedUpNextElement = null;
    event.currentTarget.classList.remove('is-dragging');
}

function syncUpNextOrderFromDom() {
    const list = document.getElementById('up-next-list');
    if (!list) return;
    const orderIds = Array.from(list.querySelectorAll('.up-next-item')).map((item) => item.dataset.videoId);
    if (!orderIds.length) return;

    const byId = new Map(upNextRecommendations.map((video) => [video.id, video]));
    const reordered = orderIds
        .map((id) => byId.get(id))
        .filter(Boolean);

    if (reordered.length === upNextRecommendations.length) {
        upNextRecommendations = reordered;
        renderUpNextList();
    }
}

function animateUpNextReflow(list, beforeRects) {
    const items = Array.from(list.querySelectorAll('.up-next-item'));
    items.forEach((item) => {
        if (item === draggedUpNextElement) return;
        const before = beforeRects.get(item.dataset.videoId);
        if (!before) return;
        const after = item.getBoundingClientRect();
        const deltaY = before.top - after.top;
        if (!deltaY) return;

        item.style.transition = 'none';
        item.style.transform = `translateY(${deltaY}px)`;

        requestAnimationFrame(() => {
            item.style.transition = 'transform 180ms ease';
            item.style.transform = '';
        });
    });
}

function removeUpNextVideo(videoId, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    upNextRecommendations = upNextRecommendations.filter((v) => v.id !== videoId);
    renderUpNextList();
}

function updateUrlForVideo(videoId, encodedData, replace = false) {
    if (!videoId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('v', videoId);
    const state = { ...(history.state || {}), videoId, encodedData };
    if (replace) {
        window.history.replaceState(state, '', url);
    } else {
        window.history.pushState(state, '', url);
    }
}

function handlePlaybackPopState(event) {
    const encodedData = event.state?.encodedData;
    if (!encodedData) return;
    preparePlay(encodedData, { skipHistory: true });
}

async function fetchUpNextRecommendations() {
    if (!currentPlayingId) return;

    const fallback = displayResults.filter((v) => v.id !== currentPlayingId).slice(0, 12);

    if (playbackMode === 'playlist' || !currentUser) {
        upNextRecommendations = fallback;
        renderUpNextList();
        return;
    }

    try {
        const { data: currentVid } = await client
            .from('videos')
            .select('category_id, tags, channel_title')
            .eq('id', currentPlayingId)
            .single();
        if (!currentVid) throw new Error('No current video metadata');

        const tagsString = Array.isArray(currentVid.tags) ? currentVid.tags.join(' ') : String(currentVid.tags || '');
        const { data: recommendations, error } = await client.rpc('get_smart_recommendations', {
            p_user_id: currentUser.id,
            p_current_video_id: currentPlayingId,
            p_category_id: currentVid.category_id,
            p_current_tags: tagsString,
            p_channel_title: currentVid.channel_title,
            p_limit: 12
        });

        if (error) throw error;
        upNextRecommendations = (recommendations || [])
            .filter((video) => video.id !== currentPlayingId)
            .slice(0, 12);
    } catch (err) {
        console.error('טעינת הצעות נכשלה:', err);
        upNextRecommendations = [];
    }

    renderUpNextList();
}

async function loadMoreRecommendations() {
    if (!currentPlayingId || isLoadingMoreRecommendations) return;
    const list = document.getElementById('up-next-list');
    if (!list) return;

    isLoadingMoreRecommendations = true;
    const existingIds = new Set(upNextRecommendations.map((v) => v.id));
    let newItems = [];

    try {
        if (playbackMode === 'playlist' || !currentUser) {
            newItems = displayResults
                .filter((v) => v.id !== currentPlayingId && !existingIds.has(v.id))
                .slice(0, 12);
        } else {
            const { data: currentVid } = await client
                .from('videos')
                .select('category_id, tags, channel_title')
                .eq('id', currentPlayingId)
                .single();
            if (!currentVid) throw new Error('No current video metadata');

            const tagsString = Array.isArray(currentVid.tags) ? currentVid.tags.join(' ') : String(currentVid.tags || '');
            const { data: recommendations, error } = await client.rpc('get_smart_recommendations', {
                p_user_id: currentUser.id,
                p_current_video_id: currentPlayingId,
                p_category_id: currentVid.category_id,
                p_current_tags: tagsString,
                p_channel_title: currentVid.channel_title,
                p_limit: upNextRecommendations.length + 12
            });
            if (error) throw error;
            newItems = (recommendations || []).filter((v) => !existingIds.has(v.id)).slice(0, 12);
        }
    } catch (err) {
        console.error('טעינת המלצות נוספות נכשלה:', err);
    } finally {
        isLoadingMoreRecommendations = false;
    }

    if (!newItems.length) return;
    upNextRecommendations.push(...newItems);
    const startIndex = upNextRecommendations.length - newItems.length;
    const html = newItems.map((video, idx) => buildUpNextItemHtml(video, startIndex + idx)).join('');
    list.insertAdjacentHTML('beforeend', html);
}

function initPlayerInteractions() {
    const overlay = document.getElementById('player-overlay');
    const player = document.getElementById('floating-player');
    const upNextList = document.getElementById('up-next-list');
    const content = document.querySelector('.content');

    if (overlay) {
        overlay.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (currentPlayingId) setPlayerMode(true);
        });
        overlay.addEventListener('wheel', (event) => {
            if (event.deltaY > 0 && currentPlayingId) {
                event.preventDefault();
                event.stopPropagation();
                setPlayerMode(true);
            }
        }, { passive: false });
    }

    if (player) {
        player.addEventListener('wheel', (event) => {
            if (isMiniPlayerMode && event.deltaY > 0) {
                event.preventDefault();
                setPlayerMode(false);
            }
        }, { passive: false });
    }

    if (content) {
        content.addEventListener('scroll', () => {
            if (isMiniPlayerMode) updateMiniPlayerPosition();
        }, { passive: true });
    }

    window.addEventListener('resize', () => {
        if (isMiniPlayerMode) updateMiniPlayerPosition();
    });

    if (upNextList) {
        upNextList.addEventListener('wheel', (event) => {
            event.stopPropagation();
        }, { passive: true });

        upNextList.addEventListener('scroll', () => {
            const nearBottom = upNextList.scrollTop + upNextList.clientHeight >= upNextList.scrollHeight - 50;
            if (nearBottom) loadMoreRecommendations();
        }, { passive: true });
    }
}

async function preparePlay(encodedData, options = {}) {
    window.autoPlayTriggered = false;
    if (typeof safetyTimer !== 'undefined') clearTimeout(safetyTimer); 
    
    try {
        const data = JSON.parse(decodeURIComponent(atob(encodedData)));
        if (options.source === 'history-nav') {
            if (typeof options.historyCursor === 'number') {
                playbackHistoryCursor = options.historyCursor;
            } else {
                playbackHistoryCursor = playbackHistoryEncoded.lastIndexOf(encodedData);
            }
        } else {
            if (playbackHistoryCursor < playbackHistoryEncoded.length - 1) {
                playbackHistoryEncoded = playbackHistoryEncoded.slice(0, playbackHistoryCursor + 1);
            }
            if (!playbackHistoryEncoded.length || playbackHistoryEncoded[playbackHistoryEncoded.length - 1] !== encodedData) {
                playbackHistoryEncoded.push(encodedData);
            }
            playbackHistoryCursor = playbackHistoryEncoded.length - 1;
        }
        lastPlayedEncodedData = encodedData;
        currentPlayingId = data.id; 
        playbackSessionToken += 1;
        activeQueue = playbackMode === 'playlist' && pinnedSearchResults ? [...pinnedSearchResults] : [...displayResults];
        if (!options.skipHistory) {
            updateUrlForVideo(data.id, encodedData);
        }
        saveAppState();
        updatePlayerBarFavoriteButton(currentPlayingId);
        updateLikeButtonState(currentPlayingId);
        schedulePlaybackEngagement(currentPlayingId, playbackSessionToken);

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
        
        if (!playerWin) return;

        playerWin.style.display = 'flex'; 
        setPlayerMode(false);

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
        } else if (!youtubePlayerBootstrapped) {
            youtubePlayerBootstrapped = true;
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
                        if (pendingSeekTime !== null && pendingSeekTime > 0) {
                            event.target.seekTo(pendingSeekTime, true);
                            pendingSeekTime = null;
                        }
                    },
                    'onStateChange': async (event) => {
                        if (event.data === YT.PlayerState.PLAYING) {
                            isPlaying = true;
                            if (pendingSeekTime !== null && pendingSeekTime > 0 && ytPlayer && typeof ytPlayer.seekTo === 'function') {
                                ytPlayer.seekTo(pendingSeekTime, true);
                                pendingSeekTime = null;
                            }
                            updatePlayStatus(true);
                            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = "playing";
                        } else if (event.data === YT.PlayerState.PAUSED) {
                            isPlaying = false;
                            saveLastPlaybackTime();
                            updatePlayStatus(false);
                            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = "paused";
                        } else if (event.data === YT.PlayerState.ENDED) {
                            saveLastPlaybackTime();
                            console.log("הסרטון הסתיים, מעביר אוטומטית לסרטון הבא בתור ההמלצות...");
                            if (upNextRecommendations.length && upNextRecommendations[0].id === currentPlayingId) {
                                upNextRecommendations.shift();
                            }
                            while (upNextRecommendations.length && isRecentlyWatched(upNextRecommendations[0].id)) {
                                upNextRecommendations.shift();
                            }
                            const nextVid = upNextRecommendations[0];
                            if (nextVid) {
                                const videoData = {
                                    id: nextVid.id,
                                    t: nextVid.title,
                                    c: nextVid.channel_title,
                                    cat: categoryMap[nextVid.category_id] || "כללי",
                                    v: getVideoViews(nextVid),
                                    l: getVideoLikes(nextVid)
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
        } else {
            console.warn('Player requested before YT instance was ready; keeping active instance without remount.');
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

        const wasGridTriggered = options.source === 'grid';
        const existsInUpNextQueue = upNextRecommendations.some((video) => video.id === data.id);
        if (wasGridTriggered || !upNextRecommendations.length || !existsInUpNextQueue) {
            upNextRecommendations = [];
            renderUpNextList();
            await fetchUpNextRecommendations();
        } else {
            renderUpNextList();
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
    p_limit: 20 
});

        if (rpcError) {
            console.error("RPC Error details:", rpcError);
            throw rpcError;
        }

        // בדיקה אם חזרה תוצאה
        if (recommendations && recommendations.length > 0) {
            const rec = recommendations.find((item) => !isRecentlyWatched(item.id));
            if (!rec) {
                console.log("Smart Recommendation: all recommendations were watched in the last 3 days.");
                return null;
            }
            console.log("Smart Recommendation found:", rec.title);
            
            // אנחנו מוודאים שהאובייקט כולל את כל השדות שה-preparePlay צריך
            return {
                id: rec.id,
                title: rec.title,
                channel_title: rec.channel_title,
                thumbnail: rec.thumbnail,
                duration: rec.duration,
                views_count: getVideoViews(rec),
                likes_count: getVideoLikes(rec),
                views: getVideoViews(rec),
                likes: getVideoLikes(rec),
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
    if (playbackMode === 'smart') {
        potentialNextVideos = potentialNextVideos.filter((video) => !isRecentlyWatched(video.id));
    }

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
        v: getVideoViews(nextVid),
        l: getVideoLikes(nextVid)
    };
    
    const encoded = btoa(encodeURIComponent(JSON.stringify(videoData)));
    preparePlay(encoded);
}

function closePlayer() {
    saveLastPlaybackTime();
    const playerWin = document.getElementById('floating-player');
    const body = document.body;
    const miniSlot = document.getElementById('mini-player-slot');
    
    if (playerWin) {
        playerWin.style.display = 'none';
        playerWin.style.removeProperty('--mini-top');
        playerWin.style.removeProperty('--mini-right');
    }
    if (body) body.classList.remove('player-open');
    if (miniSlot) miniSlot.classList.remove('has-mini');
    isMiniPlayerMode = false;
    upNextRecommendations = [];
    renderUpNextList();
    
    // במקום לדרוס את ה-HTML ולהרוס את האובייקט, פשוט עוצרים אותו
    if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
        ytPlayer.stopVideo();
    }
    
    clearTimeout(safetyTimer);
    clearTimeout(playbackEngagementTimer);
    playbackSessionToken += 1;
    isPlaying = false;
    updatePlayStatus(false);
    updatePlayerBarFavoriteButton(null);
    updateLikeButtonState(null);
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
    updatePlayerBarFavoriteButton();
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
    const sidebarList = document.getElementById('favorites-list');
    if (sidebarList) {
        const disabledClass = !currentUser ? 'is-disabled' : '';
        sidebarList.innerHTML = `
            <div class="nav-link ${disabledClass}" onclick="handleSidebarAuthAction('history')" title="היסטוריית צפייה">
                <i class="fa-solid fa-clock-rotate-left"></i>
                <span class="nav-text">היסטוריית צפייה</span>
            </div>
            <div class="nav-link ${disabledClass}" onclick="handleSidebarAuthAction('favorites')" title="סרטונים שאהבתי">
                <i class="fa-solid fa-heart"></i>
                <span class="nav-text">סרטונים שאהבתי</span>
            </div>
            <div class="nav-link ${disabledClass}" onclick="handleSidebarAuthAction('recent')" title="אחרונים שנוספו למאגר">
                <i class="fa-solid fa-clock"></i>
                <span class="nav-text">אחרונים שנוספו</span>
            </div>
            <div class="nav-link ${disabledClass}" onclick="handleSidebarAuthAction('preferences')" title="העדפות">
                <i class="fa-solid fa-sliders"></i>
                <span class="nav-text">העדפות</span>
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

async function displayRecentlyAdded() {
    currentAppMode = 'recent';
    const { data } = await client
        .from('videos')
        .select('*')
        .order('added_at', { ascending: false });

    const title = document.getElementById('main-title');
    if (title) title.textContent = "אחרונים שנוספו";
    if (data) renderVideoGrid(data);
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
    const preferencesModal = document.getElementById('preferences-modal');
    if (event.target == modal) {
        closePrivacy();
    } else if (event.target == preferencesModal) {
        closePreferencesModal();
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

const searchInput = document.getElementById('globalSearch');

// אירוע הקלדה (Input) - חיפוש מיידי בכל שינוי, ללא השהיה
searchInput.addEventListener('input', (e) => {
    const query = normalizeSearchTerm(e.target.value);
    clearTimeout(analyticsTimeout);
    fetchVideos(query);
    triggerAnalytics(query);
});

// אירוע מקלדת (Keydown) - אנטר שומר על אותה התנהגות מיידית
searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const query = normalizeSearchTerm(e.target.value);
        clearTimeout(analyticsTimeout);
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
    if (playbackMode === 'playlist' && !currentUser) {
        showCustomAlert('נדרש להתחבר', 'מעבר למצב חכם זמין רק למשתמשים מחוברים.', 'התחבר עם גוגל', () => login());
        return;
    }

    playbackMode = playbackMode === 'playlist' ? 'smart' : 'playlist';
    pinnedSearchResults = playbackMode === 'playlist' ? [...displayResults] : null;
    renderSearchControls();
    renderPlayerModeToggle();
    saveAppState();

    if (currentPlayingId) {
        upNextRecommendations = [];
        renderUpNextList();
        fetchUpNextRecommendations();
        updateMediaSessionMetadata({ id: currentPlayingId, t: document.getElementById('current-title')?.textContent, c: document.getElementById('current-channel')?.textContent });
    }
}

window.applyChannelFilter = applyChannelFilter;
window.applyChannelFilterByName = applyChannelFilterByName;
window.togglePlaybackMode = togglePlaybackMode;
window.toggleCurrentPlayingFavorite = toggleCurrentPlayingFavorite;
window.openPreferencesModal = openPreferencesModal;
window.closePreferencesModal = closePreferencesModal;
window.selectTheme = selectTheme;
window.handleSidebarAuthAction = handleSidebarAuthAction;
window.scrollToSearch = scrollToSearch;
window.handleUpNextDragStart = handleUpNextDragStart;
window.handleUpNextDragOver = handleUpNextDragOver;
window.handleUpNextDrop = handleUpNextDrop;
window.handleUpNextDragEnd = handleUpNextDragEnd;
window.addVideoToUpNextFromGrid = addVideoToUpNextFromGrid;

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
                v: getVideoViews(nextVid),
                l: getVideoLikes(nextVid)
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
renderPlayerModeToggle();
init();

window.addEventListener('unload', () => {
    stopPlaybackTracking();
});
