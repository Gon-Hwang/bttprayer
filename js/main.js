// 전역 변수
let currentPrayers = [];
let currentTestimonies = [];
let currentNotices = [];
let currentGalleryPosts = [];
let currentMembers = [];
let currentUser = null;
let currentLanguage = 'ko'; // 기본 언어: 한글
let deferredInstallPrompt = null;
let selectedGalleryUploadFile = null;
const GALLERY_LOCAL_STORAGE_KEY = 'galleryPostsLocal';
const GALLERY_LAYOUT_STORAGE_KEY = 'galleryLayoutColumns';
const PWA_INSTALLED_STORAGE_KEY = 'pwaInstalled';
let installModalResolver = null;
let isGalleryRemoteAvailable = true;
let confirmModalResolver = null;
const testimonyLikeInFlight = new Set();
const prayerClickInFlight = new Set();
let galleryLayoutColumns = 1;

// iOS PWA standalone 모드에서 confirm()이 차단되는 문제를 우회하는 커스텀 confirm
function showConfirm(message) {
    const modal = document.getElementById('confirmModal');
    if (!modal) return Promise.resolve(window.confirm(message));
    return new Promise((resolve) => {
        const isDestructive = /삭제|remove|delete/i.test(message || '');
        const titleEl = document.getElementById('confirmModalTitle');
        const messageEl = document.getElementById('confirmModalMessage');
        const iconEl = document.getElementById('confirmModalIcon');
        const okBtn = document.getElementById('confirmModalOkBtn');
        if (titleEl) titleEl.textContent = isDestructive ? '삭제 확인' : '확인';
        if (messageEl) messageEl.textContent = message;
        if (iconEl) {
            iconEl.classList.toggle('destructive', isDestructive);
            iconEl.innerHTML = `<i class="fas ${isDestructive ? 'fa-triangle-exclamation' : 'fa-circle-question'}"></i>`;
        }
        if (okBtn) {
            okBtn.classList.toggle('destructive', isDestructive);
            okBtn.textContent = isDestructive ? '삭제' : '확인';
        }
        modal.style.display = 'flex';
        if (confirmModalResolver) confirmModalResolver(false);
        confirmModalResolver = resolve;
    });
}

function closeConfirmModal(result) {
    const modal = document.getElementById('confirmModal');
    if (modal) modal.style.display = 'none';
    if (confirmModalResolver) {
        confirmModalResolver(result);
        confirmModalResolver = null;
    }
}

const CURRENT_HOST = window.location.hostname;
const IS_LOCAL_OR_LAN = CURRENT_HOST === 'localhost' || /^(127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$/.test(CURRENT_HOST);

// 현재 배포본에서 /tables 라우트가 정적 index로 매핑되어 데이터 API가 깨질 수 있어
// API가 정상 동작하는 고정 Pages 배포 URL을 우선 사용한다.
const STABLE_API_ORIGIN = 'https://b7ddfb06.bttprayer.pages.dev/';
const API_BASE_URL = CURRENT_HOST === 'b7ddfb06.bttprayer.pages.dev' ? '' : STABLE_API_ORIGIN;

// 상대 경로(tables/...) 요청을 환경에 맞는 절대 경로로 변환
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('tables/')) {
        // 로컬에서는 실수로 운영 데이터를 수정하지 않도록 쓰기 요청을 기본 차단
        const method = (init && init.method ? init.method : 'GET').toUpperCase();
        const isPrayerToggleEndpoint =
            (method === 'PATCH' || method === 'PUT') && /^tables\/prayers\/[^/?#]+$/.test(input);
        const isTestimonyLikeEndpoint =
            (method === 'PATCH' || method === 'PUT') && /^tables\/testimonies\/[^/?#]+$/.test(input);
        const isGalleryEndpoint =
            /^tables\/gallery_posts(?:\/[^/?#]+)?$/.test(input) && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE');
        const isNoticeEndpoint =
            /^tables\/notices(?:\/[^/?#]+)?$/.test(input) && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE');
        const isPrayerTestimonyPostOrDelete =
            (method === 'POST' && /^(tables\/prayers|tables\/testimonies)$/.test(input)) ||
            (method === 'DELETE' && /^tables\/(prayers|testimonies)\/[^/?#]+$/.test(input));

        // 로컬/LAN에서만 쓰기 요청 기본 차단 (실수로 운영 데이터 변경 방지)
        if (IS_LOCAL_OR_LAN && API_BASE_URL && method !== 'GET' && !isPrayerToggleEndpoint && !isTestimonyLikeEndpoint && !isGalleryEndpoint && !isNoticeEndpoint && !isPrayerTestimonyPostOrDelete) {
            console.warn('[LOCAL SAFETY] 로컬 환경에서 쓰기 요청이 차단되었습니다:', method, input);
            return Promise.reject(new Error('로컬 안전모드: 운영 데이터 쓰기 요청이 차단되었습니다.'));
        }
        input = `${API_BASE_URL}${input}`;
    }
    return nativeFetch(input, init);
};

// 번역 캐시 (성능 최적화)
let translationCache = {};

function getCurrentUserKey() {
    if (!currentUser) return '';
    return (currentUser.email || currentUser.id || currentUser.name || '').toLowerCase().trim();
}

function getUserActionList(storageKey, userKey) {
    if (!userKey) return [];
    const all = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return Array.isArray(all[userKey]) ? all[userKey] : [];
}

function saveUserActionList(storageKey, userKey, list) {
    if (!userKey) return;
    const all = JSON.parse(localStorage.getItem(storageKey) || '{}');
    all[userKey] = list;
    localStorage.setItem(storageKey, JSON.stringify(all));
}

// 실시간 자동 번역 함수 (MyMemory Translation API 사용)
async function translateText(text, targetLang) {
    if (!text || targetLang === 'ko') return text;
    
    // 캐시 확인
    const cacheKey = `${text}_${targetLang}`;
    if (translationCache[cacheKey]) {
        return translationCache[cacheKey];
    }
    
    try {
        // MyMemory Translation API (무료, 제한: 하루 1000회)
        const response = await fetch(
            `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=ko|${targetLang}`
        );
        
        if (!response.ok) {
            throw new Error('Translation API error');
        }
        
        const data = await response.json();
        
        if (data.responseStatus === 200 && data.responseData) {
            const translated = data.responseData.translatedText;
            translationCache[cacheKey] = translated;
            return translated;
        }
        
        // 번역 실패 시 원본 반환
        return text;
        
    } catch (error) {
        console.warn('[번역 오류]', error);
        // 오류 발생 시 원본 텍스트 반환
        return text;
    }
}

// 실제 사용 가능한 번역 함수
async function getTranslatedContent(koreanText, targetLang) {
    if (targetLang === 'ko' || !koreanText) {
        return koreanText;
    }
    
    // 영어 모드일 때 실시간 번역
    return await translateText(koreanText, 'en');
}

// 비밀번호 해싱 함수 (SHA-256 사용)
async function hashPassword(password) {
    const msgBuffer = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

// API 재시도 설정
const API_RETRY_CONFIG = {
    maxRetries: 3,
    retryDelay: 1000, // 1초
    retryDelayMultiplier: 2 // 각 재시도마다 대기 시간 2배 증가
};

// API 호출 재시도 헬퍼 함수
async function fetchWithRetry(url, options = {}, retryCount = 0) {
    try {
        console.log(`[API RETRY] 시도 ${retryCount + 1}/${API_RETRY_CONFIG.maxRetries + 1} - URL: ${url}`);
        
        const response = await fetch(url, options);
        
        // 성공적인 응답이면 바로 반환
        if (response.ok) {
            return response;
        }
        
        // 422 오류는 재시도하지 않음 (데이터 검증 오류)
        if (response.status === 422) {
            const errorText = await response.text();
            console.error('[API ERROR] 데이터 검증 오류 (422):', errorText);
            throw new Error(`데이터 검증 오류: ${errorText}`);
        }
        
        // 서버 오류 (500번대)는 재시도
        if (response.status >= 500 && retryCount < API_RETRY_CONFIG.maxRetries) {
            const delay = API_RETRY_CONFIG.retryDelay * Math.pow(API_RETRY_CONFIG.retryDelayMultiplier, retryCount);
            console.warn(`[API RETRY] 서버 오류 (${response.status}). ${delay}ms 후 재시도...`);
            
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithRetry(url, options, retryCount + 1);
        }
        
        // 그 외 오류는 바로 throw
        const errorText = await response.text();
        throw new Error(`서버 오류 (${response.status}): ${errorText}`);
        
    } catch (error) {
        // 네트워크 오류인 경우 재시도
        if (error.name === 'TypeError' && retryCount < API_RETRY_CONFIG.maxRetries) {
            const delay = API_RETRY_CONFIG.retryDelay * Math.pow(API_RETRY_CONFIG.retryDelayMultiplier, retryCount);
            console.warn(`[API RETRY] 네트워크 오류. ${delay}ms 후 재시도...`, error);
            
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithRetry(url, options, retryCount + 1);
        }
        
        // 최종 실패
        console.error(`[API RETRY] 최종 실패 (${retryCount + 1}회 시도)`, error);
        throw error;
    }
}

// 다국어 텍스트 데이터
const translations = {
    ko: {
        // 로고
        logo_title: '보좌 앞에서',
        
        // 네비게이션
        nav_home: '홈',
        nav_about: '소개',
        nav_schedule: '모임일정',
        nav_register: '회원가입',
        nav_login: '로그인',
        nav_prayers: '기도제목',
        nav_testimonies: '간증',
        nav_gallery: '사진겔러리',
        nav_notices: '공지사항',
        nav_admin: '관리자',
        
        // 히어로 섹션
        hero_subtitle: '하나님을 사랑하는',
        hero_title: '보좌 앞에서',
        hero_verse: '"그러므로 그들이 하나님의 보좌 앞에 있고 또 그의 성전에서 밤낮 하나님을 섬기매 보좌에 앉으신 이가 그들 위에 장막을 치시리니" - 요한계시록 7:15',
        hero_cta: '기도 제목 올리기',
        
        // 소개 섹션
        about_title: '모임 소개',
        about_card1_title: '함께 기도해요',
        about_card1_desc: '매주 한 번, 우리는 함께 모여 서로를 위해, 가족을 위해, 이웃을 위해 기도합니다.',
        about_card2_title: '서로 격려해요',
        about_card2_desc: '기도 응답의 간증을 나누며 서로의 믿음을 격려하고 하나님의 살아계심을 경험합니다.',
        about_card3_title: '말씀 안에서',
        about_card3_desc: '하나님의 말씀을 묵상하고 나누며 영적으로 성장하는 시간을 가집니다.',
        
        // 모임 일정
        schedule_title: '모임 일정',
        schedule_korea_title: '한국 오프라인 모임',
        schedule_korea_regular: '정기 모임',
        schedule_korea_regular_time: '매주 월요일 오전 10시 (한국시간)',
        schedule_korea_time: '모임 시간',
        schedule_korea_time_detail: '약 1시간 30분 (오전 10:00 - 11:30)',
        schedule_korea_location: '모임 장소',
        schedule_korea_location_detail: '오프라인 (회원가입 시 공지)',
        schedule_global_title: '글로벌 온라인 모임',
        schedule_global_regular: '정기 모임',
        schedule_global_regular_time: '매주 토요일 밤 10시 (한국시간, KST)',
        schedule_global_time: '모임 시간',
        schedule_global_time_detail: '약 1시간 30분 (밤 10:00 - 11:30)',
        schedule_global_method: '모임 방식',
        schedule_global_method_detail: '온라인 화상회의 (링크는 회원가입 시 공지)',
        
        // 로그인
        login_title: '로그인',
        login_intro1: '회원가입 시 등록한 이메일로 로그인하세요 🔐',
        login_intro2: '로그인 후 기도제목, 간증, 공지사항을 확인하실 수 있습니다.',
        login_email: '이메일',
        login_button: '로그인',
        login_footer: '아직 회원이 아니신가요?',
        login_signup: '회원가입하기',
        
        // 회원가입
        register_title: '회원가입',
        register_intro1: '보좌 앞에서 기도 모임에 오신 것을 환영합니다! 🙏',
        register_intro2: '회원가입 후 모임 장소와 자세한 정보를 안내해 드립니다.',
        register_form_title: '회원 정보 입력',
        register_name: '이름 (실명)',
        register_gender: '성별',
        register_male: '남성',
        register_female: '여성',
        register_phone: '전화번호',
        register_email: '이메일',
        register_church: '출석교회',
        register_button: '가입 신청하기',
        register_footer: '이미 회원이신가요?',
        register_login: '로그인하기',
        register_member_list: '회원 목록',
        
        // 기도 제목
        prayers_title: '기도 제목',
        prayers_form_title: '새로운 기도 제목',
        prayers_name: '이름 (선택사항)',
        prayers_title_field: '제목',
        prayers_content: '기도 제목 내용을 입력하세요...',
        prayers_anonymous: '익명으로 올리기',
        prayers_submit: '기도 제목 등록',
        prayers_count: '명 기도',
        prayers_button: '기도했어요',
        prayers_loading: '기도 제목을 불러오는 중...',
        prayers_empty: '아직 등록된 기도 제목이 없습니다. 첫 번째 기도 제목을 올려주세요!',
        
        // 간증
        testimonies_title: '기도 응답 간증',
        testimonies_form_title: '간증 나누기',
        testimonies_content: '하나님께서 응답하신 간증을 나눠주세요...',
        testimonies_submit: '간증 등록',
        testimonies_button: '할렐루야',
        testimonies_loading: '간증을 불러오는 중...',
        testimonies_empty: '아직 등록된 간증이 없습니다. 하나님의 응답하신 간증을 나눠주세요!',

        // 사역 사진 갤러리
        gallery_title: '사진겔러리',
        gallery_form_title: '사진 올리기',
        gallery_upload_label: '사진 업로드 (1장)',
        gallery_description_label: '설명',
        gallery_description_placeholder: '사역 활동 사진 설명을 입력하세요...',
        gallery_submit: '갤러리 등록',
        gallery_limit_note: '한 번에 1장만 업로드할 수 있습니다.',
        gallery_save_success: '사진이 저장되었습니다.',
        gallery_saved_local: '로컬 임시 저장',
        gallery_local_save_success: '사진이 저장되었습니다.',
        gallery_loading: '사진을 불러오는 중...',
        gallery_empty: '아직 등록된 사역 활동 사진이 없습니다. 첫 사진을 올려주세요!',

        // 앱 설치 안내 모달
        install_modal_offer_title: '앱 설치 안내',
        install_modal_offer_message: '앱 형태로 설치하면 PC는 바탕화면에, 모바일은 홈 화면에 보좌 앞에서 로고 아이콘 바로가기가 생성되어 바로 실행할 수 있습니다.',
        install_modal_offer_sub: '지금 설치를 선택해 아이콘 바로가기를 사용하세요.',
        install_modal_path_pc: 'PC(Chrome/Edge): 주소창의 설치 아이콘 또는 우상단 메뉴(⋮) > "앱 설치" > 바탕화면 바로가기 만들기',
        install_modal_path_mobile: '모바일: 브라우저 메뉴에서 "홈 화면에 추가"',
        install_modal_install_now: '지금 설치',
        install_modal_later: '나중에',
        install_modal_done_title: '설치 요청 완료',
        install_modal_done_message: '설치가 완료되면 홈 화면(또는 바탕화면)에 앱 아이콘이 생성됩니다.',
        install_modal_done_sub: '아이콘이 바로 안 보이면 아래 수동 설치 방법을 확인해주세요.',
        install_modal_manual_title: '수동 설치 방법',
        install_modal_manual_ios: 'iPhone/iPad: 공유 버튼 -> "홈 화면에 추가"',
        install_modal_manual_android: 'Android/PC: 브라우저 메뉴(⋮) -> "홈 화면에 추가" 또는 "앱 설치"',
        install_modal_ok: '확인',
        
        // 공지사항
        notices_title: '공지사항',
        notices_form_title: '새로운 공지사항 작성',
        notices_title_field: '제목',
        notices_content: '공지사항 내용을 입력하세요...',
        notices_important: '중요 공지로 표시',
        notices_submit: '공지사항 등록',
        notices_edit_title: '공지사항 수정',
        notices_edit_submit: '수정 완료',
        notices_badge: '중요',
        notices_loading: '공지사항을 불러오는 중...',
        notices_empty: '아직 등록된 공지사항이 없습니다.',
        
        // 관리자
        admin_title: '🙏 기도인도자 · 관리자 페이지',
        admin_welcome: '최지연 권사님(기도인도자), 환영합니다!',
        admin_intro: '회원 정보 관리 및 공지사항 작성 권한이 있습니다.',
        admin_member_info: '📋 전체 회원 정보',
        admin_total_members: '전체 회원',
        admin_total_prayers: '기도 제목',
        admin_total_testimonies: '간증',
        admin_total_notices: '공지사항',
        admin_data_backup: '💾 데이터 백업 및 복원',
        admin_data_description: '모든 데이터를 JSON 파일로 백업하거나 복원할 수 있습니다.',
        admin_export_title: '📤 데이터 내보내기 (백업)',
        admin_export_all: '전체 데이터 내보내기',
        admin_export_members: '회원 데이터만',
        admin_export_prayers: '기도 제목만',
        admin_export_testimonies: '간증만',
        admin_export_notices: '공지사항만',
        admin_import_title: '📥 데이터 가져오기 (복원)',
        admin_import_btn: 'JSON 파일에서 가져오기',
        admin_import_warning: '⚠️ 주의: 가져오기 시 기존 데이터가 덮어씌워질 수 있습니다.',
        
        // 버튼
        btn_submit: '등록',
        btn_edit: '수정',
        btn_delete: '삭제',
        btn_logout: '로그아웃',
        btn_login: '로그인',
        required: '*',
        
        // 메시지
        welcome: '환영합니다',
        loading: '불러오는 중...',
        anonymous: '익명',
        
        // 푸터
        footer_verse: '"쉬지 말고 기도하라" - 데살로니가전서 5:17',
        footer_copyright: '© 2026 보좌 앞에서. All rights reserved.',
    },
    en: {
        // Logo
        logo_title: 'Before<br>The Throne',
        
        // Navigation
        nav_home: 'Home',
        nav_about: 'About',
        nav_schedule: 'Schedule',
        nav_register: 'Sign Up',
        nav_login: 'Login',
        nav_prayers: 'Prayer Requests',
        nav_testimonies: 'Testimonies',
        nav_gallery: 'Photo Gallery',
        nav_notices: 'Notices',
        nav_admin: 'Admin',
        
        // Hero Section
        hero_subtitle: 'Those Who Love God',
        hero_title: 'Before The Throne',
        hero_verse: '"Therefore they are before the throne of God, and serve him day and night in his temple; and he who sits on the throne will shelter them with his presence." - Revelation 7:15',
        hero_cta: 'Share Prayer Request',
        
        // About Section
        about_title: 'About Us',
        about_card1_title: 'Pray Together',
        about_card1_desc: 'Every week, we gather together to pray for each other, our families, and our neighbors.',
        about_card2_title: 'Encourage One Another',
        about_card2_desc: 'We share testimonies of answered prayers, encouraging each other\'s faith and experiencing God\'s living presence.',
        about_card3_title: 'In The Word',
        about_card3_desc: 'We meditate and share God\'s Word, growing spiritually together.',
        
        // Schedule
        schedule_title: 'Meeting Schedule',
        schedule_korea_title: 'Korea Offline Meeting',
        schedule_korea_regular: 'Regular Meeting',
        schedule_korea_regular_time: 'Every Monday 10:00 AM (KST)',
        schedule_korea_time: 'Meeting Time',
        schedule_korea_time_detail: 'About 1 hour 30 minutes (10:00 - 11:30)',
        schedule_korea_location: 'Location',
        schedule_korea_location_detail: 'Offline (Announced after registration)',
        schedule_global_title: 'Global Online Meeting',
        schedule_global_regular: 'Regular Meeting',
        schedule_global_regular_time: 'Every Saturday 10:00 PM (KST)',
        schedule_global_time: 'Meeting Time',
        schedule_global_time_detail: 'About 1 hour 30 minutes (22:00 - 23:30)',
        schedule_global_method: 'Method',
        schedule_global_method_detail: 'Online Video Conference (Link provided after registration)',
        
        // Login
        login_title: 'Login',
        login_intro1: 'Login with your registered email 🔐',
        login_intro2: 'After login, you can access prayer requests, testimonies, and notices.',
        login_email: 'Email',
        login_button: 'Login',
        login_footer: 'Not a member yet?',
        login_signup: 'Sign Up',
        
        // Register
        register_title: 'Sign Up',
        register_intro1: 'Welcome to Before The Throne prayer meeting! 🙏',
        register_intro2: 'After registration, we will provide detailed information about the meeting.',
        register_form_title: 'Member Information',
        register_name: 'Name (Real Name)',
        register_gender: 'Gender',
        register_male: 'Male',
        register_female: 'Female',
        register_phone: 'Phone',
        register_email: 'Email',
        register_church: 'Church',
        register_button: 'Sign Up',
        register_footer: 'Already a member?',
        register_login: 'Login',
        register_member_list: 'Member List',
        
        // Prayers
        prayers_title: 'Prayer Requests',
        prayers_form_title: 'New Prayer Request',
        prayers_name: 'Name (Optional)',
        prayers_title_field: 'Title',
        prayers_content: 'Enter your prayer request...',
        prayers_anonymous: 'Post anonymously',
        prayers_submit: 'Submit Prayer',
        prayers_count: 'prayers',
        prayers_button: 'Prayed',
        prayers_loading: 'Loading prayer requests...',
        prayers_empty: 'No prayer requests yet. Be the first to share!',
        
        // Testimonies
        testimonies_title: 'Testimonies',
        testimonies_form_title: 'Share Testimony',
        testimonies_content: 'Share how God answered your prayer...',
        testimonies_submit: 'Submit Testimony',
        testimonies_button: 'Hallelujah',
        testimonies_loading: 'Loading testimonies...',
        testimonies_empty: 'No testimonies yet. Share God\'s answered prayers!',

        // Ministry gallery
        gallery_title: 'Ministry Photo Gallery',
        gallery_form_title: 'Upload Photos',
        gallery_upload_label: 'Upload Photo (1)',
        gallery_description_label: 'Description',
        gallery_description_placeholder: 'Write a short description of this ministry activity...',
        gallery_submit: 'Post Gallery',
        gallery_limit_note: 'You can upload only one photo at a time.',
        gallery_save_success: 'Photo has been saved.',
        gallery_saved_local: 'Saved locally',
        gallery_local_save_success: 'Photo has been saved.',
        gallery_loading: 'Loading photos...',
        gallery_empty: 'No ministry photos yet. Share the first post!',

        // App install modal
        install_modal_offer_title: 'Install App',
        install_modal_offer_message: 'Install this as an app to create a Before The Throne icon shortcut on desktop (PC) or home screen (mobile) for quick launch.',
        install_modal_offer_sub: 'Choose Install now to use the icon shortcut.',
        install_modal_path_pc: 'PC (Chrome/Edge): Address bar install icon or menu (⋮) > "Install app" > create desktop shortcut',
        install_modal_path_mobile: 'Mobile: Use browser menu > "Add to Home screen"',
        install_modal_install_now: 'Install now',
        install_modal_later: 'Later',
        install_modal_done_title: 'Install Request Sent',
        install_modal_done_message: 'Once installation finishes, an app icon appears on your home/desktop screen.',
        install_modal_done_sub: 'If the icon does not appear immediately, use manual install steps below.',
        install_modal_manual_title: 'Manual Install Steps',
        install_modal_manual_ios: 'iPhone/iPad: Share button -> "Add to Home Screen"',
        install_modal_manual_android: 'Android/PC: Browser menu (⋮) -> "Add to Home screen" or "Install app"',
        install_modal_ok: 'OK',
        
        // Notices
        notices_title: 'Notices',
        notices_form_title: 'New Notice',
        notices_title_field: 'Title',
        notices_content: 'Enter notice content...',
        notices_important: 'Mark as important',
        notices_submit: 'Post Notice',
        notices_edit_title: 'Edit Notice',
        notices_edit_submit: 'Save Changes',
        notices_badge: 'Important',
        notices_loading: 'Loading notices...',
        notices_empty: 'No notices yet.',
        
        // Admin
        admin_title: '🙏 Prayer Leader · Admin Page',
        admin_welcome: 'Welcome, Choi Ji-Yeon (Prayer Leader)!',
        admin_intro: 'You have permission to manage member information and post notices.',
        admin_member_info: '📋 All Members',
        admin_total_members: 'Total Members',
        admin_total_prayers: 'Prayer Requests',
        admin_total_testimonies: 'Testimonies',
        admin_total_notices: 'Notices',
        admin_data_backup: '💾 Data Backup & Restore',
        admin_data_description: 'You can backup or restore all data as JSON files.',
        admin_export_title: '📤 Export Data (Backup)',
        admin_export_all: 'Export All Data',
        admin_export_members: 'Members Only',
        admin_export_prayers: 'Prayers Only',
        admin_export_testimonies: 'Testimonies Only',
        admin_export_notices: 'Notices Only',
        admin_import_title: '📥 Import Data (Restore)',
        admin_import_btn: 'Import from JSON File',
        admin_import_warning: '⚠️ Warning: Importing may overwrite existing data.',
        
        // Buttons
        btn_submit: 'Submit',
        btn_edit: 'Edit',
        btn_delete: 'Delete',
        btn_logout: 'Logout',
        btn_login: 'Login',
        required: '*',
        
        // Messages
        welcome: 'Welcome',
        loading: 'Loading...',
        anonymous: 'Anonymous',
        
        // Footer
        footer_verse: '"Pray without ceasing." - 1 Thessalonians 5:17',
        footer_copyright: '© 2026 Before The Throne. All rights reserved.',
    }
};

// 페이지 로드 시 실행
document.addEventListener('DOMContentLoaded', function() {
    setupPwaInstallPrompt();
    registerServiceWorker();
    loadLanguagePreference();
    checkLoginStatus();
    initializeApp();
    setupEventListeners();
    initializeGalleryLayoutControls();
    setupScrollButton();
    setupMobileMenu();
});

function setupPwaInstallPrompt() {
    updateInstallAppButton();

    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        updateInstallAppButton();
    });

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        markPwaInstalled();
        updateInstallAppButton();
        showToast(currentLanguage === 'ko' ? '앱 설치가 완료되었습니다.' : 'App installation completed.');
    });
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js').catch((error) => {
                console.warn('[PWA] 서비스워커 등록 실패:', error);
            });
        });
    }
}

function isStandaloneMode() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function markPwaInstalled() {
    localStorage.setItem(PWA_INSTALLED_STORAGE_KEY, 'true');
}

function isPwaInstalled() {
    return localStorage.getItem(PWA_INSTALLED_STORAGE_KEY) === 'true';
}

function isIosDevice() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

function updateInstallAppButton() {
    const installBtn = document.getElementById('installAppBtn');
    if (!installBtn) return;
    const show = !isStandaloneMode();
    installBtn.style.display = show ? 'inline-flex' : 'none';
}

window.triggerAppInstall = async function triggerAppInstall() {
    if (isStandaloneMode()) {
        markPwaInstalled();
        updateInstallAppButton();
        showToast(currentLanguage === 'ko' ? '이미 앱으로 설치되어 있습니다.' : 'Already installed as an app.');
        return;
    }

    if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        try {
            const choice = await deferredInstallPrompt.userChoice;
            if (choice && choice.outcome === 'accepted') {
                markPwaInstalled();
            }
        } catch (error) {
            console.warn('[PWA] 설치 프롬프트 처리 오류:', error);
        }
        deferredInstallPrompt = null;
        updateInstallAppButton();
        return;
    }

    if (isIosDevice()) {
        showToast(currentLanguage === 'ko'
            ? 'Safari 공유 버튼에서 "홈 화면에 추가"를 선택해주세요.'
            : 'Please use Safari Share > "Add to Home Screen".');
        return;
    }

    showToast(currentLanguage === 'ko'
        ? '브라우저 메뉴에서 "앱 설치" 또는 "홈 화면에 추가"를 선택해주세요.'
        : 'Please choose "Install app" or "Add to Home Screen" in your browser menu.');
};

function openInstallModal(config) {
    const modal = document.getElementById('installPromptModal');
    const titleEl = document.getElementById('installPromptTitle');
    const messageEl = document.getElementById('installPromptMessage');
    const subMessageEl = document.getElementById('installPromptSubMessage');
    const primaryBtn = document.getElementById('installPromptPrimaryBtn');
    const secondaryBtn = document.getElementById('installPromptSecondaryBtn');
    if (!modal || !titleEl || !messageEl || !subMessageEl || !primaryBtn || !secondaryBtn) {
        return Promise.resolve('secondary');
    }

    titleEl.textContent = config.title || '';
    messageEl.textContent = config.message || '';
    subMessageEl.textContent = config.subMessage || '';

    primaryBtn.textContent = config.primaryLabel || translations[currentLanguage].install_modal_ok;
    secondaryBtn.textContent = config.secondaryLabel || translations[currentLanguage].install_modal_later;
    secondaryBtn.style.display = config.showSecondary ? 'inline-flex' : 'none';

    if (installModalResolver) {
        installModalResolver('secondary');
        installModalResolver = null;
    }
    modal.style.display = 'flex';

    return new Promise((resolve) => {
        installModalResolver = resolve;
    });
}

function closeInstallModal(action) {
    const modal = document.getElementById('installPromptModal');
    if (modal) modal.style.display = 'none';
    if (installModalResolver) {
        installModalResolver(action);
        installModalResolver = null;
    }
}

function normalizeEmail(value) {
    return (value || '').toLowerCase().trim();
}

function normalizeName(value) {
    return (value || '').trim();
}

function isAnonymousName(name) {
    return /^(익명|anonymous)$/i.test(normalizeName(name));
}

function getInstallPathMessage() {
    const isMobile = /android|iphone|ipad|ipod/i.test(window.navigator.userAgent);
    const t = translations[currentLanguage];
    return isMobile ? t.install_modal_path_mobile : t.install_modal_path_pc;
}

function canDeleteAuthoredPost(post) {
    if (!currentUser || !post) return false;
    if (isUserAdmin(currentUser)) return true;

    const currentEmail = normalizeEmail(currentUser.email);
    const postEmailCandidates = [
        post.authorEmail,
        post.author_email,
        post.email,
        post.user_email,
        post.createdByEmail,
        post.created_by_email,
        post.userEmail,
        post.writerEmail,
        post.memberEmail
    ].map(normalizeEmail).filter(Boolean);
    if (currentEmail && postEmailCandidates.includes(currentEmail)) return true;

    // 익명 글은 이름 비교만으로 삭제 권한을 허용하지 않는다.
    if (post.isAnonymous) return false;

    const currentName = normalizeName(currentUser.name);
    const postNameCandidates = [
        post.authorName,
        post.author_name,
        post.name,
        post.user_name,
        post.createdByName,
        post.created_by_name,
        post.userName,
        post.writerName,
        post.memberName
    ].map(normalizeName).filter(Boolean);
    return !!currentName && postNameCandidates.some((name) => !isAnonymousName(name) && name === currentName);
}

function canDeletePrayerPost(prayer) {
    return canDeleteAuthoredPost(prayer);
}

function canDeleteTestimonyPost(testimony) {
    return canDeleteAuthoredPost(testimony);
}

async function showInstallGuideAfterLogin() {
    // 앱 설치 안내 기능 비활성화
    return;
}

// 언어 설정 불러오기
function loadLanguagePreference() {
    const savedLang = localStorage.getItem('preferredLanguage') || 'ko';
    currentLanguage = savedLang;
    document.body.setAttribute('data-lang', savedLang); // body에 언어 속성 추가
    applyLanguage(savedLang);
}

// 언어 전환 함수
function switchLanguage(lang) {
    currentLanguage = lang;
    localStorage.setItem('preferredLanguage', lang);
    applyLanguage(lang);
    
    // body에 언어 속성 추가 (CSS에서 활용)
    document.body.setAttribute('data-lang', lang);
    
    // 버튼 상태 업데이트
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.lang === lang) {
            btn.classList.add('active');
        }
    });
    
    showToast(lang === 'ko' ? '한글로 변경되었습니다 🇰🇷' : 'Changed to English 🇺🇸');
}

// 언어 적용 함수
function applyLanguage(lang) {
    const t = translations[lang];
    
    // 로고
    updateTextContent('logoTitle', t.logo_title);
    
    // 네비게이션 메뉴
    updateTextContent('navHome', t.nav_home);
    updateTextContent('navAbout', t.nav_about);
    updateTextContent('navSchedule', t.nav_schedule);
    updateTextContent('navRegister', t.nav_register);
    updateTextContent('navLogin', t.nav_login);
    updateTextContent('navPrayers', t.nav_prayers);
    updateTextContent('navTestimonies', t.nav_testimonies);
    updateTextContent('navGallery', t.nav_gallery);
    updateTextContent('navNotices', t.nav_notices);
    updateTextContent('navAdmin', t.nav_admin);
    
    // 히어로 섹션
    updateTextContent('heroSubtitle', t.hero_subtitle);
    updateTextContent('heroTitle', t.hero_title);
    updateTextContent('heroVerse', t.hero_verse);
    updateTextContent('heroCTA', t.hero_cta);
    
    // 소개 섹션
    const aboutTitle = document.querySelector('#about .section-title');
    if (aboutTitle) aboutTitle.textContent = t.about_title;
    
    const aboutCards = document.querySelectorAll('.about-card');
    if (aboutCards.length >= 3) {
        aboutCards[0].querySelector('h3').textContent = t.about_card1_title;
        aboutCards[0].querySelector('p').textContent = t.about_card1_desc;
        aboutCards[1].querySelector('h3').textContent = t.about_card2_title;
        aboutCards[1].querySelector('p').textContent = t.about_card2_desc;
        aboutCards[2].querySelector('h3').textContent = t.about_card3_title;
        aboutCards[2].querySelector('p').textContent = t.about_card3_desc;
    }
    
    // 사용자 정보 텍스트 업데이트
    if (currentUser) {
        document.querySelectorAll('.welcome-text').forEach((welcomeText) => {
            if (lang === 'en') {
                welcomeText.innerHTML = `${t.welcome}, <strong>${currentUser.name}</strong>`;
            } else {
                welcomeText.innerHTML = `${t.welcome}, <strong>${currentUser.name}</strong>님`;
            }
        });
    }
    
    // 로그아웃 버튼
    document.querySelectorAll('.logout-btn').forEach((logoutBtn) => {
        logoutBtn.textContent = t.btn_logout;
    });
    
    // 섹션 타이틀들
    const scheduleTitle = document.querySelector('#schedule .section-title');
    const loginTitle = document.querySelector('#login .section-title');
    const registerTitle = document.querySelector('#register .section-title');
    const prayersTitle = document.querySelector('#prayers .section-title');
    const testimoniesTitle = document.querySelector('#testimonies .section-title');
    const galleryTitle = document.querySelector('#gallery .section-title');
    const noticesTitle = document.querySelector('#notices .section-title');
    const adminTitle = document.querySelector('#admin .section-title');
    
    if (scheduleTitle) scheduleTitle.textContent = t.schedule_title;
    if (loginTitle) loginTitle.textContent = t.login_title;
    if (registerTitle) registerTitle.textContent = t.register_title;
    if (prayersTitle) prayersTitle.textContent = t.prayers_title;
    if (testimoniesTitle) testimoniesTitle.textContent = t.testimonies_title;
    if (galleryTitle) galleryTitle.textContent = t.gallery_title;
    if (noticesTitle) noticesTitle.textContent = t.notices_title;
    if (adminTitle) adminTitle.textContent = t.admin_title;
    
    // 기도 제목 폼 번역
    updateTextContent('prayerFormTitle', t.prayers_form_title);
    updateTextContent('prayerAnonymousLabel', t.prayers_anonymous);
    updateTextContent('prayerSubmitBtn', t.prayers_submit);
    
    const prayerNameInput = document.getElementById('prayerName');
    const prayerTitleInput = document.getElementById('prayerTitle');
    const prayerContentInput = document.getElementById('prayerContent');
    if (prayerNameInput) prayerNameInput.placeholder = t.prayers_name;
    if (prayerTitleInput) prayerTitleInput.placeholder = t.prayers_title_field;
    if (prayerContentInput) prayerContentInput.placeholder = t.prayers_content;
    
    // 간증 폼 번역
    updateTextContent('testimonyFormTitle', t.testimonies_form_title);
    updateTextContent('testimonyAnonymousLabel', t.prayers_anonymous);
    updateTextContent('testimonySubmitBtn', t.testimonies_submit);
    
    const testimonyNameInput = document.getElementById('testimonyName');
    const testimonyTitleInput = document.getElementById('testimonyTitle');
    const testimonyContentInput = document.getElementById('testimonyContent');
    if (testimonyNameInput) testimonyNameInput.placeholder = t.prayers_name;
    if (testimonyTitleInput) testimonyTitleInput.placeholder = t.prayers_title_field;
    if (testimonyContentInput) testimonyContentInput.placeholder = t.testimonies_content;

    // 갤러리 폼 번역
    updateTextContent('galleryFormTitle', t.gallery_form_title);
    updateTextContent('galleryUploadLabel', t.gallery_upload_label + ' ');
    updateTextContent('galleryDescriptionLabel', t.gallery_description_label + ' ');
    updateTextContent('galleryLimitHelp', t.gallery_limit_note);
    updateTextContent('gallerySubmitBtn', t.gallery_submit);
    const galleryDescriptionInput = document.getElementById('galleryDescription');
    if (galleryDescriptionInput) galleryDescriptionInput.placeholder = t.gallery_description_placeholder;
    
    // 공지사항 폼 번역
    updateTextContent('noticeFormTitle', t.notices_form_title);
    updateTextContent('noticeTitleLabel', t.notices_title_field + ' ');
    updateTextContent('noticeContentLabel', t.notices_content.replace('...', '') + ' ');
    updateTextContent('noticeImportantLabel', t.notices_important);
    updateTextContent('noticeSubmitBtn', t.notices_submit);
    
    const noticeTitleInput = document.getElementById('noticeTitle');
    const noticeContentInput = document.getElementById('noticeContent');
    if (noticeTitleInput) noticeTitleInput.placeholder = t.notices_title_field;
    if (noticeContentInput) noticeContentInput.placeholder = t.notices_content;
    
    // 모임 일정 상세 내용
    updateTextContent('scheduleKoreaTitle', `📍 ${t.schedule_korea_title}`);
    updateTextContent('scheduleKoreaRegular', t.schedule_korea_regular);
    updateTextContent('scheduleKoreaRegularTime', t.schedule_korea_regular_time);
    updateTextContent('scheduleKoreaTime', t.schedule_korea_time);
    updateTextContent('scheduleKoreaTimeDetail', t.schedule_korea_time_detail);
    updateTextContent('scheduleKoreaLocation', t.schedule_korea_location);
    updateTextContent('scheduleKoreaLocationDetail', t.schedule_korea_location_detail);
    updateTextContent('scheduleGlobalTitle', `🌍 ${t.schedule_global_title}`);
    updateTextContent('scheduleGlobalRegular', t.schedule_global_regular);
    updateTextContent('scheduleGlobalRegularTime', t.schedule_global_regular_time);
    updateTextContent('scheduleGlobalTime', t.schedule_global_time);
    updateTextContent('scheduleGlobalTimeDetail', t.schedule_global_time_detail);
    updateTextContent('scheduleGlobalMethod', t.schedule_global_method);
    updateTextContent('scheduleGlobalMethodDetail', t.schedule_global_method_detail);
    
    // 푸터
    const footerVerses = document.querySelectorAll('footer p');
    if (footerVerses.length >= 2) {
        footerVerses[0].textContent = t.footer_verse;
        footerVerses[1].textContent = t.footer_copyright;
    }
    
    // 일정을 다시 렌더링하여 번역 적용
    if (currentSchedule) {
        displaySchedule(currentSchedule);
    }
    
    // 데이터를 다시 렌더링하여 번역 적용
    if (currentUser) {
        renderPrayers();
        renderTestimonies();
        renderGalleryPosts();
        renderNotices();
        renderMembers();
    }
}

// 기도 제목, 간증, 공지사항 렌더링 시 언어 고려
function getTranslation(key) {
    return translations[currentLanguage][key] || key;
}

// 텍스트 업데이트 헬퍼 함수
function updateTextContent(id, text) {
    const element = document.getElementById(id);
    if (element) {
        // logoTitle은 HTML 태그 허용 (줄바꿈 위해)
        if (id === 'logoTitle') {
            element.innerHTML = text;
        }
        // a 태그인 경우
        else if (element.tagName === 'A') {
            element.textContent = text;
        } else {
            element.textContent = text;
        }
    }
}

// 전역 함수로 등록
window.switchLanguage = switchLanguage;

// 모바일 메뉴 설정
function setupMobileMenu() {
    console.log('모바일 메뉴 설정 시작');
    
    const hamburger = document.getElementById('hamburgerMenu');
    const navMenu = document.getElementById('navMenu');
    const navLinks = document.querySelectorAll('.nav-link');
    
    console.log('햄버거 버튼:', hamburger);
    console.log('메뉴:', navMenu);
    console.log('메뉴 링크 개수:', navLinks.length);
    
    if (!hamburger || !navMenu) {
        console.error('햄버거 메뉴 요소를 찾을 수 없습니다!');
        return;
    }
    
    // 햄버거 버튼 클릭 이벤트
    hamburger.addEventListener('click', function(e) {
        console.log('햄버거 메뉴 클릭됨!');
        e.preventDefault();
        e.stopPropagation();
        
        const isActive = navMenu.classList.contains('active');
        console.log('현재 메뉴 상태:', isActive ? '열림' : '닫힘');
        
        navMenu.classList.toggle('active');
        hamburger.classList.toggle('active');
        
        console.log('메뉴 토글 후 상태:', navMenu.classList.contains('active') ? '열림' : '닫힘');
    });
    
    // 터치 이벤트도 추가
    hamburger.addEventListener('touchstart', function(e) {
        console.log('햄버거 메뉴 터치됨!');
        e.preventDefault();
        navMenu.classList.toggle('active');
        hamburger.classList.toggle('active');
    }, { passive: false });
    
    // 메뉴 링크 클릭 시 메뉴 닫기
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            console.log('메뉴 링크 클릭:', link.textContent);
            navMenu.classList.remove('active');
            hamburger.classList.remove('active');
        });
    });
    
    // 메뉴 외부 클릭 시 닫기
    document.addEventListener('click', function(e) {
        if (!navMenu.contains(e.target) && !hamburger.contains(e.target)) {
            if (navMenu.classList.contains('active')) {
                console.log('메뉴 외부 클릭 - 메뉴 닫기');
                navMenu.classList.remove('active');
                hamburger.classList.remove('active');
            }
        }
    });
    
    console.log('모바일 메뉴 설정 완료!');
}

// 전역 함수로도 노출 (HTML onclick용)
window.toggleMobileMenu = function() {
    const navMenu = document.getElementById('navMenu');
    const hamburger = document.getElementById('hamburgerMenu');
    
    if (navMenu && hamburger) {
        navMenu.classList.toggle('active');
        hamburger.classList.toggle('active');
    }
};

window.closeMobileMenu = function() {
    const navMenu = document.getElementById('navMenu');
    const hamburger = document.getElementById('hamburgerMenu');
    
    if (navMenu && hamburger) {
        navMenu.classList.remove('active');
        hamburger.classList.remove('active');
    }
};

// 로그인 상태 확인
function checkLoginStatus() {
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser) {
        currentUser = JSON.parse(savedUser);
        updateUIForLoggedInUser();
    } else {
        // 로그아웃 상태로 시작
        updateUIForLoggedOutUser();
    }
}

// 관리자 권한 확인 함수 (중앙 집중화)
function isUserAdmin(user) {
    if (!user) return false;
    return user.email === 'yeonchoi08@gmail.com' || 
           user.name === '최지연' || 
           user.isAdmin === true ||
           user.isDefaultAdmin === true;
}

// 로그인한 사용자 UI 업데이트
function updateUIForLoggedInUser() {
    // 로그인 정보 표시 (데스크톱/모바일 배너 동시 지원)
    const userInfos = ['userInfo', 'userInfoDesktop']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    userInfos.forEach((el) => {
        el.style.display = 'flex';
    });
    const userNameEls = ['userName', 'userNameDesktop']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    userNameEls.forEach((el) => {
        el.textContent = currentUser.name;
    });
    
    // 관리자 확인
    const isAdmin = isUserAdmin(currentUser);
    
    if (isAdmin) {
        // 관리자 배지 표시
        ['adminBadge', 'adminBadgeDesktop'].forEach((id) => {
            const adminBadge = document.getElementById(id);
            if (adminBadge) adminBadge.style.display = 'inline-flex';
        });
        
        // 관리자 메뉴 표시
        const navAdmin = document.getElementById('navAdmin');
        if (navAdmin) navAdmin.style.display = 'block';
        
        // 관리자 섹션 표시
        const adminSection = document.getElementById('admin');
        if (adminSection) adminSection.style.display = 'block';
        
        // 공지사항 작성 폼 표시
        const noticeFormContainer = document.getElementById('noticeFormContainer');
        if (noticeFormContainer) noticeFormContainer.style.display = 'block';
        
        // 일정 수정 버튼 표시 (관리자 전용)
        updateScheduleAdminControls();
    }
    
    // 모든 로그인한 사용자: 회원 목록 표시
    const memberListSection = document.querySelector('.member-list-section');
    if (memberListSection) memberListSection.style.display = 'block';
    
    // 메뉴 표시/숨김
    const navLogin = document.getElementById('navLogin');
    const navRegister = document.getElementById('navRegister');
    const navPrayers = document.getElementById('navPrayers');
    const navTestimonies = document.getElementById('navTestimonies');
    const navGallery = document.getElementById('navGallery');
    const navNotices = document.getElementById('navNotices');
    
    if (navLogin) navLogin.style.display = 'none';
    if (navRegister) navRegister.style.display = 'none';
    if (navPrayers) navPrayers.style.display = 'block';
    if (navTestimonies) navTestimonies.style.display = 'block';
    if (navGallery) navGallery.style.display = 'block';
    if (navNotices) navNotices.style.display = 'block';
    
    // 보호된 섹션 표시 (기도제목, 간증, 공지사항)
    const protectedSections = ['prayers', 'testimonies', 'gallery', 'notices'];
    protectedSections.forEach(sectionId => {
        const section = document.getElementById(sectionId);
        if (section) section.style.display = 'block';
    });
    
    // 로그인/회원가입 섹션 숨김, 회원 목록은 표시
    const loginSection = document.getElementById('login');
    const registerSection = document.getElementById('register');
    const memberListSectionEl = document.getElementById('memberListSection');
    
    if (loginSection) loginSection.style.display = 'none';
    if (registerSection) registerSection.style.display = 'none';
    if (memberListSectionEl) memberListSectionEl.style.display = 'block';
    
    if (loginSection) loginSection.style.display = 'none';
    if (registerSection) registerSection.style.display = 'none';
    if (memberListSectionEl) memberListSectionEl.style.display = 'block';
}

// 로그아웃한 사용자 UI 업데이트
function updateUIForLoggedOutUser() {
    // 로그인 정보 숨김
    ['userInfo', 'userInfoDesktop'].forEach((id) => {
        const userInfo = document.getElementById(id);
        if (userInfo) userInfo.style.display = 'none';
    });
    
    // 관리자 배지와 메뉴 숨김
    const adminBadge = document.getElementById('adminBadge');
    const adminBadgeDesktop = document.getElementById('adminBadgeDesktop');
    const navAdmin = document.getElementById('navAdmin');
    if (adminBadge) adminBadge.style.display = 'none';
    if (adminBadgeDesktop) adminBadgeDesktop.style.display = 'none';
    if (navAdmin) navAdmin.style.display = 'none';
    
    // 회원 목록 숨김 (로그아웃 상태)
    const memberListSection = document.querySelector('.member-list-section');
    if (memberListSection) memberListSection.style.display = 'none';
    
    // 메뉴 표시/숨김
    const navLogin = document.getElementById('navLogin');
    const navRegister = document.getElementById('navRegister');
    const navPrayers = document.getElementById('navPrayers');
    const navTestimonies = document.getElementById('navTestimonies');
    const navGallery = document.getElementById('navGallery');
    const navNotices = document.getElementById('navNotices');
    
    if (navLogin) navLogin.style.display = 'block';
    if (navRegister) navRegister.style.display = 'block';
    if (navPrayers) navPrayers.style.display = 'none';
    if (navTestimonies) navTestimonies.style.display = 'none';
    if (navGallery) navGallery.style.display = 'none';
    if (navNotices) navNotices.style.display = 'none';
    
    // 보호된 섹션 숨김 (기도제목, 간증, 공지사항, 관리자)
    const protectedSections = ['prayers', 'testimonies', 'gallery', 'notices', 'admin'];
    protectedSections.forEach(sectionId => {
        const section = document.getElementById(sectionId);
        if (section) section.style.display = 'none';
    });
    
    // 공지사항 작성 폼 숨김
    const noticeFormContainer = document.getElementById('noticeFormContainer');
    if (noticeFormContainer) noticeFormContainer.style.display = 'none';
    
    // 로그인, 회원가입 섹션은 표시, 회원 목록은 숨김
    const loginSection = document.getElementById('login');
    const registerSection = document.getElementById('register');
    const memberListSectionEl = document.getElementById('memberListSection');
    if (loginSection) loginSection.style.display = 'block';
    if (registerSection) registerSection.style.display = 'block';
    if (memberListSectionEl) memberListSectionEl.style.display = 'none';
}

// 앱 초기화
function initializeApp() {
    // 모임 일정 로드 (모든 사용자가 볼 수 있음)
    loadSchedule();
    
    // 로그인한 경우에만 보호된 콘텐츠 로드
    if (currentUser) {
        loadPrayers();
        loadTestimonies();
        loadGalleryPosts();
        loadNotices();
        loadMembers(); // 모든 로그인한 사용자가 회원 목록 볼 수 있음
        
        // 관리자인 경우 추가 데이터 로드
        if (isUserAdmin(currentUser)) {
            loadAdminData();
        }
    }
}

// 이벤트 리스너 설정
function setupEventListeners() {
    // 로그인 폼 제출
    document.getElementById('loginForm').addEventListener('submit', handleLoginSubmit);
    
    // 회원가입 폼 제출
    document.getElementById('registerForm').addEventListener('submit', handleRegisterSubmit);
    
    // 공지사항 폼 제출
    document.getElementById('noticeForm').addEventListener('submit', handleNoticeSubmit);
    
    // 공지사항 수정 폼 제출
    document.getElementById('editNoticeForm').addEventListener('submit', handleEditNoticeSubmit);
    
    // 기도 제목 폼 제출
    document.getElementById('prayerForm').addEventListener('submit', handlePrayerSubmit);
    
    // 간증 폼 제출
    document.getElementById('testimonyForm').addEventListener('submit', handleTestimonySubmit);

    // 사역 사진 갤러리 폼 제출
    document.getElementById('galleryForm').addEventListener('submit', handleGallerySubmit);
    document.getElementById('galleryList').addEventListener('click', handleGalleryListClick);
    document.getElementById('galleryLayoutToolbar').addEventListener('click', handleGalleryLayoutToolbarClick);

    // 갤러리 파일 선택 미리보기 (HEIC는 JPEG로 변환 후 처리)
    document.getElementById('galleryImages').addEventListener('change', async function () {
        const file = this.files && this.files[0];
        if (!file) {
            clearGalleryUploadPreview();
            return;
        }
        try {
            selectedGalleryUploadFile = await normalizeGalleryUploadFile(file);
            setGalleryUploadPreview(selectedGalleryUploadFile);
        } catch (error) {
            console.error('[GALLERY] 업로드 파일 변환 실패:', error);
            clearGalleryUploadPreview();
            alert(`사진 준비 실패:\n\n${getGalleryUploadFriendlyMessage(error, file)}\n\n다른 사진으로 다시 시도해주세요.`);
        }
    });

    // 확인 모달 버튼
    const confirmOkBtn = document.getElementById('confirmModalOkBtn');
    const confirmCancelBtn = document.getElementById('confirmModalCancelBtn');
    if (confirmOkBtn) confirmOkBtn.addEventListener('click', () => closeConfirmModal(true));
    if (confirmCancelBtn) confirmCancelBtn.addEventListener('click', () => closeConfirmModal(false));

    // 앱 설치 안내 모달 버튼
    const installPrimaryBtn = document.getElementById('installPromptPrimaryBtn');
    const installSecondaryBtn = document.getElementById('installPromptSecondaryBtn');
    if (installPrimaryBtn) {
        installPrimaryBtn.addEventListener('click', () => closeInstallModal('primary'));
    }
    if (installSecondaryBtn) {
        installSecondaryBtn.addEventListener('click', () => closeInstallModal('secondary'));
    }
    
    // 일정 수정 버튼
    const scheduleEditBtn = document.getElementById('scheduleEditBtn');
    if (scheduleEditBtn) {
        scheduleEditBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            console.log('[SCHEDULE] 일정 수정 버튼 클릭됨!');
            openScheduleEditModal();
        });
        console.log('[SETUP] 일정 수정 버튼 이벤트 리스너 등록 완료');
    } else {
        console.warn('[SETUP] 일정 수정 버튼을 찾을 수 없습니다 (scheduleEditBtn)');
    }
    
    // 네비게이션 링크 클릭
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', handleNavClick);
    });
}

function normalizeGalleryLayoutColumns(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return 1;
    return Math.min(4, Math.max(1, parsed));
}

function updateGalleryLayoutButtons() {
    document.querySelectorAll('.gallery-layout-btn').forEach((btn) => {
        const cols = normalizeGalleryLayoutColumns(btn.dataset.cols);
        const isActive = cols === galleryLayoutColumns;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function applyGalleryLayout(columns, options = {}) {
    const { save = true } = options;
    galleryLayoutColumns = normalizeGalleryLayoutColumns(columns);
    const galleryList = document.getElementById('galleryList');
    if (galleryList) {
        galleryList.dataset.cols = String(galleryLayoutColumns);
    }
    updateGalleryLayoutButtons();
    if (save) {
        localStorage.setItem(GALLERY_LAYOUT_STORAGE_KEY, String(galleryLayoutColumns));
    }
}

function initializeGalleryLayoutControls() {
    const savedCols = localStorage.getItem(GALLERY_LAYOUT_STORAGE_KEY);
    applyGalleryLayout(savedCols || 1, { save: false });
}

function handleGalleryLayoutToolbarClick(e) {
    const btn = e.target.closest('.gallery-layout-btn');
    if (!btn) return;
    applyGalleryLayout(btn.dataset.cols);
}

// 로그인 처리
async function handleLoginSubmit(e) {
    e.preventDefault();
    
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    
    console.log('로그인 시도:', email);
    
    if (!email) {
        alert('이메일을 입력해주세요.');
        return;
    }
    
    if (!password) {
        alert('비밀번호를 입력해주세요.');
        return;
    }
    
    // 이메일 형식 검증
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        alert('올바른 이메일 형식을 입력해주세요.');
        return;
    }
    
    // 기본 관리자 이메일 확인 (회원가입 없이 로그인 가능)
    if (email.toLowerCase() === 'yeonchoi08@gmail.com') {
        console.log('기본 관리자 로그인');
        
        // 기본 관리자 정보 생성
        const defaultAdmin = {
            id: 'default-admin',
            name: '최지연',
            email: 'yeonchoi08@gmail.com',
            gender: 'female',
            phone: '',
            church: '',
            isAdmin: true,
            isDefaultAdmin: true
        };
        
        currentUser = defaultAdmin;
        localStorage.setItem('currentUser', JSON.stringify(defaultAdmin));
        
        // UI 업데이트
        updateUIForLoggedInUser();
        
        // 데이터 로드
        await loadPrayers();
        await loadTestimonies();
        await loadGalleryPosts();
        await loadNotices();
        await loadMembers();
        await loadAdminData();
        
        // 폼 초기화
        document.getElementById('loginForm').reset();
        
        // 성공 메시지
        showToast(`환영합니다, 최지연 권사님! 🙏 관리자로 로그인되었습니다.`);
        await showInstallGuideAfterLogin();
        
        // 기도제목 섹션으로 이동
        setTimeout(() => {
            scrollToSection('prayers');
        }, 1000);
        
        return;
    }
    
    try {
        // 회원 목록에서 이메일로 검색
        console.log('[LOGIN] 회원 목록 조회 중...');
        const response = await fetchWithRetry('tables/members?limit=1000');
        
        console.log('[LOGIN] 회원 목록 응답 상태:', response.status, response.statusText);
        
        const data = await response.json();
        const members = data.data || [];
        
        console.log('[LOGIN] 전체 회원 수:', members.length);
        console.log('[LOGIN] 회원 목록:', members.map(m => ({ name: m.name, email: m.email })));
        
        // 대소문자 구분 없이 이메일 비교
        const member = members.find(m => m.email && m.email.toLowerCase() === email.toLowerCase());
        
        console.log('[LOGIN] 검색된 회원:', member);
        
        if (!member) {
            alert('등록되지 않은 이메일입니다.\n먼저 회원가입을 해주세요.');
            return;
        }
        
        // 비밀번호 해싱
        const hashedPassword = await hashPassword(password);
        
        // 기존 회원 비밀번호 확인 및 설정
        if (!member.password) {
            // 비밀번호가 없는 기존 회원 - 자동으로 비밀번호 설정
            console.log('[LOGIN] 기존 회원 - 비밀번호 자동 설정 중...');
            
            if (password.length < 6) {
                alert('비밀번호는 최소 6자 이상이어야 합니다.\n\n기존 회원분은 처음 로그인 시 원하는 비밀번호를 만들어서 입력하세요.\n이 비밀번호가 저장되며 다음부터 사용하게 됩니다.');
                return;
            }
            
            // 비밀번호 설정 확인
            if (!confirm(`비밀번호를 설정하시겠습니까?\n\n입력하신 비밀번호: ${password}\n\n✅ 이 비밀번호가 저장되며 다음부터 이 비밀번호로 로그인하셔야 합니다.\n⚠️ 비밀번호를 꼭 기억해주세요!`)) {
                return;
            }
            
            try {
                // PUT으로 전체 정보 업데이트
                const updateData = {
                    name: member.name,
                    gender: member.gender,
                    phone: member.phone,
                    email: member.email,
                    church: member.church,
                    password: hashedPassword
                };
                
                // registeredDate가 있으면 추가
                if (member.registeredDate) {
                    updateData.registeredDate = member.registeredDate;
                }
                
                console.log('[LOGIN] 업데이트 데이터:', updateData);
                
                const updateResponse = await fetch(`tables/members/${member.id}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(updateData)
                });
                
                if (!updateResponse.ok) {
                    const errorText = await updateResponse.text();
                    console.error('[LOGIN] 업데이트 실패 응답:', errorText);
                    throw new Error(`비밀번호 설정 실패: ${updateResponse.status}`);
                }
                
                console.log('[LOGIN] 비밀번호 설정 완료');
                
                // 회원 정보 업데이트
                member.password = hashedPassword;
                
                alert(`✅ 비밀번호가 성공적으로 설정되었습니다!\n\n다음부터는 이 비밀번호로 로그인하세요.\n비밀번호: ${password}\n\n⚠️ 비밀번호를 꼭 기억해주세요!`);
                
            } catch (error) {
                console.error('[LOGIN] 비밀번호 설정 오류:', error);
                alert(`비밀번호 설정 중 오류가 발생했습니다.\n\n오류: ${error.message}\n\n관리자에게 문의해주세요.`);
                return;
            }
        } else {
            // 비밀번호가 있는 회원 - 일반 로그인
            if (member.password !== hashedPassword) {
                alert('비밀번호가 일치하지 않습니다.\n다시 확인해주세요.\n\n💡 비밀번호를 잊으셨다면 관리자(yeonchoi08@gmail.com)에게 문의하세요.');
                return;
            }
        }
        
        // 로그인 성공
        currentUser = member;
        localStorage.setItem('currentUser', JSON.stringify(member));
        
        console.log('[LOGIN] 로그인 성공:', member.name);
        
        // UI 업데이트
        updateUIForLoggedInUser();
        
        // 데이터 로드
        await loadPrayers();
        await loadTestimonies();
        await loadGalleryPosts();
        await loadNotices();
        await loadMembers(); // 모든 로그인한 사용자가 회원 목록 볼 수 있음
        
        // 관리자인 경우 추가 작업
        if (isUserAdmin(member)) {
            await loadAdminData();
        }
        
        // 폼 초기화
        document.getElementById('loginForm').reset();
        
        // 성공 메시지
        showToast(`환영합니다, ${member.name}님! 🙏`);
        await showInstallGuideAfterLogin();
        
        // 기도제목 섹션으로 이동
        setTimeout(() => {
            scrollToSection('prayers');
        }, 1000);
    } catch (error) {
        console.error('로그인 오류:', error);
        alert(`로그인 중 오류가 발생했습니다.\n\n오류: ${error.message}\n\n데이터베이스 연결을 확인해주세요.`);
    }
}

// 로그아웃 처리
async function handleLogout() {
    if (!await showConfirm('로그아웃 하시겠습니까?')) return;
    currentUser = null;
    localStorage.removeItem('currentUser');
    updateUIForLoggedOutUser();
    scrollToSection('home');
    showToast('로그아웃 되었습니다.');
}

// 네비게이션 클릭 처리
function handleNavClick(e) {
    e.preventDefault();
    const targetId = e.target.getAttribute('href');
    
    // 활성 상태 업데이트
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
    });
    e.target.classList.add('active');
    
    // 해당 섹션으로 스크롤
    scrollToSection(targetId.substring(1));
}

// 섹션으로 스크롤
function scrollToSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
        section.scrollIntoView({ behavior: 'smooth' });
    }
}

// 회원 로드
async function loadMembers() {
    try {
        console.log('[API] 회원 목록 로드 시작...');
        const response = await fetchWithRetry('tables/members?limit=100&sort=-created_at');
        
        console.log('[API] 회원 목록 응답 상태:', response.status, response.statusText);
        
        const data = await response.json();
        console.log('[API] 회원 목록 데이터:', data);
        currentMembers = data.data || [];
        renderMembers();
    } catch (error) {
        console.error('[ERROR] 회원 목록을 불러오는 중 오류 발생:', error);
        const memberList = document.getElementById('memberList');
        if (memberList) {
            memberList.innerHTML = `<div class="loading">❌ 회원 목록을 불러오는 중 오류가 발생했습니다.<br><small>오류: ${error.message}</small></div>`;
        }
    }
}

// 회원 렌더링
function renderMembers() {
    const memberList = document.getElementById('memberList');
    
    console.log('[MEMBERS] renderMembers 호출됨');
    console.log('[MEMBERS] currentUser:', currentUser);
    console.log('[MEMBERS] currentMembers 수:', currentMembers.length);
    
    if (!memberList) {
        console.log('[MEMBERS] memberList 요소를 찾을 수 없음');
        return;
    }
    
    // 로그인 확인
    if (!currentUser) {
        console.log('[MEMBERS] 로그인되지 않음');
        memberList.innerHTML = '<div class="loading">로그인 후 회원 목록을 확인할 수 있습니다.</div>';
        const memberListSection = document.querySelector('.member-list-section');
        if (memberListSection) memberListSection.style.display = 'none';
        return;
    }
    
    // 관리자 확인
    const isAdmin = isUserAdmin(currentUser);
    console.log('[MEMBERS] 관리자 여부:', isAdmin);
    
    // 로그인한 사용자는 회원 목록 표시
    const memberListSection = document.querySelector('.member-list-section');
    if (memberListSection) {
        memberListSection.style.display = 'block';
        console.log('[MEMBERS] 회원 목록 섹션 표시');
    }
    
    if (currentMembers.length === 0) {
        console.log('[MEMBERS] 회원 데이터 없음');
        memberList.innerHTML = '<div class="loading">아직 등록된 회원이 없습니다.</div>';
        return;
    }
    
    console.log('[MEMBERS] 회원 목록 렌더링 시작');
    
    memberList.innerHTML = currentMembers.map(member => {
        // 관리자 여부 확인
        const isMemberAdmin = isUserAdmin(member);
        
        // 이메일과 전화번호 표시 규칙
        // 1. 현재 사용자가 관리자면 모든 정보 표시
        // 2. 회원이 관리자면 모든 사람에게 공개
        // 3. 일반 회원의 정보는 일반 사용자에게 마스킹
        const shouldShowFullInfo = isAdmin || isMemberAdmin;
        const displayPhone = shouldShowFullInfo ? escapeHtml(member.phone) : '***-****-****';
        const displayEmail = shouldShowFullInfo ? escapeHtml(member.email || '미입력') : '***@*****.***';
        
        return `
        <div class="member-card fade-in-up ${isMemberAdmin ? 'admin-member' : ''}" data-id="${member.id}">
            <div class="member-card-header">
                <div class="member-name">
                    <div class="member-name-text">${escapeHtml(member.name)}</div>
                    ${isMemberAdmin ? '<div class="member-role-row"><span class="inline-badge">🙏 기도인도자</span><span class="inline-badge">👑 관리자</span></div>' : ''}
                </div>
            </div>
            <div class="member-info">
                <div class="member-info-item">
                    <i class="fas fa-venus-mars"></i>
                    <span>${member.gender === 'male' ? '남성' : '여성'}</span>
                </div>
                <div class="member-info-item">
                    <i class="fas fa-phone"></i>
                    <span>${displayPhone}</span>
                    ${!shouldShowFullInfo ? '<small style="color: #999; margin-left: 0.5rem;">(보호됨)</small>' : ''}
                </div>
                <div class="member-info-item">
                    <i class="fas fa-envelope"></i>
                    <span>${displayEmail}</span>
                    ${!shouldShowFullInfo ? '<small style="color: #999; margin-left: 0.5rem;">(보호됨)</small>' : ''}
                </div>
                <div class="member-info-item">
                    <i class="fas fa-church"></i>
                    <span>${escapeHtml(member.church)}</span>
                </div>
                <div class="member-info-item">
                    <i class="fas fa-calendar"></i>
                    <span>${formatDate(member.created_at)}</span>
                </div>
            </div>
            ${isAdmin ? `
            <div class="member-actions">
                <button class="action-button delete" onclick="deleteMember('${member.id}')">
                    <i class="fas fa-trash"></i> 삭제
                </button>
            </div>
            ` : ''}
        </div>
    `;}).join('');
    
    console.log('[MEMBERS] 회원 목록 렌더링 완료:', currentMembers.length, '명');
}

// 회원가입 제출 처리
async function handleRegisterSubmit(e) {
    e.preventDefault();
    
    const name = document.getElementById('memberName').value.trim();
    const gender = document.querySelector('input[name="gender"]:checked')?.value;
    const phone = document.getElementById('memberPhone').value.trim();
    const email = document.getElementById('memberEmail').value.trim();
    const password = document.getElementById('memberPassword').value;
    const passwordConfirm = document.getElementById('memberPasswordConfirm').value;
    const church = document.getElementById('memberChurch').value.trim();
    
    if (!name || !gender || !phone || !email || !password || !passwordConfirm || !church) {
        alert('모든 필수 항목을 입력해주세요.');
        return;
    }
    
    // 비밀번호 길이 검증
    if (password.length < 6) {
        alert('비밀번호는 최소 6자 이상이어야 합니다.');
        return;
    }
    
    // 비밀번호 일치 확인
    if (password !== passwordConfirm) {
        alert('비밀번호가 일치하지 않습니다. 다시 확인해주세요.');
        return;
    }
    
    // 이메일 형식 검증
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        alert('올바른 이메일 형식을 입력해주세요. (예: example@email.com)');
        return;
    }
    
    try {
        // 비밀번호 해싱
        const hashedPassword = await hashPassword(password);
        
        const response = await fetch('tables/members', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: name,
                gender: gender,
                phone: phone,
                email: email,
                password: hashedPassword,
                church: church,
                registeredDate: new Date().toISOString()
            })
        });
        
        if (response.ok) {
            // 폼 초기화
            document.getElementById('registerForm').reset();
            
            // 목록 새로고침
            await loadMembers();
            
            // 성공 메시지
            alert('회원가입이 완료되었습니다! 🎉\n이제 설정하신 비밀번호로 로그인하실 수 있습니다.');
            
            // 로그인 페이지로 이동
            scrollToSection('login');
        } else {
            throw new Error('등록 실패');
        }
    } catch (error) {
        console.error('회원가입 오류:', error);
        alert('회원가입 중 오류가 발생했습니다.');
    }
}

// 회원 삭제
async function deleteMember(id) {
    if (!await showConfirm('이 회원을 삭제하시겠습니까?')) return;
    
    try {
        const response = await fetch(`tables/members/${id}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            await loadMembers();
            showToast('회원이 삭제되었습니다.');
        }
    } catch (error) {
        console.error('회원 삭제 오류:', error);
        alert('삭제 중 오류가 발생했습니다.');
    }
}

// 기도 제목 로드
async function loadPrayers() {
    try {
        console.log('[API] 기도 제목 로드 시작...');
        const response = await fetchWithRetry('tables/prayers?limit=100&sort=-created_at');
        
        console.log('[API] 기도 제목 응답 상태:', response.status, response.statusText);
        
        const data = await response.json();
        console.log('[API] 기도 제목 데이터:', data);
        currentPrayers = data.data || [];
        renderPrayers();
    } catch (error) {
        console.error('[ERROR] 기도 제목을 불러오는 중 오류 발생:', error);
        document.getElementById('prayerList').innerHTML = 
            `<div class="loading">❌ 기도 제목을 불러오는 중 오류가 발생했습니다.<br><small>오류: ${error.message}</small></div>`;
    }
}

// 기도 제목 렌더링
async function renderPrayers() {
    const prayerList = document.getElementById('prayerList');
    const t = translations[currentLanguage];
    
    if (currentPrayers.length === 0) {
        prayerList.innerHTML = `<div class="loading">${t.prayers_empty}</div>`;
        return;
    }
    
    // 로딩 표시
    if (currentLanguage === 'en') {
        prayerList.innerHTML = `<div class="loading">Translating prayer requests...</div>`;
    }
    
    const currentUserKey = getCurrentUserKey();
    const prayedItems = getUserActionList('prayedItemsByUser', currentUserKey);
    
    // 각 기도제목을 번역하고 HTML 생성
    const translatedPrayers = await Promise.all(currentPrayers.map(async (prayer) => {
        const hasPrayed = currentUserKey ? prayedItems.includes(prayer.id) : false;
        const isProcessing = prayerClickInFlight.has(prayer.id);
        const canDelete = canDeletePrayerPost(prayer);
        const prayBtnClass = hasPrayed ? 'action-button pray-btn prayed' : 'action-button pray-btn';
        const checkIcon = hasPrayed ? '<i class="fas fa-check"></i> ' : '';
        const anonymousText = t.anonymous;
        const prayersCountText = currentLanguage === 'ko' ? `${prayer.prayerCount || 0}명 기도` : `${prayer.prayerCount || 0} ${t.prayers_count}`;
        
        // 제목과 내용 번역
        const displayTitle = await getTranslatedContent(prayer.title, currentLanguage);
        const displayContent = await getTranslatedContent(prayer.content, currentLanguage);
        
        return `
        <div class="prayer-item fade-in-up" data-id="${prayer.id}">
            <div class="item-header">
                <div>
                    <h3 class="item-title">${escapeHtml(displayTitle)}</h3>
                    <div class="item-meta">
                        <span><i class="fas fa-user"></i> ${prayer.isAnonymous ? anonymousText : escapeHtml(prayer.name || anonymousText)}</span>
                        <span><i class="fas fa-calendar"></i> ${formatDate(prayer.created_at)}</span>
                    </div>
                </div>
                <div class="prayer-count">
                    <i class="fas fa-praying-hands"></i>
                    <span>${prayersCountText}</span>
                </div>
            </div>
            <p class="item-content">${escapeHtml(displayContent)}</p>
            <div class="item-actions">
                <button class="${prayBtnClass}" onclick="prayForItem('${prayer.id}')" ${isProcessing ? 'disabled' : ''}>
                    ${checkIcon}<i class="fas fa-praying-hands"></i> ${t.prayers_button}
                </button>
                ${canDelete ? `
                <button class="action-button delete" onclick="deletePrayer('${prayer.id}')">
                    <i class="fas fa-trash"></i>
                </button>
                ` : ''}
            </div>
        </div>
    `;
    }));
    
    prayerList.innerHTML = translatedPrayers.join('');
}

// 기도 제목 제출 처리
async function handlePrayerSubmit(e) {
    e.preventDefault();
    
    const name = document.getElementById('prayerName').value.trim();
    const title = document.getElementById('prayerTitle').value.trim();
    const content = document.getElementById('prayerContent').value.trim();
    const isAnonymous = document.getElementById('prayerAnonymous').checked;
    
    if (!title || !content) {
        alert('제목과 내용을 모두 입력해주세요.');
        return;
    }
    
    try {
        const response = await fetch('tables/prayers', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: isAnonymous ? '익명' : (name || '익명'),
                authorName: currentUser ? currentUser.name : (name || '익명'),
                authorEmail: currentUser ? (currentUser.email || '') : '',
                title: title,
                content: content,
                isAnonymous: isAnonymous,
                prayerCount: 0,
                date: new Date().toISOString()
            })
        });
        
        if (response.ok) {
            // 폼 초기화
            document.getElementById('prayerForm').reset();
            
            // 목록 새로고침
            await loadPrayers();
            
            // 성공 메시지
            alert('기도 제목이 등록되었습니다. 함께 기도합니다! 🙏');
        } else {
            throw new Error('등록 실패');
        }
    } catch (error) {
        console.error('기도 제목 등록 오류:', error);
        alert('기도 제목 등록 중 오류가 발생했습니다.');
    }
}

// 기도했어요 클릭 (토글 기능)
async function prayForItem(id) {
    if (prayerClickInFlight.has(id)) {
        return;
    }

    const currentUserKey = getCurrentUserKey();
    if (!currentUserKey) {
        showToast('로그인 후 이용할 수 있습니다.');
        return;
    }
    
    prayerClickInFlight.add(id);
    try {
        const prayer = currentPrayers.find(p => p.id === id);
        if (!prayer) return;
        const prayedItems = getUserActionList('prayedItemsByUser', currentUserKey);

        const hasPrayed = prayedItems.includes(id);
        const newCount = hasPrayed
            ? Math.max(0, (prayer.prayerCount || 0) - 1)
            : (prayer.prayerCount || 0) + 1;
        
        const updateMethod = API_BASE_URL ? 'PUT' : 'PATCH';
        const response = await fetch(`tables/prayers/${id}`, {
            method: updateMethod,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                prayerCount: newCount
            })
        });
        
        if (response.ok) {
            const nextPrayedItems = hasPrayed
                ? prayedItems.filter(itemId => itemId !== id)
                : [...prayedItems, id];
            saveUserActionList('prayedItemsByUser', currentUserKey, nextPrayedItems);
            prayer.prayerCount = newCount;
            showToast(hasPrayed ? '기도 참여를 취소했습니다' : '기도해주셔서 감사합니다! 🙏');
            await loadPrayers();
        } else {
            throw new Error(`기도 카운트 업데이트 실패 (${response.status})`);
        }
    } catch (error) {
        console.error('기도 카운트 업데이트 오류:', error);
        showToast('기도 참여 처리 중 오류가 발생했습니다.');
    } finally {
        prayerClickInFlight.delete(id);
    }
}

// 기도 제목 삭제
async function deletePrayer(id) {
    const targetPrayer = currentPrayers.find((prayer) => prayer.id === id);
    if (!canDeletePrayerPost(targetPrayer)) {
        alert('작성자 본인 또는 관리자만 삭제할 수 있습니다.');
        return;
    }

    if (!await showConfirm('이 기도 제목을 삭제하시겠습니까?')) return;
    
    try {
        const response = await fetch(`tables/prayers/${id}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            await loadPrayers();
            showToast('기도 제목이 삭제되었습니다.');
        }
    } catch (error) {
        console.error('기도 제목 삭제 오류:', error);
        alert('삭제 중 오류가 발생했습니다.');
    }
}

// 간증 로드
async function loadTestimonies() {
    try {
        console.log('[API] 간증 로드 시작...');
        const response = await fetchWithRetry('tables/testimonies?limit=100&sort=-created_at');
        
        console.log('[API] 간증 응답 상태:', response.status, response.statusText);
        
        const data = await response.json();
        console.log('[API] 간증 데이터:', data);
        currentTestimonies = data.data || [];
        renderTestimonies();
    } catch (error) {
        console.error('[ERROR] 간증을 불러오는 중 오류 발생:', error);
        document.getElementById('testimonyList').innerHTML = 
            `<div class="loading">❌ 간증을 불러오는 중 오류가 발생했습니다.<br><small>오류: ${error.message}</small></div>`;
    }
}

// 간증 렌더링
async function renderTestimonies() {
    const testimonyList = document.getElementById('testimonyList');
    const t = translations[currentLanguage];
    
    if (currentTestimonies.length === 0) {
        testimonyList.innerHTML = `<div class="loading">${t.testimonies_empty}</div>`;
        return;
    }
    
    // 로딩 표시
    if (currentLanguage === 'en') {
        testimonyList.innerHTML = `<div class="loading">Translating testimonies...</div>`;
    }
    
    const currentUserKey = getCurrentUserKey();
    const likedItems = getUserActionList('likedTestimoniesByUser', currentUserKey);
    const anonymousText = t.anonymous;
    
    // 각 간증을 번역하고 HTML 생성
    const translatedTestimonies = await Promise.all(currentTestimonies.map(async (testimony) => {
        const hasLiked = currentUserKey ? likedItems.includes(testimony.id) : false;
        const isProcessing = testimonyLikeInFlight.has(testimony.id);
        const canDelete = canDeleteTestimonyPost(testimony);
        const likeBtnClass = hasLiked ? 'action-button like-btn liked' : 'action-button like-btn';
        const heartIcon = hasLiked ? 'fas fa-heart' : 'far fa-heart';
        
        // 제목과 내용 번역
        const displayTitle = await getTranslatedContent(testimony.title, currentLanguage);
        const displayContent = await getTranslatedContent(testimony.content, currentLanguage);
        
        return `
        <div class="testimony-item fade-in-up" data-id="${testimony.id}">
            <div class="item-header">
                <div>
                    <h3 class="item-title">${escapeHtml(displayTitle)}</h3>
                    <div class="item-meta">
                        <span><i class="fas fa-user"></i> ${testimony.isAnonymous ? anonymousText : escapeHtml(testimony.name || anonymousText)}</span>
                        <span><i class="fas fa-calendar"></i> ${formatDate(testimony.created_at)}</span>
                    </div>
                </div>
                <div class="testimony-like-count">
                    <i class="fas fa-heart"></i>
                    <span>${testimony.likeCount || 0}</span>
                </div>
            </div>
            <p class="item-content">${escapeHtml(displayContent)}</p>
            <div class="item-actions">
                <button class="${likeBtnClass}" onclick="likeTestimony('${testimony.id}')" ${isProcessing ? 'disabled' : ''}>
                    <i class="${heartIcon}"></i> ${t.testimonies_button}
                </button>
                ${canDelete ? `
                <button class="action-button delete" onclick="deleteTestimony('${testimony.id}')">
                    <i class="fas fa-trash"></i>
                </button>
                ` : ''}
            </div>
        </div>
    `;
    }));
    
    testimonyList.innerHTML = translatedTestimonies.join('');
}

// 간증 제출 처리
async function handleTestimonySubmit(e) {
    e.preventDefault();
    
    const name = document.getElementById('testimonyName').value.trim();
    const title = document.getElementById('testimonyTitle').value.trim();
    const content = document.getElementById('testimonyContent').value.trim();
    const isAnonymous = document.getElementById('testimonyAnonymous').checked;
    
    if (!title || !content) {
        alert('제목과 내용을 모두 입력해주세요.');
        return;
    }
    
    try {
        const response = await fetch('tables/testimonies', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: isAnonymous ? '익명' : (name || '익명'),
                authorName: currentUser ? currentUser.name : (name || '익명'),
                authorEmail: currentUser ? (currentUser.email || '') : '',
                title: title,
                content: content,
                isAnonymous: isAnonymous,
                likeCount: 0,
                date: new Date().toISOString()
            })
        });
        
        if (response.ok) {
            // 폼 초기화
            document.getElementById('testimonyForm').reset();
            
            // 목록 새로고침
            await loadTestimonies();
            
            // 성공 메시지
            alert('간증이 등록되었습니다. 할렐루야! 🎉');
        } else {
            throw new Error('등록 실패');
        }
    } catch (error) {
        console.error('간증 등록 오류:', error);
        alert('간증 등록 중 오류가 발생했습니다.');
    }
}

// 간증 좋아요 클릭 (토글 기능)
async function likeTestimony(id) {
    if (testimonyLikeInFlight.has(id)) {
        return;
    }

    const currentUserKey = getCurrentUserKey();
    if (!currentUserKey) {
        showToast('로그인 후 이용할 수 있습니다.');
        return;
    }
    
    testimonyLikeInFlight.add(id);
    try {
        const testimony = currentTestimonies.find(t => t.id === id);
        if (!testimony) return;
        const likedItems = getUserActionList('likedTestimoniesByUser', currentUserKey);

        const hasLiked = likedItems.includes(id);
        const newCount = hasLiked
            ? Math.max(0, (testimony.likeCount || 0) - 1)
            : (testimony.likeCount || 0) + 1;
        
        const updateMethod = API_BASE_URL ? 'PUT' : 'PATCH';
        const response = await fetch(`tables/testimonies/${id}`, {
            method: updateMethod,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                likeCount: newCount
            })
        });
        
        if (response.ok) {
            const nextLikedItems = hasLiked
                ? likedItems.filter(itemId => itemId !== id)
                : [...likedItems, id];
            saveUserActionList('likedTestimoniesByUser', currentUserKey, nextLikedItems);
            testimony.likeCount = newCount;
            showToast(hasLiked ? '할렐루야 참여를 취소했습니다' : '할렐루야! 함께 기뻐합니다! 🎉');
            await loadTestimonies();
        } else {
            throw new Error(`좋아요 업데이트 실패 (${response.status})`);
        }
    } catch (error) {
        console.error('좋아요 업데이트 오류:', error);
        showToast('할렐루야 처리 중 오류가 발생했습니다.');
    } finally {
        testimonyLikeInFlight.delete(id);
    }
}

// 간증 삭제
async function deleteTestimony(id) {
    const targetTestimony = currentTestimonies.find((testimony) => testimony.id === id);
    if (!canDeleteTestimonyPost(targetTestimony)) {
        alert('작성자 본인 또는 관리자만 삭제할 수 있습니다.');
        return;
    }

    if (!await showConfirm('이 간증을 삭제하시겠습니까?')) return;
    
    try {
        const response = await fetch(`tables/testimonies/${id}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            await loadTestimonies();
            showToast('간증이 삭제되었습니다.');
        }
    } catch (error) {
        console.error('간증 삭제 오류:', error);
        alert('삭제 중 오류가 발생했습니다.');
    }
}

// 사역 사진 갤러리 로드
// silent=true: 기존 목록을 유지하며 백그라운드 갱신 (업로드/삭제 후 호출)
async function loadGalleryPosts(silent = false) {
    const galleryList = document.getElementById('galleryList');
    if (galleryList && !silent) {
        galleryList.innerHTML = `<div class="loading">${translations[currentLanguage].gallery_loading}</div>`;
    }

    if (!isGalleryRemoteAvailable) {
        currentGalleryPosts = getLocalGalleryPosts();
        renderGalleryPosts();
        return;
    }

    try {
        const ts = Date.now();
        const response = await fetchWithRetry(`tables/gallery_posts?limit=100&sort=-created_at&_=${ts}`);
        const data = await response.json();
        const remotePosts = data.data || [];
        const localPosts = getLocalGalleryPosts();
        currentGalleryPosts = [...localPosts, ...remotePosts].sort((a, b) => {
            const aTime = new Date(a.created_at || a.date || 0).getTime();
            const bTime = new Date(b.created_at || b.date || 0).getTime();
            return bTime - aTime;
        });
        renderGalleryPosts();
    } catch (error) {
        const errorMessage = String(error && error.message ? error.message : error);
        if (errorMessage.includes('no such table: gallery_posts')) {
            isGalleryRemoteAvailable = false;
            console.warn('[GALLERY] gallery_posts 테이블이 없어 로컬 모드로 전환합니다.');
        } else {
            console.error('사역 사진 갤러리를 불러오는 중 오류:', error);
        }
        currentGalleryPosts = getLocalGalleryPosts();
        renderGalleryPosts();
    }
}

function getLocalGalleryPosts() {
    try {
        const parsed = JSON.parse(localStorage.getItem(GALLERY_LOCAL_STORAGE_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('로컬 갤러리 데이터 파싱 오류:', error);
        return [];
    }
}

function saveLocalGalleryPosts(posts) {
    localStorage.setItem(GALLERY_LOCAL_STORAGE_KEY, JSON.stringify(posts));
}

function addLocalGalleryPost(post) {
    const localPosts = getLocalGalleryPosts();
    localPosts.unshift(post);
    saveLocalGalleryPosts(localPosts);
}

function clearGalleryUploadPreview() {
    const preview = document.getElementById('galleryImagePreview');
    const previewImg = document.getElementById('galleryPreviewImg');
    const previewName = document.getElementById('galleryPreviewName');
    if (preview) preview.style.display = 'none';
    if (previewImg) previewImg.src = '';
    if (previewName) previewName.textContent = '';
    selectedGalleryUploadFile = null;
}

function isImageReadErrorMessage(message) {
    return /이미지 파일을 읽지 못했습니다|이미지 원본을 읽지 못했습니다|NotReadableError|NotFoundError|AbortError/i.test(String(message || ''));
}

function getGalleryUploadFriendlyMessage(error, file) {
    const message = String(error && error.message ? error.message : error || '');
    const fileName = (file && file.name) ? `"${file.name}"` : '선택한 사진';

    if (message.includes('HEIC 변환 모듈')) {
        return `${fileName} 변환 모듈을 불러오지 못했습니다.\n잠시 후 다시 시도하거나 앱을 완전히 종료 후 재실행해 주세요.`;
    }
    if (message.includes('HEIC 변환에 실패')) {
        return `${fileName}의 HEIC 변환에 실패했습니다.\n사진 앱에서 JPG로 내보낸 뒤 다시 업로드해 주세요.`;
    }
    if (isImageReadErrorMessage(message)) {
        return `${fileName} 파일을 읽지 못했습니다.\n아래를 확인해 주세요:\n- 사진 원본을 기기에 먼저 다운로드\n- 파일 앱/클라우드에서 직접 선택 시 잠시 후 재시도\n- 다른 사진 1장으로 먼저 테스트`;
    }
    if (message.includes('이미지 처리 중 오류') || message.includes('이미지 캔버스 처리 실패')) {
        return `${fileName} 처리 중 오류가 발생했습니다.\n이미지 크기가 너무 크거나 브라우저 메모리가 부족할 수 있습니다.`;
    }
    return message || '사진 처리 중 알 수 없는 오류가 발생했습니다.';
}

function isHeicFile(file) {
    if (!file) return false;
    const type = (file.type || '').toLowerCase();
    const name = (file.name || '').toLowerCase();
    return type.includes('heic') || type.includes('heif') || name.endsWith('.heic') || name.endsWith('.heif');
}

async function convertHeicToJpegFile(file) {
    if (!window.heic2any) {
        throw new Error('HEIC 변환 모듈을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
    const converted = await window.heic2any({
        blob: file,
        toType: 'image/jpeg',
        quality: 0.85
    });
    const convertedBlob = Array.isArray(converted) ? converted[0] : converted;
    if (!convertedBlob) throw new Error('HEIC 변환에 실패했습니다.');
    const nextName = (file.name || 'upload').replace(/\.(heic|heif)$/i, '.jpg');
    return new File([convertedBlob], nextName, { type: 'image/jpeg' });
}

async function normalizeGalleryUploadFile(file) {
    if (!file) return null;
    if (isHeicFile(file)) {
        return convertHeicToJpegFile(file);
    }
    return file;
}

function setGalleryUploadPreview(file) {
    const preview = document.getElementById('galleryImagePreview');
    const previewImg = document.getElementById('galleryPreviewImg');
    const previewName = document.getElementById('galleryPreviewName');
    if (!preview || !previewImg || !previewName) return;

    if (!file) {
        clearGalleryUploadPreview();
        return;
    }

    const objectUrl = URL.createObjectURL(file);
    previewImg.onload = () => URL.revokeObjectURL(objectUrl);
    previewImg.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        // 일부 모바일 포맷(예: HEIC)은 미리보기가 안 될 수 있다.
        previewName.textContent = `${file.name || ''} (미리보기 불가 형식)`;
    };
    previewImg.src = objectUrl;
    previewName.textContent = file.name || '';
    preview.style.display = 'block';
}

function canDeleteGalleryPost(post) {
    if (!currentUser || !post) return false;
    if (post.localOnly) return true;
    return canDeleteAuthoredPost(post);
}

function parseGalleryImages(rawImages) {
    if (Array.isArray(rawImages)) {
        return rawImages.filter(Boolean);
    }
    if (typeof rawImages === 'string') {
        try {
            const parsed = JSON.parse(rawImages);
            return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
        } catch (error) {
            console.warn('갤러리 이미지 파싱 실패:', error);
        }
    }
    return [];
}

function renderGalleryPosts() {
    const galleryList = document.getElementById('galleryList');
    if (!galleryList) return;

    const t = translations[currentLanguage];
    if (!currentGalleryPosts || currentGalleryPosts.length === 0) {
        galleryList.innerHTML = `<div class="loading">${t.gallery_empty}</div>`;
        return;
    }

    galleryList.innerHTML = currentGalleryPosts.map((post) => {
        const imageUrls = parseGalleryImages(post.images);
        const safeDescription = escapeHtml(post.description || '');
        const author = escapeHtml(post.authorName || post.name || '익명');
        const createdAt = formatDate(post.created_at || post.date || new Date().toISOString());
        const canDelete = canDeleteGalleryPost(post);

        return `
            <article class="gallery-item fade-in-up">
                <div class="gallery-item-header">
                    <div class="gallery-author">
                        <i class="fas fa-user-circle"></i>
                        <span>${author}</span>
                        ${post.localOnly ? `<span class="gallery-local-badge">${t.gallery_saved_local}</span>` : ''}
                    </div>
                    <div class="gallery-date">
                        <i class="fas fa-calendar"></i>
                        <span>${createdAt}</span>
                    </div>
                </div>
                <p class="gallery-description">${safeDescription}</p>
                <div class="gallery-images">
                    ${imageUrls.map((url, index) => `<div class="gallery-image-wrap"><img src="${url}" alt="gallery-photo-${index + 1}" loading="lazy" onclick="openLightbox(this.src)"></div>`).join('')}
                </div>
                ${canDelete ? `
                    <div class="item-actions gallery-item-actions">
                        <button class="action-button delete gallery-delete-btn" data-post-id="${post.id}" data-local-only="${post.localOnly ? '1' : '0'}">
                            <i class="fas fa-trash"></i> ${t.btn_delete}
                        </button>
                    </div>
                ` : ''}
            </article>
        `;
    }).join('');
}

function removeLocalGalleryPostById(id) {
    const localPosts = getLocalGalleryPosts();
    const next = localPosts.filter((post) => String(post.id) !== String(id));
    saveLocalGalleryPosts(next);
}

async function deleteGalleryPost(postId, isLocalOnly) {
    const targetPost = currentGalleryPosts.find((post) => String(post.id) === String(postId));
    if (!targetPost) {
        showToast('이미 삭제되었거나 게시물을 찾을 수 없습니다.');
        return;
    }
    if (!canDeleteGalleryPost(targetPost)) {
        alert('본인이 올린 사진 또는 관리자만 삭제할 수 있습니다.');
        return;
    }
    if (!await showConfirm('이 사진 게시물을 삭제하시겠습니까?')) return;

    // 낙관적 즉시 제거: 서버 응답 전에 화면에서 먼저 삭제
    currentGalleryPosts = currentGalleryPosts.filter((p) => String(p.id) !== String(postId));
    renderGalleryPosts();

    try {
        if (isLocalOnly) {
            removeLocalGalleryPostById(postId);
            showToast('갤러리 게시물이 삭제되었습니다.');
            return;
        }

        const response = await fetch(`tables/gallery_posts/${postId}`, {
            method: 'DELETE'
        });
        // 204 No Content, 200 OK, 404 Already gone → 모두 성공 처리
        if (response.status === 404) {
            showToast('갤러리 게시물이 삭제되었습니다.');
            loadGalleryPosts(true);
            return;
        }
        if (!response.ok) {
            let body = '';
            try { body = await response.text(); } catch (_) {}
            throw new Error(`삭제 실패 (HTTP ${response.status})${body ? '\n' + body.slice(0, 200) : ''}`);
        }
        showToast('갤러리 게시물이 삭제되었습니다.');
        loadGalleryPosts(true);
    } catch (error) {
        console.error('갤러리 게시물 삭제 오류:', error);
        await loadGalleryPosts();
        alert(`삭제 오류:\n\n${error.message}\n\n이 내용을 관리자에게 알려주세요.`);
    }
}

async function handleGalleryListClick(e) {
    const deleteBtn = e.target.closest('.gallery-delete-btn');
    if (!deleteBtn) return;
    const postId = deleteBtn.dataset.postId;
    const isLocalOnly = deleteBtn.dataset.localOnly === '1';
    if (!postId) return;
    await deleteGalleryPost(postId, isLocalOnly);
}

function openLightbox(src) {
    const lb = document.getElementById('galleryLightbox');
    const img = document.getElementById('galleryLightboxImg');
    if (!lb || !img) return;
    img.src = src;
    lb.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    const lb = document.getElementById('galleryLightbox');
    if (lb) lb.style.display = 'none';
    document.body.style.overflow = '';
}

function fileToDataUrlOnce(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => {
            const reason = (reader.error && reader.error.name) ? reader.error.name : 'UnknownError';
            reject(new Error(`이미지 파일을 읽지 못했습니다 (${reason})`));
        };
        reader.readAsDataURL(file);
    });
}

async function fileToDataUrl(file) {
    try {
        return await fileToDataUrlOnce(file);
    } catch (firstError) {
        // 모바일 환경에서 간헐적으로 FileReader가 실패하는 경우가 있어 1회 우회 재시도
        try {
            await new Promise((resolve) => setTimeout(resolve, 120));
            if (file && typeof file.arrayBuffer === 'function') {
                const buffer = await file.arrayBuffer();
                const cloned = new File([buffer], file.name || 'upload', {
                    type: file.type || 'application/octet-stream'
                });
                return await fileToDataUrlOnce(cloned);
            }
        } catch (secondError) {
            console.warn('[GALLERY] 파일 읽기 재시도 실패:', secondError);
        }
        throw new Error(getGalleryUploadFriendlyMessage(firstError, file));
    }
}

// 목표 크기(바이트) 이하가 될 때까지 품질을 낮춰가며 압축
async function compressImageFileToDataUrl(file, maxWidth = 960, quality = 0.75) {
    const TARGET_BYTES = 350 * 1024; // 350KB (base64 포함 ~467KB)

    try {
        const dataUrl = await new Promise((resolve, reject) => {
            if (!file || !file.type.startsWith('image/')) {
                reject(new Error('이미지 파일만 업로드할 수 있습니다.'));
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    const ratio = img.width > maxWidth ? (maxWidth / img.width) : 1;
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round(img.width * ratio));
                    canvas.height = Math.max(1, Math.round(img.height * ratio));
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        reject(new Error('이미지 캔버스 처리 실패'));
                        return;
                    }
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    resolve({ canvas, img });
                };
                img.onerror = () => reject(new Error('이미지 처리 중 오류가 발생했습니다.'));
                img.src = reader.result;
            };
            reader.onerror = () => {
                const reason = (reader.error && reader.error.name) ? reader.error.name : 'UnknownError';
                reject(new Error(`이미지 파일을 읽지 못했습니다 (${reason})`));
            };
            reader.readAsDataURL(file);
        });

        const { canvas } = dataUrl;

        // 첫 시도
        let result = canvas.toDataURL('image/jpeg', quality);
        if (result.length <= TARGET_BYTES * 1.37) return result; // base64는 원본의 ~1.37배

        // 크기 초과 시 품질 단계적 축소
        for (const q of [0.65, 0.55, 0.45, 0.35]) {
            result = canvas.toDataURL('image/jpeg', q);
            if (result.length <= TARGET_BYTES * 1.37) return result;
        }

        // 그래도 크면 해상도도 줄임
        const smallCanvas = document.createElement('canvas');
        smallCanvas.width = Math.max(1, Math.round(canvas.width * 0.65));
        smallCanvas.height = Math.max(1, Math.round(canvas.height * 0.65));
        const smallCtx = smallCanvas.getContext('2d');
        if (!smallCtx) return result;
        smallCtx.drawImage(canvas, 0, 0, smallCanvas.width, smallCanvas.height);
        return smallCanvas.toDataURL('image/jpeg', 0.55);
    } catch (error) {
        console.warn('[GALLERY] 압축 실패, 원본 DataURL로 대체:', error);
        return fileToDataUrl(file);
    }
}

async function handleGallerySubmit(e) {
    e.preventDefault();

    if (!currentUser) {
        alert('로그인 후 이용 가능합니다.');
        return;
    }

    const descriptionInput = document.getElementById('galleryDescription');
    const imagesInput = document.getElementById('galleryImages');
    const description = descriptionInput.value.trim();
    const files = selectedGalleryUploadFile ? [selectedGalleryUploadFile] : Array.from(imagesInput.files || []);

    if (files.length === 0) {
        alert('최소 1장의 사진을 업로드해주세요.');
        return;
    }

    if (files.length > 1) {
        alert('사진은 한 번에 1장만 업로드할 수 있습니다.');
        return;
    }

    const submitBtn = document.getElementById('gallerySubmitBtn');
    const submitText = document.getElementById('gallerySubmitText');
    const submitSpinner = document.getElementById('gallerySubmitSpinner');
    const setLoading = (on) => {
        submitBtn.disabled = on;
        if (submitText) submitText.style.display = on ? 'none' : '';
        if (submitSpinner) submitSpinner.style.display = on ? '' : 'none';
    };

    setLoading(true);
    let imageDataUrls = [];
    let optimisticId = '';
    try {
        imageDataUrls = await Promise.all(files.map((file) => compressImageFileToDataUrl(file)));

        optimisticId = `optimistic-${Date.now()}`;
        const optimisticPost = {
            id: optimisticId,
            authorName: currentUser.name || '익명',
            authorEmail: currentUser.email || '',
            description: description,
            images: imageDataUrls,
            date: new Date().toISOString(),
            optimistic: true
        };
        currentGalleryPosts = [optimisticPost, ...currentGalleryPosts];
        renderGalleryPosts();

        if (!isGalleryRemoteAvailable) {
            throw new Error('gallery_posts table unavailable');
        }

        const payload = {
            authorName: currentUser.name || '익명',
            authorEmail: currentUser.email || '',
            description: description,
            images: JSON.stringify(imageDataUrls),
            date: new Date().toISOString()
        };

        const response = await fetch('tables/gallery_posts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`갤러리 등록 실패 (${response.status})`);
        }

        let serverPost = null;
        try {
            const json = await response.json();
            serverPost = (json && (json.data || json)) || null;
        } catch (_) {
            serverPost = null;
        }

        if (serverPost && serverPost.id) {
            currentGalleryPosts = currentGalleryPosts.map((post) => (
                post.id === optimisticId
                    ? {
                        ...serverPost,
                        images: serverPost.images || imageDataUrls,
                        authorName: serverPost.authorName || currentUser.name || '익명',
                        authorEmail: serverPost.authorEmail || currentUser.email || '',
                        description: serverPost.description || description
                    }
                    : post
            ));
            renderGalleryPosts();
        } else {
            // 서버 반영 지연 대비: UI 즉시 유지하고 약간 지연 후 동기화
            setTimeout(() => loadGalleryPosts(true), 1500);
        }

        document.getElementById('galleryForm').reset();
        clearGalleryUploadPreview();
        showToast(translations[currentLanguage].gallery_save_success);
    } catch (error) {
        if (optimisticId) {
            currentGalleryPosts = currentGalleryPosts.filter((post) => post.id !== optimisticId);
            renderGalleryPosts();
        }
        const errorMessage = String(error && error.message ? error.message : error);
        const isTableMissing = errorMessage.includes('no such table: gallery_posts') || errorMessage.includes('gallery_posts table unavailable');
        const isImageProcessingIssue =
            isImageReadErrorMessage(errorMessage) ||
            errorMessage.includes('HEIC 변환') ||
            errorMessage.includes('이미지 처리 중 오류') ||
            errorMessage.includes('이미지 캔버스 처리 실패');

        if (isImageProcessingIssue) {
            console.warn('[GALLERY] 이미지 처리 실패:', error);
            alert(`사진 업로드 실패:\n\n${getGalleryUploadFriendlyMessage(error, files[0])}\n\n같은 사진이 계속 실패하면 JPG 파일로 변환 후 다시 시도해주세요.`);
            return;
        }

        if (isTableMissing) {
            isGalleryRemoteAvailable = false;
            console.warn('[GALLERY] gallery_posts 테이블 없음, 로컬 저장.');
        } else {
            console.error('[GALLERY] 서버 저장 실패:', error);
            // 서버 저장 실패 시 사용자에게 알리고 중단 (로컬에만 저장하면 다른 기기에서 안 보임)
            alert(`사진 서버 저장 실패: ${errorMessage}\n\n잠시 후 다시 시도해 주세요.`);
            return;
        }

        // 테이블 미존재인 경우에만 로컬 임시저장
        const localPost = {
            id: `local-${Date.now()}`,
            authorName: currentUser.name || '익명',
            authorEmail: currentUser.email || '',
            description: description,
            images: imageDataUrls,
            date: new Date().toISOString(),
            localOnly: true
        };
        addLocalGalleryPost(localPost);

        document.getElementById('galleryForm').reset();
        clearGalleryUploadPreview();
        showToast('⚠️ 서버 미연결 — 이 기기에만 임시 저장됩니다.');
        await loadGalleryPosts();
    } finally {
        setLoading(false);
    }
}

// 공지사항 로드
async function loadNotices() {
    try {
        console.log('[API] 공지사항 로드 시작...');
        const response = await fetchWithRetry('tables/notices?limit=50&sort=-created_at');
        
        console.log('[API] 공지사항 응답 상태:', response.status, response.statusText);
        
        const data = await response.json();
        console.log('[API] 공지사항 데이터:', data);
        currentNotices = data.data || [];
        renderNotices();
    } catch (error) {
        console.error('[ERROR] 공지사항을 불러오는 중 오류 발생:', error);
        document.getElementById('noticeList').innerHTML = 
            `<div class="loading">❌ 공지사항을 불러오는 중 오류가 발생했습니다.<br><small>오류: ${error.message}</small></div>`;
    }
}

// 공지사항 렌더링
async function renderNotices() {
    const noticeList = document.getElementById('noticeList');
    const t = translations[currentLanguage];
    
    if (currentNotices.length === 0) {
        noticeList.innerHTML = `<div class="loading">${t.notices_empty}</div>`;
        return;
    }
    
    // 로딩 표시
    if (currentLanguage === 'en') {
        noticeList.innerHTML = `<div class="loading">Translating notices...</div>`;
    }
    
    // 관리자 확인
    const isAdmin = currentUser && isUserAdmin(currentUser);
    
    // 각 공지사항을 번역하고 HTML 생성
    const translatedNotices = await Promise.all(currentNotices.map(async (notice) => {
        // 제목과 내용 번역
        const displayTitle = await getTranslatedContent(notice.title, currentLanguage);
        const displayContent = await getTranslatedContent(notice.content, currentLanguage);
        
        return `
        <div class="notice-item fade-in-up" data-id="${notice.id}">
            <div class="item-header">
                <div>
                    <h3 class="item-title">${escapeHtml(displayTitle)}</h3>
                    <div class="item-meta">
                        <span><i class="fas fa-calendar"></i> ${formatDate(notice.created_at)}</span>
                    </div>
                </div>
                ${notice.isImportant ? `<span class="notice-badge">${t.notices_badge}</span>` : ''}
            </div>
            <p class="item-content">${escapeHtml(displayContent)}</p>
            ${isAdmin ? `
                <div class="item-actions">
                    <button class="action-button edit" onclick="editNotice('${notice.id}')">
                        <i class="fas fa-edit"></i> ${t.btn_edit}
                    </button>
                    <button class="action-button delete" onclick="deleteNotice('${notice.id}')">
                        <i class="fas fa-trash"></i> ${t.btn_delete}
                    </button>
                </div>
            ` : ''}
        </div>
    `;
    }));
    
    noticeList.innerHTML = translatedNotices.join('');
}

// 공지사항 제출 처리 (관리자 전용)
async function handleNoticeSubmit(e) {
    e.preventDefault();
    
    // 관리자 확인
    if (!currentUser || !isUserAdmin(currentUser)) {
        alert('관리자만 공지사항을 작성할 수 있습니다.');
        return;
    }
    
    const title = document.getElementById('noticeTitle').value.trim();
    const content = document.getElementById('noticeContent').value.trim();
    const isImportant = document.getElementById('noticeImportant').checked;
    
    if (!title || !content) {
        alert('제목과 내용을 모두 입력해주세요.');
        return;
    }
    
    try {
        const response = await fetch('tables/notices', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                title: title,
                content: content,
                isImportant: isImportant,
                date: new Date().toISOString()
            })
        });
        
        if (response.ok) {
            // 폼 초기화
            document.getElementById('noticeForm').reset();
            
            // 목록 새로고침
            await loadNotices();
            
            // 성공 메시지
            alert('공지사항이 등록되었습니다! 📢');
            
            // 공지사항 목록으로 스크롤
            document.querySelector('.notice-list').scrollIntoView({ behavior: 'smooth' });
        } else {
            throw new Error('등록 실패');
        }
    } catch (error) {
        console.error('공지사항 등록 오류:', error);
        alert('공지사항 등록 중 오류가 발생했습니다.');
    }
}

// 공지사항 수정 (관리자 전용)
function editNotice(id) {
    // 관리자 확인
    if (!currentUser || !isUserAdmin(currentUser)) {
        alert('관리자만 공지사항을 수정할 수 있습니다.');
        return;
    }
    
    // 공지사항 찾기
    const notice = currentNotices.find(n => n.id === id);
    if (!notice) {
        alert('공지사항을 찾을 수 없습니다.');
        return;
    }
    
    // 모달에 데이터 채우기
    document.getElementById('editNoticeId').value = notice.id;
    document.getElementById('editNoticeTitle').value = notice.title;
    document.getElementById('editNoticeContent').value = notice.content;
    document.getElementById('editNoticeImportant').checked = notice.isImportant || false;
    
    // 모달 표시
    document.getElementById('editNoticeModal').style.display = 'flex';
}

// 공지사항 수정 모달 닫기
function closeEditNoticeModal() {
    document.getElementById('editNoticeModal').style.display = 'none';
    document.getElementById('editNoticeForm').reset();
}

// 공지사항 수정 제출 처리
async function handleEditNoticeSubmit(e) {
    e.preventDefault();
    
    // 관리자 확인
    if (!currentUser || !isUserAdmin(currentUser)) {
        alert('관리자만 공지사항을 수정할 수 있습니다.');
        return;
    }
    
    const id = document.getElementById('editNoticeId').value;
    const title = document.getElementById('editNoticeTitle').value.trim();
    const content = document.getElementById('editNoticeContent').value.trim();
    const isImportant = document.getElementById('editNoticeImportant').checked;
    
    if (!title || !content) {
        alert('제목과 내용을 모두 입력해주세요.');
        return;
    }
    
    try {
        // 기존 공지사항 데이터 가져오기
        const existingResponse = await fetch(`tables/notices/${id}`);
        if (!existingResponse.ok) {
            throw new Error('공지사항을 찾을 수 없습니다.');
        }
        const existingNotice = await existingResponse.json();
        
        // PUT 메서드로 전체 데이터 업데이트
        const response = await fetch(`tables/notices/${id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                title: title,
                content: content,
                isImportant: isImportant,
                date: existingNotice.date || new Date().toISOString()
            })
        });
        
        if (response.ok) {
            // 모달 닫기
            closeEditNoticeModal();
            
            // 목록 새로고침
            await loadNotices();
            
            // 성공 메시지
            showToast('공지사항이 수정되었습니다! 📝');
        } else {
            throw new Error('수정 실패');
        }
    } catch (error) {
        console.error('공지사항 수정 오류:', error);
        alert('공지사항 수정 중 오류가 발생했습니다.');
    }
}

// 공지사항 삭제 (관리자 전용)
async function deleteNotice(id) {
    console.log('deleteNotice 호출됨:', id); // 디버그용
    
    // 관리자 확인
    if (!currentUser || !isUserAdmin(currentUser)) {
        alert('관리자만 공지사항을 삭제할 수 있습니다.');
        return;
    }
    
    if (!await showConfirm('이 공지사항을 삭제하시겠습니까?')) return;
    
    try {
        const response = await fetch(`tables/notices/${id}`, {
            method: 'DELETE'
        });
        
        if (response.ok || response.status === 204) {
            await loadNotices();
            showToast('공지사항이 삭제되었습니다.');
        } else {
            throw new Error(`삭제 실패: ${response.status}`);
        }
    } catch (error) {
        console.error('공지사항 삭제 오류:', error);
        alert('삭제 중 오류가 발생했습니다: ' + error.message);
    }
}

// 전역으로 함수 등록
window.deleteNotice = deleteNotice;
window.editNotice = editNotice;
window.closeEditNoticeModal = closeEditNoticeModal;

// 관리자 데이터 로드
async function loadAdminData() {
    // 회원 목록이 없으면 로드
    if (currentMembers.length === 0) {
        await loadMembers();
    }
    
    // 회원 목록 로드 (관리자 페이지용)
    const adminMemberList = document.getElementById('adminMemberList');
    if (adminMemberList) {
        renderAdminMembers();
    }
    
    // 통계 업데이트
    updateAdminStats();
}

// 관리자 페이지 회원 목록 렌더링
function renderAdminMembers() {
    const adminMemberList = document.getElementById('adminMemberList');
    if (!adminMemberList) return;
    
    adminMemberList.innerHTML = currentMembers.map(member => {
        // 관리자 여부 확인
        const isMemberAdmin = isUserAdmin(member);
        
        return `
        <div class="member-card fade-in-up ${isMemberAdmin ? 'admin-member' : ''}" data-id="${member.id}">
            <div class="member-card-header">
                <div class="member-name">
                    <div class="member-name-text">${escapeHtml(member.name)}</div>
                    ${isMemberAdmin ? '<div class="member-role-row"><span class="inline-badge">🙏 기도인도자</span><span class="inline-badge">👑 관리자</span></div>' : ''}
                </div>
            </div>
            <div class="member-info">
                <div class="member-info-item">
                    <i class="fas fa-venus-mars"></i>
                    <span>${member.gender === 'male' ? '남성' : '여성'}</span>
                </div>
                <div class="member-info-item">
                    <i class="fas fa-phone"></i>
                    <span>${escapeHtml(member.phone)}</span>
                </div>
                <div class="member-info-item">
                    <i class="fas fa-envelope"></i>
                    <span>${escapeHtml(member.email || '미입력')}</span>
                </div>
                <div class="member-info-item">
                    <i class="fas fa-church"></i>
                    <span>${escapeHtml(member.church)}</span>
                </div>
                <div class="member-info-item">
                    <i class="fas fa-calendar"></i>
                    <span>${formatDate(member.created_at)}</span>
                </div>
            </div>
            <div class="member-actions">
                <button class="action-button delete" onclick="deleteMember('${member.id}')">
                    <i class="fas fa-trash"></i> 삭제
                </button>
            </div>
        </div>
    `;}).join('');
}

// 관리자 통계 업데이트
function updateAdminStats() {
    const totalMembersEl = document.getElementById('totalMembers');
    const totalPrayersEl = document.getElementById('totalPrayers');
    const totalTestimoniesEl = document.getElementById('totalTestimonies');
    const totalNoticesEl = document.getElementById('totalNotices');
    
    if (totalMembersEl) totalMembersEl.textContent = currentMembers.length;
    if (totalPrayersEl) totalPrayersEl.textContent = currentPrayers.length;
    if (totalTestimoniesEl) totalTestimoniesEl.textContent = currentTestimonies.length;
    if (totalNoticesEl) totalNoticesEl.textContent = currentNotices.length;
}

// 유틸리티 함수들

// HTML 이스케이프
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 날짜 포맷팅
function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return '방금 전';
    if (diffMins < 60) return `${diffMins}분 전`;
    if (diffHours < 24) return `${diffHours}시간 전`;
    if (diffDays < 7) return `${diffDays}일 전`;
    
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 토스트 메시지 표시
function showToast(message) {
    // 기존 토스트 제거
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
        existingToast.remove();
    }
    
    // 새 토스트 생성
    const toast = document.createElement('div');
    toast.className = 'toast toast-enter';
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    // 3초 후 제거
    setTimeout(() => {
        toast.classList.remove('toast-enter');
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// 스크롤 버튼 설정
function setupScrollButton() {
    const scrollBtn = document.getElementById('scrollTopBtn');
    
    window.addEventListener('scroll', () => {
        if (window.pageYOffset > 300) {
            scrollBtn.classList.add('show');
        } else {
            scrollBtn.classList.remove('show');
        }
    });
}

// 맨 위로 스크롤
function scrollToTop() {
    window.scrollTo({
        top: 0,
        behavior: 'smooth'
    });
}

// ==========================================
// 데이터 관리 기능 (백업 & 복원)
// ==========================================

// 전체 데이터 내보내기
async function exportAllData() {
    if (!currentUser || !isUserAdmin(currentUser)) {
        alert('관리자만 데이터를 내보낼 수 있습니다.');
        return;
    }
    
    showOperationStatus('데이터를 수집하는 중...', 'info');
    
    try {
        // 모든 테이블 데이터 가져오기 (limit을 1000으로 줄임)
        const [membersRes, prayersRes, testimoniesRes, noticesRes] = await Promise.all([
            fetch('tables/members?limit=1000&sort=-created_at'),
            fetch('tables/prayers?limit=1000&sort=-created_at'),
            fetch('tables/testimonies?limit=1000&sort=-created_at'),
            fetch('tables/notices?limit=1000&sort=-created_at')
        ]);
        
        if (!membersRes.ok || !prayersRes.ok || !testimoniesRes.ok || !noticesRes.ok) {
            throw new Error('데이터를 불러오는 중 오류가 발생했습니다.');
        }
        
        const members = await membersRes.json();
        const prayers = await prayersRes.json();
        const testimonies = await testimoniesRes.json();
        const notices = await noticesRes.json();
        
        const exportData = {
            exportDate: new Date().toISOString(),
            exportedBy: currentUser.name,
            version: '1.0',
            data: {
                members: members.data || [],
                prayers: prayers.data || [],
                testimonies: testimonies.data || [],
                notices: notices.data || []
            },
            statistics: {
                totalMembers: (members.data || []).length,
                totalPrayers: (prayers.data || []).length,
                totalTestimonies: (testimonies.data || []).length,
                totalNotices: (notices.data || []).length
            }
        };
        
        downloadJSON(exportData, `보좌앞에서_전체백업_${formatDateForFilename()}.json`);
        showOperationStatus(`✅ 전체 데이터 내보내기 완료! (총 ${exportData.statistics.totalMembers + exportData.statistics.totalPrayers + exportData.statistics.totalTestimonies + exportData.statistics.totalNotices}개 항목)`, 'success');
        
    } catch (error) {
        console.error('데이터 내보내기 오류:', error);
        showOperationStatus(`❌ 오류: ${error.message}`, 'error');
    }
}

// 회원 데이터만 내보내기
async function exportMembers() {
    if (!currentUser || !isUserAdmin(currentUser)) {
        alert('관리자만 데이터를 내보낼 수 있습니다.');
        return;
    }
    
    showOperationStatus('회원 데이터를 수집하는 중...', 'info');
    
    try {
        const response = await fetch('tables/members?limit=10000');
        const data = await response.json();
        
        const exportData = {
            exportDate: new Date().toISOString(),
            exportedBy: currentUser.name,
            dataType: 'members',
            data: data.data || []
        };
        
        downloadJSON(exportData, `회원목록_${formatDateForFilename()}.json`);
        showOperationStatus(`✅ 회원 데이터 내보내기 완료! (${exportData.data.length}명)`, 'success');
        
    } catch (error) {
        console.error('회원 데이터 내보내기 오류:', error);
        showOperationStatus(`❌ 오류: ${error.message}`, 'error');
    }
}

// 기도 제목만 내보내기
async function exportPrayers() {
    if (!currentUser || !isUserAdmin(currentUser)) {
        alert('관리자만 데이터를 내보낼 수 있습니다.');
        return;
    }
    
    showOperationStatus('기도 제목 데이터를 수집하는 중...', 'info');
    
    try {
        const response = await fetch('tables/prayers?limit=10000');
        const data = await response.json();
        
        const exportData = {
            exportDate: new Date().toISOString(),
            exportedBy: currentUser.name,
            dataType: 'prayers',
            data: data.data || []
        };
        
        downloadJSON(exportData, `기도제목_${formatDateForFilename()}.json`);
        showOperationStatus(`✅ 기도 제목 내보내기 완료! (${exportData.data.length}개)`, 'success');
        
    } catch (error) {
        console.error('기도 제목 내보내기 오류:', error);
        showOperationStatus(`❌ 오류: ${error.message}`, 'error');
    }
}

// 간증만 내보내기
async function exportTestimonies() {
    if (!currentUser || !isUserAdmin(currentUser)) {
        alert('관리자만 데이터를 내보낼 수 있습니다.');
        return;
    }
    
    showOperationStatus('간증 데이터를 수집하는 중...', 'info');
    
    try {
        const response = await fetch('tables/testimonies?limit=10000');
        const data = await response.json();
        
        const exportData = {
            exportDate: new Date().toISOString(),
            exportedBy: currentUser.name,
            dataType: 'testimonies',
            data: data.data || []
        };
        
        downloadJSON(exportData, `간증_${formatDateForFilename()}.json`);
        showOperationStatus(`✅ 간증 내보내기 완료! (${exportData.data.length}개)`, 'success');
        
    } catch (error) {
        console.error('간증 내보내기 오류:', error);
        showOperationStatus(`❌ 오류: ${error.message}`, 'error');
    }
}

// 공지사항만 내보내기
async function exportNotices() {
    if (!currentUser || !isUserAdmin(currentUser)) {
        alert('관리자만 데이터를 내보낼 수 있습니다.');
        return;
    }
    
    showOperationStatus('공지사항 데이터를 수집하는 중...', 'info');
    
    try {
        const response = await fetch('tables/notices?limit=10000');
        const data = await response.json();
        
        const exportData = {
            exportDate: new Date().toISOString(),
            exportedBy: currentUser.name,
            dataType: 'notices',
            data: data.data || []
        };
        
        downloadJSON(exportData, `공지사항_${formatDateForFilename()}.json`);
        showOperationStatus(`✅ 공지사항 내보내기 완료! (${exportData.data.length}개)`, 'success');
        
    } catch (error) {
        console.error('공지사항 내보내기 오류:', error);
        showOperationStatus(`❌ 오류: ${error.message}`, 'error');
    }
}

// JSON 파일 다운로드
function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// 파일명용 날짜 포맷
function formatDateForFilename() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `${year}${month}${day}_${hour}${minute}`;
}

// 데이터 가져오기 (파일 선택 처리)
async function handleImportFile(event) {
    console.log('[IMPORT] 파일 가져오기 시작');
    
    if (!currentUser || !isUserAdmin(currentUser)) {
        console.error('[IMPORT] 관리자 권한 없음:', currentUser);
        alert('관리자만 데이터를 가져올 수 있습니다.');
        return;
    }
    
    console.log('[IMPORT] 관리자 확인 완료:', currentUser.name);
    
    const file = event.target.files[0];
    if (!file) {
        console.error('[IMPORT] 파일이 선택되지 않음');
        return;
    }
    
    console.log('[IMPORT] 파일 선택됨:', file.name, 'Size:', file.size, 'bytes');
    
    if (!file.name.endsWith('.json')) {
        showOperationStatus('❌ JSON 파일만 가져올 수 있습니다.', 'error');
        return;
    }
    
    showOperationStatus('파일을 읽는 중...', 'info');
    
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            console.log('[IMPORT] 파일 읽기 완료, 파싱 시작...');
            const importData = JSON.parse(e.target.result);
            console.log('[IMPORT] JSON 파싱 완료:', importData);
            console.log('[IMPORT] 데이터 구조:', {
                hasData: !!importData.data,
                members: (importData.data?.members || []).length,
                prayers: (importData.data?.prayers || []).length,
                testimonies: (importData.data?.testimonies || []).length,
                notices: (importData.data?.notices || []).length
            });
            await processImportData(importData);
        } catch (error) {
            console.error('[IMPORT] 파일 읽기 오류:', error);
            showOperationStatus(`❌ 파일 형식 오류: ${error.message}`, 'error');
        }
    };
    
    reader.onerror = (error) => {
        console.error('[IMPORT] FileReader 오류:', error);
        showOperationStatus('❌ 파일 읽기 실패', 'error');
    };
    
    reader.readAsText(file);
    
    // 파일 입력 초기화
    event.target.value = '';
}

// 가져온 데이터 처리
async function processImportData(importData) {
    console.log('[IMPORT] processImportData 시작');
    console.log('[IMPORT] importData:', importData);
    
    if (!importData || !importData.data) {
        console.error('[IMPORT] 데이터 형식 오류 - importData.data가 없음:', importData);
        showOperationStatus('❌ 올바르지 않은 데이터 형식입니다.', 'error');
        return;
    }
    
    const totalItems = 
        (importData.data.members || []).length +
        (importData.data.prayers || []).length +
        (importData.data.testimonies || []).length +
        (importData.data.notices || []).length;
    
    console.log('[IMPORT] 총 항목 수:', totalItems);
    
    if (totalItems === 0) {
        console.warn('[IMPORT] 가져올 데이터가 없음');
        showOperationStatus('❌ 가져올 데이터가 없습니다.', 'error');
        return;
    }
    
    const confirmMessage = 
        `다음 데이터를 가져오시겠습니까?\n\n` +
        `회원: ${(importData.data.members || []).length}명\n` +
        `기도 제목: ${(importData.data.prayers || []).length}개\n` +
        `간증: ${(importData.data.testimonies || []).length}개\n` +
        `공지사항: ${(importData.data.notices || []).length}개\n` +
        `총: ${totalItems}개\n\n` +
        `⚠️ 주의: 이 작업은 시간이 걸릴 수 있습니다.`;
    
    console.log('[IMPORT] 확인 메시지 표시');
    const confirmation = confirm(confirmMessage);
    
    if (!confirmation) {
        console.log('[IMPORT] 사용자가 취소함');
        showOperationStatus('가져오기가 취소되었습니다.', 'info');
        return;
    }
    
    console.log('[IMPORT] 사용자 확인 완료, 업로드 시작');
    showOperationStatus(`데이터를 업로드하는 중... (0/${totalItems})`, 'info');
    
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let processedCount = 0;
    
    const startTime = Date.now();
    
    // 시스템 필드 제거 헬퍼 함수
    const cleanSystemFields = (data) => {
        const cleaned = { ...data };
        
        // 제거할 시스템 필드 목록
        const systemFields = [
            'id',
            'gs_project_id',
            'gs_table_name',
            'created_at',
            'updated_at',
            '_rid',
            '_self',
            '_etag',
            '_attachments',
            '_ts',
            'deleted',
            'deleted_at'
        ];
        
        systemFields.forEach(field => delete cleaned[field]);
        
        return cleaned;
    };
    
    try {
        // 회원 데이터 가져오기
        if (importData.data.members && importData.data.members.length > 0) {
            console.log('[IMPORT] 회원 데이터 가져오기 시작:', importData.data.members.length, '명');
            for (const member of importData.data.members) {
                try {
                    // 시스템 필드 제거
                    const memberData = cleanSystemFields(member);
                    
                    console.log('[IMPORT] 회원 데이터 준비:', memberData);
                    
                    // 진행 상황 업데이트
                    processedCount++;
                    showOperationStatus(`데이터를 업로드하는 중... (${processedCount}/${totalItems})`, 'info');
                    
                    console.log('[IMPORT] 회원 POST 요청 시작:', memberData.name || memberData.email);
                    const response = await fetch('tables/members', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(memberData)
                    });
                    
                    console.log('[IMPORT] 회원 POST 응답:', response.status, response.statusText);
                    
                    if (response.ok) {
                        const responseData = await response.json();
                        successCount++;
                        console.log('[IMPORT] ✅ 회원 추가 성공:', memberData.name, 'ID:', responseData.id);
                    } else {
                        const errorText = await response.text();
                        console.error('[IMPORT] ❌ 회원 추가 실패:', memberData.name, response.status, errorText);
                        errorCount++;
                    }
                } catch (error) {
                    console.error('[IMPORT] 회원 추가 예외:', member.name, error);
                    errorCount++;
                    processedCount++;
                }
                
                // 너무 빠른 요청 방지 (50ms 대기)
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            console.log('[IMPORT] 회원 데이터 처리 완료');
        }
        
        // 기도 제목 가져오기
        if (importData.data.prayers && importData.data.prayers.length > 0) {
            console.log('[IMPORT] 기도 제목 가져오기 시작:', importData.data.prayers.length, '개');
            for (const prayer of importData.data.prayers) {
                try {
                    // 시스템 필드 제거
                    const prayerData = cleanSystemFields(prayer);
                    
                    console.log('[IMPORT] 기도 제목 추가:', prayerData.title);
                    
                    // 진행 상황 업데이트
                    processedCount++;
                    showOperationStatus(`데이터를 업로드하는 중... (${processedCount}/${totalItems})`, 'info');
                    
                    const response = await fetch('tables/prayers', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(prayerData)
                    });
                    
                    if (response.ok) {
                        successCount++;
                        console.log('[IMPORT] ✅ 기도 제목 추가 성공:', prayerData.title);
                    } else {
                        const errorText = await response.text();
                        console.error('[IMPORT] ❌ 기도 제목 추가 실패:', prayerData.title, response.status, errorText);
                        errorCount++;
                    }
                } catch (error) {
                    console.error('[IMPORT] 기도 제목 추가 오류:', prayer.title, error);
                    errorCount++;
                    processedCount++;
                }
            }
        }
        
        // 간증 가져오기
        if (importData.data.testimonies && importData.data.testimonies.length > 0) {
            console.log('[IMPORT] 간증 가져오기 시작:', importData.data.testimonies.length, '개');
            for (const testimony of importData.data.testimonies) {
                try {
                    // 시스템 필드 제거
                    const testimonyData = cleanSystemFields(testimony);
                    
                    console.log('[IMPORT] 간증 추가:', testimonyData.title);
                    
                    // 진행 상황 업데이트
                    processedCount++;
                    showOperationStatus(`데이터를 업로드하는 중... (${processedCount}/${totalItems})`, 'info');
                    
                    const response = await fetch('tables/testimonies', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(testimonyData)
                    });
                    
                    if (response.ok) {
                        successCount++;
                        console.log('[IMPORT] ✅ 간증 추가 성공:', testimonyData.title);
                    } else {
                        const errorText = await response.text();
                        console.error('[IMPORT] ❌ 간증 추가 실패:', testimonyData.title, response.status, errorText);
                        errorCount++;
                    }
                } catch (error) {
                    console.error('[IMPORT] 간증 추가 오류:', testimony.title, error);
                    errorCount++;
                    processedCount++;
                }
            }
        }
        
        // 공지사항 가져오기
        if (importData.data.notices && importData.data.notices.length > 0) {
            console.log('[IMPORT] 공지사항 가져오기 시작:', importData.data.notices.length, '개');
            for (const notice of importData.data.notices) {
                try {
                    // 시스템 필드 제거
                    const noticeData = cleanSystemFields(notice);
                    
                    console.log('[IMPORT] 공지사항 추가:', noticeData.title);
                    
                    // 진행 상황 업데이트
                    processedCount++;
                    showOperationStatus(`데이터를 업로드하는 중... (${processedCount}/${totalItems})`, 'info');
                    
                    const response = await fetch('tables/notices', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(noticeData)
                    });
                    
                    if (response.ok) {
                        successCount++;
                        console.log('[IMPORT] ✅ 공지사항 추가 성공:', noticeData.title);
                    } else {
                        const errorText = await response.text();
                        console.error('[IMPORT] ❌ 공지사항 추가 실패:', noticeData.title, response.status, errorText);
                        errorCount++;
                    }
                } catch (error) {
                    console.error('[IMPORT] 공지사항 추가 오류:', notice.title, error);
                    errorCount++;
                    processedCount++;
                }
            }
        }
        
        // 데이터 새로고침
        console.log('[IMPORT] 데이터 새로고침 시작...');
        await loadMembers();
        await loadPrayers();
        await loadTestimonies();
        await loadGalleryPosts();
        await loadNotices();
        updateAdminStats();
        
        const endTime = Date.now();
        const duration = ((endTime - startTime) / 1000).toFixed(1);
        
        console.log('[IMPORT] 완료! 소요시간:', duration, '초');
        console.log('[IMPORT] 성공:', successCount, '실패:', errorCount);
        
        const resultMessage = 
            `✅ 데이터 가져오기 완료!\n\n` +
            `성공: ${successCount}개\n` +
            `실패: ${errorCount}개\n` +
            `소요시간: ${duration}초\n\n` +
            `💡 페이지를 새로고침하여 최신 데이터를 확인하세요.`;
        
        showOperationStatus(resultMessage, errorCount > 0 ? 'error' : 'success');
        
        // 성공한 항목이 있으면 새로고침 권장
        if (successCount > 0) {
            console.log('[IMPORT] 새로고침 권장 메시지 표시');
            setTimeout(() => {
                const shouldReload = confirm(
                    `데이터가 성공적으로 업로드되었습니다! (${successCount}개)\n\n` +
                    `페이지를 새로고침하여 최신 데이터를 확인하시겠습니까?\n\n` +
                    `※ 새로고침하지 않으면 일부 데이터가 표시되지 않을 수 있습니다.`
                );
                
                if (shouldReload) {
                    console.log('[IMPORT] 페이지 새로고침 시작');
                    location.reload();
                } else {
                    console.log('[IMPORT] 사용자가 새로고침 거부, 수동 데이터 로드 재시도');
                    // 새로고침을 거부한 경우 다시 한 번 데이터 로드 시도
                    loadMembers();
                    loadPrayers();
                    loadTestimonies();
                    loadGalleryPosts();
                    loadNotices();
                    updateAdminStats();
                }
            }, 1500);
        } else if (errorCount > 0) {
            console.error('[IMPORT] 모든 항목 업로드 실패');
            alert('데이터 업로드에 실패했습니다.\n\nF12 키를 눌러 콘솔에서 오류 내용을 확인하세요.');
        }
        
    } catch (error) {
        console.error('데이터 가져오기 오류:', error);
        showOperationStatus(`❌ 오류: ${error.message}`, 'error');
    }
}

// 작업 상태 표시
function showOperationStatus(message, type) {
    const statusDiv = document.getElementById('dataOperationStatus');
    if (!statusDiv) return;
    
    statusDiv.textContent = message;
    statusDiv.className = `operation-status ${type}`;
    statusDiv.style.display = 'block';
    
    // 자동으로 숨기기 (성공/오류 메시지만)
    if (type === 'success' || type === 'error') {
        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 5000);
    }
}

// ====================================
// 이메일 알림 관련 함수
// ====================================

// 이메일 모달 열기
async function openEmailModal() {
    console.log('========================================');
    console.log('[EMAIL] 📧 이메일 모달 열기 함수 호출됨!');
    console.log('========================================');
    
    try {
        // 현재 사용자 정보 로그
        console.log('[EMAIL] 현재 사용자:', currentUser);
        console.log('[EMAIL] 관리자 여부:', currentUser ? isUserAdmin(currentUser) : 'N/A');
        
        // 관리자 확인
        if (!currentUser || !isUserAdmin(currentUser)) {
            console.warn('[EMAIL] ⚠️ 관리자 권한 없음');
            alert('관리자만 이메일 알림을 보낼 수 있습니다.');
            return;
        }
        
        // 공지사항 제목과 내용 확인
        const titleElement = document.getElementById('noticeTitle');
        const contentElement = document.getElementById('noticeContent');
        
        console.log('[EMAIL] 제목 입력란:', titleElement);
        console.log('[EMAIL] 내용 입력란:', contentElement);
        
        const title = titleElement ? titleElement.value.trim() : '';
        const content = contentElement ? contentElement.value.trim() : '';
        
        console.log('[EMAIL] 제목:', title);
        console.log('[EMAIL] 내용:', content.substring(0, 50) + '...');
        
        if (!title || !content) {
            console.warn('[EMAIL] ⚠️ 제목 또는 내용이 비어있음');
            alert('공지사항을 먼저 작성해주세요.\n\n제목과 내용을 입력한 후 이메일 알림을 보낼 수 있습니다.');
            return;
        }
        
        // 모달 열기
        const modal = document.getElementById('emailModal');
        console.log('[EMAIL] 모달 요소 찾기:', modal);
        
        if (!modal) {
            console.error('[EMAIL] ❌ emailModal 요소를 찾을 수 없습니다!');
            alert('이메일 선택 화면을 찾을 수 없습니다. 페이지를 새로고침해주세요.');
            return;
        }
        
        console.log('[EMAIL] ✅ 모달 열기 시작');
        modal.style.display = 'flex';
        console.log('[EMAIL] 모달 display 설정:', modal.style.display);
        
        // 회원 목록 불러오기
        console.log('[EMAIL] 회원 목록 불러오기 시작...');
        await loadMembersForEmail();
        console.log('[EMAIL] ✅ 모달 열기 완료');
        
    } catch (error) {
        console.error('[EMAIL] ❌ 모달 열기 오류:', error);
        console.error('[EMAIL] 오류 스택:', error.stack);
        alert('회원 목록을 불러오는 중 오류가 발생했습니다.\n\n오류: ' + error.message);
    }
}

// 이메일 모달 닫기
function closeEmailModal() {
    const modal = document.getElementById('emailModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// 회원 목록 불러오기 (이메일 선택용)
async function loadMembersForEmail() {
    try {
        console.log('[EMAIL] 회원 목록 불러오기');
        
        const response = await fetch('tables/members?limit=1000');
        
        if (!response.ok) {
            throw new Error('회원 목록을 불러올 수 없습니다.');
        }
        
        const result = await response.json();
        const members = result.data || [];
        
        console.log(`[EMAIL] 총 ${members.length}명의 회원 확인`);
        
        // 회원 목록 렌더링
        const listContainer = document.getElementById('memberSelectionList');
        if (!listContainer) return;
        
        if (members.length === 0) {
            listContainer.innerHTML = '<p>등록된 회원이 없습니다.</p>';
            return;
        }
        
        let html = '';
        members.forEach(member => {
            const hasEmail = member.email && member.email.includes('@');
            const emailDisplay = hasEmail ? member.email : '<span class="no-email">이메일 없음</span>';
            
            html += `
                <div class="member-checkbox-item">
                    <input 
                        type="checkbox" 
                        id="member_${member.id}" 
                        value="${member.id}"
                        data-email="${member.email || ''}"
                        data-name="${member.name}"
                        ${hasEmail ? '' : 'disabled'}
                        ${hasEmail ? 'checked' : ''}
                    >
                    <label for="member_${member.id}" class="member-info">
                        <div class="name">${member.name}</div>
                        <div class="email ${hasEmail ? '' : 'no-email'}">${emailDisplay}</div>
                    </label>
                </div>
            `;
        });
        
        listContainer.innerHTML = html;
        
    } catch (error) {
        console.error('[EMAIL] 회원 목록 불러오기 오류:', error);
        const listContainer = document.getElementById('memberSelectionList');
        if (listContainer) {
            listContainer.innerHTML = '<p style="color: red;">회원 목록을 불러오는 중 오류가 발생했습니다.</p>';
        }
    }
}

// 전체 선택
function selectAllMembers() {
    const checkboxes = document.querySelectorAll('#memberSelectionList input[type="checkbox"]:not(:disabled)');
    checkboxes.forEach(checkbox => {
        checkbox.checked = true;
    });
}

// 전체 해제
function deselectAllMembers() {
    const checkboxes = document.querySelectorAll('#memberSelectionList input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
        checkbox.checked = false;
    });
}

// 선택한 회원에게 이메일 발송
async function sendSelectedEmails() {
    try {
        console.log('[EMAIL] 선택한 회원에게 이메일 발송 시작');
        
        // 선택된 회원 확인
        const checkboxes = document.querySelectorAll('#memberSelectionList input[type="checkbox"]:checked');
        
        if (checkboxes.length === 0) {
            alert('이메일을 보낼 회원을 선택해주세요.');
            return;
        }
        
        const selectedMembers = Array.from(checkboxes).map(cb => ({
            email: cb.getAttribute('data-email'),
            name: cb.getAttribute('data-name')
        }));
        
        console.log(`[EMAIL] ${selectedMembers.length}명 선택됨`);
        
        // 확인 메시지
        const title = document.getElementById('noticeTitle').value.trim();
        const confirm = window.confirm(
            `${selectedMembers.length}명의 회원에게 이메일을 보내시겠습니까?\n\n` +
            `제목: ${title}\n\n` +
            `이메일은 취소할 수 없습니다.`
        );
        
        if (!confirm) {
            return;
        }
        
        // 버튼 비활성화
        const btn = document.querySelector('.confirm-button');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '📧 전송 중...';
        }
        
        // 이메일 발송
        const content = document.getElementById('noticeContent').value.trim();
        let successCount = 0;
        let failCount = 0;
        
        for (const member of selectedMembers) {
            try {
                await emailjs.send('service_6c0rfjg', 'template_nw8j7ah', {
                    to_email: member.email,
                    member_name: member.name,
                    notice_title: title,
                    notice_content: content,
                    reply_to: 'yeonchoi08@gmail.com'
                });
                
                successCount++;
                console.log(`[EMAIL] 전송 성공: ${member.name} (${member.email})`);
                
                // API 요청 제한을 위한 짧은 딜레이
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                failCount++;
                console.error(`[EMAIL] 전송 실패: ${member.name} (${member.email})`, error);
            }
        }
        
        // 결과 메시지
        let message = `이메일 전송 완료!\n\n`;
        message += `✅ 성공: ${successCount}명\n`;
        if (failCount > 0) {
            message += `❌ 실패: ${failCount}명\n`;
        }
        message += `\n선택한 회원들의 이메일함을 확인하도록 안내해주세요.`;
        
        alert(message);
        
        // 모달 닫기
        closeEmailModal();
        
        console.log('[EMAIL] 이메일 전송 완료', { successCount, failCount });
        
    } catch (error) {
        console.error('[EMAIL] 이메일 전송 오류:', error);
        alert('이메일 전송 중 오류가 발생했습니다.\n\n' + error.message);
        
        // 버튼 원상복구
        const btn = document.querySelector('.confirm-button');
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📧 선택한 회원에게 발송';
        }
    }
}

// 기존 함수 (전체 발송) - 제거하거나 유지
async function sendEmailNotification() {
    try {
        console.log('[EMAIL] 이메일 알림 전송 시작');
        
        // 관리자 확인
        if (!currentUser || !isUserAdmin(currentUser)) {
            alert('관리자만 이메일 알림을 보낼 수 있습니다.');
            return;
        }
        
        // 공지사항 제목과 내용 가져오기
        const title = document.getElementById('noticeTitle').value.trim();
        const content = document.getElementById('noticeContent').value.trim();
        
        if (!title || !content) {
            alert('공지사항을 먼저 작성해주세요.\n\n제목과 내용을 입력한 후 이메일 알림을 보낼 수 있습니다.');
            return;
        }
        
        // 확인 메시지
        const confirm = window.confirm(
            `모든 회원에게 이메일 알림을 보내시겠습니까?\n\n` +
            `제목: ${title}\n\n` +
            `이메일은 취소할 수 없습니다.`
        );
        
        if (!confirm) {
            return;
        }
        
        // 버튼 비활성화
        const btn = document.getElementById('sendEmailBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '📧 전송 중...';
        }
        
        // 모든 회원 목록 가져오기
        console.log('[EMAIL] 회원 목록 불러오기');
        const response = await fetch('tables/members?limit=1000');
        
        if (!response.ok) {
            throw new Error('회원 목록을 불러올 수 없습니다.');
        }
        
        const result = await response.json();
        const members = result.data || [];
        
        console.log(`[EMAIL] 총 ${members.length}명의 회원 확인`);
        
        // 이메일이 있는 회원 필터링
        const membersWithEmail = members.filter(m => m.email && m.email.includes('@'));
        
        console.log(`[EMAIL] 이메일이 있는 회원: ${membersWithEmail.length}명`);
        
        if (membersWithEmail.length === 0) {
            alert('이메일이 등록된 회원이 없습니다.');
            if (btn) {
                btn.disabled = false;
                btn.textContent = '📧 이메일로 알림 보내기';
            }
            return;
        }
        
        // EmailJS로 각 회원에게 이메일 전송
        let successCount = 0;
        let failCount = 0;
        
        for (const member of membersWithEmail) {
            try {
                await emailjs.send('service_6c0rfjg', 'template_nw8j7ah', {
                    to_email: member.email,
                    member_name: member.name,
                    notice_title: title,
                    notice_content: content,
                    reply_to: 'yeonchoi08@gmail.com'
                });
                
                successCount++;
                console.log(`[EMAIL] 전송 성공: ${member.name} (${member.email})`);
                
                // API 요청 제한을 위한 짧은 딜레이
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                failCount++;
                console.error(`[EMAIL] 전송 실패: ${member.name} (${member.email})`, error);
            }
        }
        
        // 결과 메시지
        let message = `이메일 전송 완료!\n\n`;
        message += `✅ 성공: ${successCount}명\n`;
        if (failCount > 0) {
            message += `❌ 실패: ${failCount}명\n`;
        }
        message += `\n회원들의 이메일함을 확인하도록 안내해주세요.`;
        
        alert(message);
        
        // 버튼 원상복구
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📧 이메일로 알림 보내기';
        }
        
        console.log('[EMAIL] 이메일 알림 전송 완료', { successCount, failCount });
        
    } catch (error) {
        console.error('[EMAIL] 이메일 전송 오류:', error);
        alert('이메일 전송 중 오류가 발생했습니다.\n\n' + error.message);
        
        // 버튼 원상복구
        const btn = document.getElementById('sendEmailBtn');
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📧 이메일로 알림 보내기';
        }
    }
}

// ====================================
// 데이터베이스 관련 함수
// ====================================

// 데이터베이스 연결 테스트
async function testDatabaseConnection() {
    console.log('[TEST] 데이터베이스 연결 테스트 시작');
    showOperationStatus('🔍 데이터베이스 연결을 테스트하는 중...', 'info');
    
    const tests = [
        { name: '회원 테이블', url: 'tables/members?limit=1' },
        { name: '기도 제목 테이블', url: 'tables/prayers?limit=1' },
        { name: '간증 테이블', url: 'tables/testimonies?limit=1' },
        { name: '공지사항 테이블', url: 'tables/notices?limit=1' }
    ];
    
    let results = [];
    
    for (const test of tests) {
        try {
            console.log(`[TEST] ${test.name} 테스트 중...`);
            const startTime = Date.now();
            const response = await fetch(test.url);
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            if (response.ok) {
                const data = await response.json();
                results.push(`✅ ${test.name}: 정상 (${duration}ms, ${data.data?.length || 0}개)`);
                console.log(`[TEST] ✅ ${test.name} 성공:`, data);
            } else {
                const errorText = await response.text();
                results.push(`❌ ${test.name}: 실패 (${response.status})`);
                console.error(`[TEST] ❌ ${test.name} 실패:`, response.status, errorText);
            }
        } catch (error) {
            results.push(`❌ ${test.name}: 오류 (${error.message})`);
            console.error(`[TEST] ❌ ${test.name} 오류:`, error);
        }
    }
    
    const allSuccess = results.every(r => r.startsWith('✅'));
    const resultMessage = '데이터베이스 연결 테스트 결과:\n\n' + results.join('\n');
    
    console.log('[TEST] 테스트 완료:', results);
    showOperationStatus(resultMessage, allSuccess ? 'success' : 'error');
    alert(resultMessage);
}

// 샘플 데이터 업로드 테스트
async function testDataUpload() {
    console.log('[TEST] 샘플 데이터 업로드 테스트 시작');
    
    const confirmTest = confirm(
        '샘플 데이터 업로드 테스트를 진행하시겠습니까?\n\n' +
        '테스트용 기도 제목 1개를 생성합니다.\n' +
        '(나중에 삭제할 수 있습니다)'
    );
    
    if (!confirmTest) {
        console.log('[TEST] 사용자가 테스트 취소');
        return;
    }
    
    showOperationStatus('🔍 샘플 데이터 업로드 테스트 중...', 'info');
    
    const testPrayer = {
        name: '테스트 사용자',
        title: '[테스트] 데이터 업로드 테스트',
        content: '이것은 데이터 업로드 테스트용 샘플 기도 제목입니다. 성공적으로 표시되면 데이터 가져오기가 정상 작동하는 것입니다.',
        isAnonymous: false,
        prayerCount: 0,
        date: new Date().toISOString()
    };
    
    try {
        console.log('[TEST] 샘플 기도 제목 업로드:', testPrayer);
        const response = await fetch('tables/prayers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPrayer)
        });
        
        console.log('[TEST] 업로드 응답:', response.status, response.statusText);
        
        if (response.ok) {
            const data = await response.json();
            console.log('[TEST] ✅ 업로드 성공:', data);
            
            // 데이터 새로고침
            await loadPrayers();
            
            showOperationStatus(
                '✅ 샘플 데이터 업로드 성공!\n\n' +
                '기도 제목 섹션을 확인해보세요.\n' +
                '[테스트] 항목이 표시되어야 합니다.',
                'success'
            );
            
            alert(
                '✅ 테스트 성공!\n\n' +
                '샘플 기도 제목이 업로드되었습니다.\n' +
                '기도 제목 섹션에서 "[테스트]" 항목을 확인하세요.\n\n' +
                '이제 실제 데이터 가져오기를 진행할 수 있습니다.'
            );
            
            // 기도 제목 섹션으로 이동
            setTimeout(() => {
                scrollToSection('prayers');
            }, 1000);
        } else {
            const errorText = await response.text();
            console.error('[TEST] ❌ 업로드 실패:', response.status, errorText);
            
            showOperationStatus(
                `❌ 샘플 데이터 업로드 실패\n\n` +
                `상태: ${response.status}\n` +
                `오류: ${errorText}`,
                'error'
            );
            
            alert(
                '❌ 테스트 실패\n\n' +
                `상태 코드: ${response.status}\n` +
                `오류 내용: ${errorText}\n\n` +
                'F12 키를 눌러 콘솔에서 상세 오류를 확인하세요.'
            );
        }
    } catch (error) {
        console.error('[TEST] 업로드 예외:', error);
        
        showOperationStatus(`❌ 테스트 오류: ${error.message}`, 'error');
        alert(`❌ 테스트 오류\n\n${error.message}\n\nF12 키를 눌러 콘솔에서 상세 오류를 확인하세요.`);
    }
}

// 전역 함수로 등록
window.exportAllData = exportAllData;
window.exportMembers = exportMembers;
window.exportPrayers = exportPrayers;
window.exportTestimonies = exportTestimonies;
window.exportNotices = exportNotices;
window.handleImportFile = handleImportFile;
window.testDatabaseConnection = testDatabaseConnection;
window.testDataUpload = testDataUpload;

// 히어로 섹션 CTA 버튼 핸들러
function handleHeroCTA() {
    if (currentUser) {
        // 로그인 상태: 기도 제목 섹션으로 이동
        scrollToSection('prayers');
    } else {
        // 로그아웃 상태: 로그인 페이지로 이동
        scrollToSection('login');
        
        // 안내 메시지 표시
        setTimeout(() => {
            alert('기도 제목을 올리려면 먼저 로그인해주세요.\n\n회원이 아니시면 회원가입을 먼저 해주세요.');
        }, 500);
    }
}

// 전역 함수로 등록
window.handleHeroCTA = handleHeroCTA;

// ==========================================
// 모임 일정 관리 기능
// ==========================================

// 모임 일정 정보를 저장하는 전역 변수
let currentSchedule = null;

// 모임 일정 로드
async function loadSchedule() {
    console.log('[SCHEDULE] 모임 일정 로드 시작...');
    
    try {
        const response = await fetchWithRetry('tables/schedules?limit=1&sort=-created_at');
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log('[SCHEDULE] 일정 데이터:', result);
        
        if (result.data && result.data.length > 0) {
            currentSchedule = result.data[0];
            await displaySchedule(currentSchedule);
        } else {
            console.log('[SCHEDULE] 저장된 일정이 없습니다. 기본 일정 사용');
            // 기본값은 HTML에 이미 있으므로 아무것도 하지 않음
        }
    } catch (error) {
        console.error('[SCHEDULE] 일정 로드 실패:', error);
        // 오류가 발생해도 기본 HTML 값을 사용하므로 문제없음
    }
}

// 일정 화면에 표시
async function displaySchedule(schedule) {
    console.log('[SCHEDULE] 일정 화면 표시:', schedule);
    
    // 한국 오프라인 모임
    const koreaRegularTimeEl = document.getElementById('scheduleKoreaRegularTime');
    const koreaTimeDetailEl = document.getElementById('scheduleKoreaTimeDetail');
    const koreaLocationDetailEl = document.getElementById('scheduleKoreaLocationDetail');
    
    if (koreaRegularTimeEl && schedule.korea_regular_time) {
        const translatedText = await getTranslatedContent(schedule.korea_regular_time, currentLanguage);
        koreaRegularTimeEl.textContent = translatedText;
    }
    if (koreaTimeDetailEl && schedule.korea_time_detail) {
        const translatedText = await getTranslatedContent(schedule.korea_time_detail, currentLanguage);
        koreaTimeDetailEl.textContent = translatedText;
    }
    if (koreaLocationDetailEl && schedule.korea_location_detail) {
        const translatedText = await getTranslatedContent(schedule.korea_location_detail, currentLanguage);
        koreaLocationDetailEl.textContent = translatedText;
    }
    
    // 글로벌 온라인 모임
    const globalRegularTimeEl = document.getElementById('scheduleGlobalRegularTime');
    const globalTimeDetailEl = document.getElementById('scheduleGlobalTimeDetail');
    const globalMethodDetailEl = document.getElementById('scheduleGlobalMethodDetail');
    
    if (globalRegularTimeEl && schedule.global_regular_time) {
        const translatedText = await getTranslatedContent(schedule.global_regular_time, currentLanguage);
        globalRegularTimeEl.textContent = translatedText;
    }
    if (globalTimeDetailEl && schedule.global_time_detail) {
        const translatedText = await getTranslatedContent(schedule.global_time_detail, currentLanguage);
        globalTimeDetailEl.textContent = translatedText;
    }
    if (globalMethodDetailEl && schedule.global_method_detail) {
        const translatedText = await getTranslatedContent(schedule.global_method_detail, currentLanguage);
        globalMethodDetailEl.textContent = translatedText;
    }
}

// 일정 수정 모달 열기
function openScheduleEditModal() {
    console.log('[SCHEDULE] 일정 수정 모달 열기');
    console.log('[SCHEDULE] currentUser:', currentUser);
    console.log('[SCHEDULE] currentSchedule:', currentSchedule);
    
    const modal = document.getElementById('scheduleEditModal');
    if (!modal) {
        console.error('[SCHEDULE] 모달을 찾을 수 없습니다');
        alert('모달을 찾을 수 없습니다. 페이지를 새로고침해주세요.');
        return;
    }
    
    console.log('[SCHEDULE] 모달 찾음:', modal);
    
    // 현재 일정 값을 폼에 채우기
    if (currentSchedule) {
        console.log('[SCHEDULE] currentSchedule 데이터로 폼 채우기');
        document.getElementById('koreaRegularTime').value = currentSchedule.korea_regular_time || '';
        document.getElementById('koreaTimeDetail').value = currentSchedule.korea_time_detail || '';
        document.getElementById('koreaLocationDetail').value = currentSchedule.korea_location_detail || '';
        document.getElementById('globalRegularTime').value = currentSchedule.global_regular_time || '';
        document.getElementById('globalTimeDetail').value = currentSchedule.global_time_detail || '';
        document.getElementById('globalMethodDetail').value = currentSchedule.global_method_detail || '';
    } else {
        console.log('[SCHEDULE] 화면 표시 값으로 폼 채우기');
        // 화면에 표시된 현재 값을 폼에 채우기
        document.getElementById('koreaRegularTime').value = document.getElementById('scheduleKoreaRegularTime')?.textContent || '';
        document.getElementById('koreaTimeDetail').value = document.getElementById('scheduleKoreaTimeDetail')?.textContent || '';
        document.getElementById('koreaLocationDetail').value = document.getElementById('scheduleKoreaLocationDetail')?.textContent || '';
        document.getElementById('globalRegularTime').value = document.getElementById('scheduleGlobalRegularTime')?.textContent || '';
        document.getElementById('globalTimeDetail').value = document.getElementById('scheduleGlobalTimeDetail')?.textContent || '';
        document.getElementById('globalMethodDetail').value = document.getElementById('scheduleGlobalMethodDetail')?.textContent || '';
    }
    
    console.log('[SCHEDULE] 폼 값 채우기 완료');
    
    // 모달 표시
    modal.style.display = 'block';
    console.log('[SCHEDULE] 모달 display 설정:', modal.style.display);
    
    // 모달 닫기 버튼 이벤트 설정
    const closeBtn = document.getElementById('scheduleModalCloseBtn');
    if (closeBtn) {
        closeBtn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            console.log('[SCHEDULE] 닫기 버튼 클릭');
            closeScheduleEditModal();
        };
    }
    
    // 모달 배경 클릭 시 닫기
    modal.onclick = function(event) {
        if (event.target === modal) {
            console.log('[SCHEDULE] 모달 배경 클릭');
            closeScheduleEditModal();
        }
    };
    
    // 폼 제출 이벤트 리스너 설정
    const form = document.getElementById('scheduleEditForm');
    if (form) {
        // 기존 이벤트 리스너 제거 후 다시 설정
        form.removeEventListener('submit', handleScheduleSave);
        form.addEventListener('submit', handleScheduleSave);
        console.log('[SCHEDULE] 폼 제출 이벤트 리스너 설정 완료');
    } else {
        console.error('[SCHEDULE] 폼을 찾을 수 없습니다');
    }
}

// 일정 수정 모달 닫기
function closeScheduleEditModal() {
    console.log('[SCHEDULE] 일정 수정 모달 닫기');
    
    const modal = document.getElementById('scheduleEditModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// 일정 저장
async function handleScheduleSave(event) {
    event.preventDefault();
    console.log('[SCHEDULE] 일정 저장 시작');
    console.log('[SCHEDULE] 이벤트:', event);
    
    const koreaRegularTime = document.getElementById('koreaRegularTime').value.trim();
    const koreaTimeDetail = document.getElementById('koreaTimeDetail').value.trim();
    const koreaLocationDetail = document.getElementById('koreaLocationDetail').value.trim();
    const globalRegularTime = document.getElementById('globalRegularTime').value.trim();
    const globalTimeDetail = document.getElementById('globalTimeDetail').value.trim();
    const globalMethodDetail = document.getElementById('globalMethodDetail').value.trim();
    
    console.log('[SCHEDULE] 입력 값:', {
        koreaRegularTime,
        koreaTimeDetail,
        koreaLocationDetail,
        globalRegularTime,
        globalTimeDetail,
        globalMethodDetail
    });
    
    // 유효성 검사
    if (!koreaRegularTime && !globalRegularTime) {
        alert('최소한 한 개 이상의 모임 정보를 입력해주세요.');
        console.warn('[SCHEDULE] 유효성 검사 실패: 모임 정보 없음');
        return;
    }
    
    const scheduleData = {
        korea_regular_time: koreaRegularTime,
        korea_time_detail: koreaTimeDetail,
        korea_location_detail: koreaLocationDetail,
        global_regular_time: globalRegularTime,
        global_time_detail: globalTimeDetail,
        global_method_detail: globalMethodDetail,
        updated_by: currentUser ? currentUser.name : '관리자',
        date: new Date().toISOString()
    };
    
    console.log('[SCHEDULE] 저장할 일정 데이터:', scheduleData);
    
    try {
        console.log('[SCHEDULE] API 호출 시작...');
        const response = await fetch('tables/schedules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(scheduleData)
        });
        
        console.log('[SCHEDULE] API 응답 상태:', response.status, response.statusText);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[SCHEDULE] API 오류 응답:', errorText);
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const savedSchedule = await response.json();
        console.log('[SCHEDULE] ✅ 일정 저장 성공:', savedSchedule);
        
        // 현재 일정 업데이트
        currentSchedule = savedSchedule;
        
        // 화면에 표시
        displaySchedule(savedSchedule);
        
        // 모달 닫기
        closeScheduleEditModal();
        
        // 성공 메시지
        showToast('모임 일정이 성공적으로 저장되었습니다! ✅');
        alert('모임 일정이 성공적으로 저장되었습니다! ✅');
        
    } catch (error) {
        console.error('[SCHEDULE] ❌ 일정 저장 실패:', error);
        alert(`일정 저장에 실패했습니다.\n\n오류: ${error.message}\n\nF12를 눌러 콘솔에서 상세 내용을 확인하세요.`);
    }
}

// 관리자 권한에 따라 일정 수정 버튼 표시/숨김
function updateScheduleAdminControls() {
    const adminControls = document.getElementById('scheduleAdminControls');
    
    console.log('[SCHEDULE] 관리자 컨트롤 업데이트');
    console.log('[SCHEDULE] adminControls 요소:', adminControls);
    console.log('[SCHEDULE] currentUser:', currentUser);
    
    if (adminControls) {
        if (currentUser && currentUser.isAdmin) {
            adminControls.style.display = 'block';
            console.log('[SCHEDULE] ✅ 관리자 - 일정 수정 버튼 표시');
        } else {
            adminControls.style.display = 'none';
            console.log('[SCHEDULE] ❌ 비관리자 - 일정 수정 버튼 숨김');
        }
    } else {
        console.error('[SCHEDULE] scheduleAdminControls 요소를 찾을 수 없습니다');
    }
}

// 전역 함수로 등록
window.openScheduleEditModal = openScheduleEditModal;
window.closeScheduleEditModal = closeScheduleEditModal;
window.handleScheduleSave = handleScheduleSave;

