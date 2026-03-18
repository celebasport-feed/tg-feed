(function () {
  'use strict';

  const CFG = { postsUrl:'data/posts.json', channelUrl:'data/channel.json', perPage:15, locale:'ru-RU', scrollMargin:'800px' };
  const MINIAPP_URL = 'https://heroic-horse-64b078.netlify.app/';

  let allPosts=[], filtered=[], shown=0, query='', loading=false;
  let selectedDate=null; // 'YYYY-MM-DD' или null
  let calYear, calMonth; // текущий месяц в календаре
  let postDatesSet = new Set(); // Set<'YYYY-MM-DD'> — все даты с постами
  let miniappTimer=null;

  const dom = {};
  ['feed','searchInput','searchClear','searchStatus','emptyState','scrollLoader',
   'lightbox','lbImg','lbVideo','lbFallback','lbFallbackImg','lbFallbackLink','lbClose','lbPrev','lbNext','lbCounter','toast',
   'subscriberCount','channelAvatar',
   'calendarBtn','calendarDropdown','calPrev','calNext','calTitle','calGrid',
   'miniappModal','miniappFrame','miniappStatus','miniappStatusText','miniappOpenWindow','miniappClose',
   'dateChip','dateChipText','dateChipClear'
  ].forEach(id => dom[id] = document.getElementById(id));

  const MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const PLAY_SVG = `<svg class="vp-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  const EXPAND_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>`;

  // ========== INIT ==========
  async function init() {
    loadChannelMeta();
    try {
      const r = await fetch(CFG.postsUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      allPosts = await r.json();
      allPosts.sort((a,b) => new Date(b.date)-new Date(a.date));

      // Собираем Set дат
      allPosts.forEach(p => {
        if (p.date) {
          const d = new Date(p.date);
          postDatesSet.add(dateKey(d));
        }
      });

      // Инициализируем календарь на текущий месяц
      const now = new Date();
      calYear = now.getFullYear();
      calMonth = now.getMonth();

      filtered = allPosts;
      render();
      initInfiniteScroll();
      initCalendar();
      scrollToHash();
    } catch (err) {
      dom.feed.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>Не удалось загрузить посты</p><p style="font-size:11px;color:#52525b">${esc(err.message)}</p></div>`;
    }
  }

  async function loadChannelMeta() {
    try {
      const r = await fetch(CFG.channelUrl); if (!r.ok) return;
      const m = await r.json();
      if (m.subscribers && dom.subscriberCount) dom.subscriberCount.textContent = fmtSubs(m.subscribers);
      if (m.avatar_url && dom.channelAvatar) dom.channelAvatar.src = m.avatar_url;
    } catch(e){}
  }
  function fmtSubs(n){ return n>=1e6?(n/1e6).toFixed(1)+'M подписчиков':n>=1e3?(n/1e3).toFixed(1)+'K подписчиков':n.toLocaleString('ru-RU')+' подписчиков'; }

  // ========== RENDER ==========
  function render(){ dom.feed.innerHTML=''; shown=0; more(); ui(); }
  function more(){
    if(loading||shown>=filtered.length)return;
    loading=true;
    const batch=filtered.slice(shown,shown+CFG.perPage);
    const frag=document.createDocumentFragment();
    batch.forEach(p=>frag.appendChild(card(p)));
    dom.feed.appendChild(frag);
    shown+=batch.length; ui(); loading=false;
  }
  function ui(){
    dom.emptyState.style.display=filtered.length===0?'':'none';
    let status = '';
    if (query && selectedDate) status = `Поиск «${query}» за ${fmtDateRu(selectedDate)}: ${filtered.length}`;
    else if (query) status = `Найдено: ${filtered.length}`;
    else if (selectedDate) status = `Постов за ${fmtDateRu(selectedDate)}: ${filtered.length}`;
    dom.searchStatus.textContent = status;
   dom.searchStatus.style.display = status ? '' : 'none';
    if(dom.scrollLoader) dom.scrollLoader.style.display=shown<filtered.length?'':'none';
  }

  // ========== FILTER ==========
  function applyFilters() {
    filtered = allPosts;
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter(p => (p.text||'').toLowerCase().includes(q));
    }
    if (selectedDate) {
      filtered = filtered.filter(p => {
        if (!p.date) return false;
        return dateKey(new Date(p.date)) === selectedDate;
      });
    }
    render();
  }

  // ========== INFINITE SCROLL ==========
  function initInfiniteScroll(){
    if(!dom.scrollLoader)return;
    if('IntersectionObserver' in window){
      new IntersectionObserver(e=>{if(e[0].isIntersecting&&shown<filtered.length&&!loading)more();},{rootMargin:CFG.scrollMargin}).observe(dom.scrollLoader);
    } else {
      window.addEventListener('scroll',()=>{if(!loading&&shown<filtered.length&&document.documentElement.scrollHeight-window.scrollY-window.innerHeight<800)more();},{passive:true});
    }
  }

  // ========== CALENDAR ==========
  function initCalendar() {
    dom.calendarBtn.addEventListener('click', toggleCalendar);
    dom.calPrev.addEventListener('click', () => { calMonth--; if(calMonth<0){calMonth=11;calYear--;} renderCalendar(); });
    dom.calNext.addEventListener('click', () => { calMonth++; if(calMonth>11){calMonth=0;calYear++;} renderCalendar(); });
    dom.dateChipClear.addEventListener('click', clearDateFilter);

    // Закрыть при клике вне
    document.addEventListener('click', e => {
      if (!dom.calendarDropdown.contains(e.target) && !dom.calendarBtn.contains(e.target)) {
        dom.calendarDropdown.style.display = 'none';
      }
    });
  }

  function toggleCalendar() {
    const open = dom.calendarDropdown.style.display === 'none';
    dom.calendarDropdown.style.display = open ? '' : 'none';
    if (open) renderCalendar();
  }

  function renderCalendar() {
    dom.calTitle.textContent = `${MONTHS_RU[calMonth]} ${calYear}`;

    // Первый день месяца (0=вс, 1=пн, ...)
    const firstDay = new Date(calYear, calMonth, 1).getDay();
    // Смещение для понедельника = 0 (пн=0, вт=1, ..., вс=6)
    const offset = (firstDay + 6) % 7;
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

    const today = dateKey(new Date());
    let html = '';

    // Пустые ячейки до 1-го числа
    for (let i = 0; i < offset; i++) {
      html += '<span class="cal-day empty"></span>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const hasPosts = postDatesSet.has(key);
      const isToday = key === today;
      const isSelected = key === selectedDate;

      let cls = 'cal-day';
      if (hasPosts) cls += ' has-posts';
      if (isToday) cls += ' today';
      if (isSelected) cls += ' selected';

      if (hasPosts) {
        html += `<button class="${cls}" data-date="${key}">${d}</button>`;
      } else {
        html += `<span class="${cls}">${d}</span>`;
      }
    }

    dom.calGrid.innerHTML = html;

    // Клики по дням
    dom.calGrid.querySelectorAll('.cal-day.has-posts').forEach(btn => {
      btn.addEventListener('click', () => selectDate(btn.dataset.date));
    });
  }

  function selectDate(dateStr) {
    selectedDate = dateStr;
    dom.calendarDropdown.style.display = 'none';
    dom.calendarBtn.classList.add('active');
    dom.dateChip.style.display = '';
    dom.dateChipText.textContent = fmtDateRu(dateStr);
    applyFilters();
  }

  function clearDateFilter() {
    selectedDate = null;
    dom.calendarBtn.classList.remove('active');
    dom.dateChip.style.display = 'none';
    applyFilters();
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function fmtDateRu(dateStr) {
    const [y,m,d] = dateStr.split('-').map(Number);
    const date = new Date(y, m-1, d);
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function getGalleryMedia(post) {
    return (post.media || [])
      .filter(m => m && (m.type === 'photo' || m.type === 'video'))
      .map((m, mediaIdx) => ({
        ...m,
        kind: m.type === 'photo' ? 'photo' : 'video',
        mediaIdx,
        post_url: m.post_url || post.url
      }));
  }

  function mediaOpenControl(pid, mediaIdx) {
    return `<span class="media-open" data-pid="${pid}" data-media-idx="${mediaIdx}" role="button" tabindex="0" aria-label="Открыть галерею">${EXPAND_SVG}</span>`;
  }

  function getDiscussionRef(postUrl) {
    try {
      const u = new URL(postUrl);
      const parts = u.pathname.split('/').filter(Boolean);
      let channel = '', postId = '';
      if (parts[0] === 's' && parts.length >= 3) {
        channel = parts[1];
        postId = parts[2];
      } else if (parts.length >= 2) {
        channel = parts[0];
        postId = parts[1];
      }
      if (!channel || !/^\d+$/.test(postId)) return '';
      return `${channel}/${postId}`;
    } catch {
      return '';
    }
  }

  // ========== POST CARD ==========
  function card(post) {
    const el = document.createElement('article');
    el.className = 'post-card';
    el.id = `post-${post.id}`;

    const docs   = (post.media||[]).filter(m=>m.type==='document');
    const allMedia = getGalleryMedia(post);

    let mediaHTML = '';
    if (allMedia.length > 0) {
      const sc = Math.min(allMedia.length, 3);
      const items = allMedia.slice(0, sc).map((m, i) => {
        let ov = '';
        if (i === sc-1 && allMedia.length > 3) ov = `<span class="media-more" data-pid="${post.id}" data-media-idx="${m.mediaIdx}" role="button" tabindex="0" aria-label="Открыть галерею, ещё ${allMedia.length-3}">+${allMedia.length-3}</span>`;
        if (m.kind === 'photo') {
          return `<div class="media-thumb" data-pid="${post.id}" data-media-idx="${m.mediaIdx}"><img src="${attr(m.url)}" alt="" loading="lazy" onerror="this.parentElement.classList.add('media-broken')">${ov}</div>`;
        } else {
          const dur = m.duration ? `<span class="vp-dur">${fmtDur(m.duration)}</span>` : '';
          const openCtl = mediaOpenControl(post.id, m.mediaIdx);

          // При наличии прямого URL показываем само видео с autoplay (muted).
          if (m.url) {
            const poster = m.thumbnail ? `poster="${attr(m.thumbnail)}"` : '';
            return `<div class="media-thumb media-video-native" data-pid="${post.id}" data-media-idx="${m.mediaIdx}">${openCtl}${dur ? `<div class="vp-dur-wrap">${dur}</div>` : ''}<video src="${attr(m.url)}" ${poster} autoplay muted playsinline loop controls preload="metadata" onerror="this.closest('.media-thumb').classList.add('media-broken')"></video>${ov}</div>`;
          }

          // Если прямого URL нет (часто у blur/ограниченных видео), показываем fallback-блок,
          // но не Telegram embed-превью поста.
          const inner = m.thumbnail
            ? `<img src="${attr(m.thumbnail)}" alt="" loading="lazy" onerror="this.style.display='none'"><div class="vp-overlay">${PLAY_SVG}${dur}</div>`
            : `<div class="vp-placeholder">${PLAY_SVG}${dur}<span class="vp-label">Видео</span></div>`;
          return `<a class="media-thumb media-video" href="${attr(m.post_url || post.url)}" target="_blank" rel="noopener" data-pid="${post.id}" data-media-idx="${m.mediaIdx}">${openCtl}${inner}${ov}</a>`;
        }
      }).join('');
      mediaHTML = `<div class="post-media" data-count="${sc}">${items}</div>`;
    }

    let docsHTML = '';
    if (docs.length > 0) {
      docsHTML = '<div class="post-docs">' + docs.map(d => {
        const isPdf=d.filename&&d.filename.toLowerCase().endsWith('.pdf');
        const ico=isPdf?`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/></svg>`;
        const sz=d.size?`<span class="doc-size">${fmtBytes(d.size)}</span>`:'';
        const href=d.url&&d.url!=='#'?d.url:post.url;
        return `<a class="doc-chip" href="${attr(href)}" target="_blank" rel="noopener">${ico} ${esc(d.filename||'Файл')} ${sz} <span class="doc-open">Открыть в Telegram ↗</span></a>`;
      }).join('') + '</div>';
    }

    const textHTML = fmtContent(post);
    const dt = fmtDate(post.date);
    const discussionRef = getDiscussionRef(post.url);
    const views=post.views?`<span class="post-stat"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>${fmtNum(post.views)}</span>`:'';
    const fwds=post.forwards?`<span class="post-stat"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/></svg>${fmtNum(post.forwards)}</span>`:'';
    const commentsBtn = discussionRef ? `<button class="post-comments-btn" data-comments-toggle="${post.id}" type="button" aria-expanded="false">Комментарии</button>` : '';
    const commentsHTML = discussionRef ? `<div class="post-comments" id="comments-${post.id}" hidden><div class="post-comments-inner"><div class="post-comments-loader">Загружаем комментарии…</div></div></div>` : '';
    let reactHTML = '';
    if (post.reactions && post.reactions.length) {
      reactHTML = '<div class="post-reactions">' + post.reactions.map(r =>
        `<span class="post-reaction">${normalizeEmoji(r.emoji)} ${fmtNum(r.count)}</span>`
      ).join('') + '</div>';
    }
    el.innerHTML = `${mediaHTML}${docsHTML}<div class="post-body"><div class="post-head"><time class="post-date" datetime="${post.date}">${dt}</time><div class="post-actions"><button class="act-btn btn-copy" data-pid="${post.id}" title="Скопировать ссылку"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg></button></div></div><div class="post-text">${textHTML}</div></div>${reactHTML}<div class="post-foot">${views}${fwds}${commentsBtn}<a class="post-link-orig" href="${attr(post.url)}" target="_blank" rel="noopener">Оригинал ↗</a></div>${commentsHTML}`;
    return el;
  }

  // ========== TEXT ==========
  function fmtContent(post){
    let c;
    if(post.html){c=post.html.replace(/<br\s*\/?>/gi,'\n');c=addTags(c);if(query)c=hlSearch(c,query);}
    else{c=esc(post.text||'');c=c.replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');c=c.replace(/@([\w]+)/g,'<a href="https://t.me/$1" target="_blank" rel="noopener">@$1</a>');c=c.replace(/(#[\wа-яёА-ЯЁ]+)/gu,'<span class="htag" data-tag="$1">$1</span>');if(query)c=hlSearch(c,query);}
    return c;
  }
  function addTags(h){return h.replace(/(<[^>]+>)|(#[\wа-яёА-ЯЁ]+)/gu,(m,t,ht)=>t?t:ht?`<span class="htag" data-tag="${ht}">${ht}</span>`:m)}
  function hlSearch(h,q){const re=new RegExp(`(${escRE(q)})`,'gi');return h.replace(/(<[^>]+>)|([^<]+)/g,(m,t,x)=>t?t:x?x.replace(re,'<mark class="hl">$1</mark>'):m)}

  // ========== UTILS ==========
  function fmtDate(iso){const d=new Date(iso);const day=d.toLocaleDateString(CFG.locale,{day:'numeric',month:'short'});const time=d.toLocaleTimeString(CFG.locale,{hour:'2-digit',minute:'2-digit'});const yr=d.getFullYear()!==new Date().getFullYear()?' '+d.getFullYear():'';return day+yr+', '+time}
  function fmtNum(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n)}
  function fmtBytes(b){return b>=1e6?(b/1e6).toFixed(1)+' МБ':b>=1e3?(b/1e3).toFixed(0)+' КБ':b+' Б'}
  function fmtDur(s){return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
  function normalizeEmoji(s){return String(s||'').replace(/\u2764(?!\uFE0F)/g,'\u2764\uFE0F')}
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
  function attr(s){return s.replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
  function escRE(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
  function toTelegramEmbedUrl(postUrl){
    try {
      const u = new URL(postUrl);
      const host = u.hostname.toLowerCase();
      if (host !== 't.me' && host !== 'telegram.me') return null;
      const parts = u.pathname.split('/').filter(Boolean);
      let channel = '', postId = '';
      if (parts[0] === 's' && parts.length >= 3) {
        channel = parts[1];
        postId = parts[2];
      } else if (parts.length >= 2) {
        channel = parts[0];
        postId = parts[1];
      }
      if (!channel || !/^\d+$/.test(postId)) return null;
      return `https://t.me/${channel}/${postId}?embed=1&mode=tme`;
    } catch {
      return null;
    }
  }

  // ========== SEARCH ==========
  function onSearch(){
    query = dom.searchInput.value.trim();
    dom.searchClear.style.display = query ? '' : 'none';
    applyFilters();
  }

  // ========== LIGHTBOX ==========
  let lbItems=[],lbI=0;
  let openCommentsPostId=null;
  function resetLBMedia(){
    dom.lbImg.style.display='none';
    dom.lbImg.removeAttribute('src');
    dom.lbVideo.style.display='none';
    dom.lbVideo.pause();
    dom.lbVideo.removeAttribute('src');
    dom.lbVideo.removeAttribute('poster');
    dom.lbVideo.load();
    dom.lbFallback.style.display='none';
    dom.lbFallbackImg.style.display='none';
    dom.lbFallbackImg.removeAttribute('src');
    dom.lbFallbackLink.href='#';
  }
  function openLB(pid,idx){
    const p=allPosts.find(x=>x.id===Number(pid));
    if(!p||!p.media)return;
    lbItems=getGalleryMedia(p);
    if(!lbItems.length)return;
    lbI=Math.max(0,Math.min(Number(idx)||0,lbItems.length-1));
    showLB();
    dom.lightbox.classList.add('open');
    document.body.style.overflow='hidden';
  }
  function closeLB(){
    resetLBMedia();
    dom.lightbox.classList.remove('open');
    document.body.style.overflow='';
  }
  function showLB(){
    const m=lbItems[lbI];
    if(!m)return;
    resetLBMedia();
    if(m.kind==='photo'){
      dom.lbImg.src=m.url;
      dom.lbImg.style.display='block';
    } else if(m.url){
      dom.lbVideo.src=m.url;
      if(m.thumbnail) dom.lbVideo.poster=m.thumbnail;
      dom.lbVideo.style.display='block';
      dom.lbVideo.play().catch(()=>{});
    } else {
      if(m.thumbnail){
        dom.lbFallbackImg.src=m.thumbnail;
        dom.lbFallbackImg.style.display='block';
      }
      dom.lbFallbackLink.href=m.post_url || '#';
      dom.lbFallback.style.display='block';
    }
    dom.lbCounter.textContent=lbItems.length>1?`${lbI+1} / ${lbItems.length}`:'';
    dom.lbPrev.style.display=lbItems.length>1?'':'none';
    dom.lbNext.style.display=lbItems.length>1?'':'none';
  }
  function copyLink(pid){navigator.clipboard.writeText(`${location.origin}${location.pathname}#post-${pid}`).then(toast).catch(toast)}
  function toast(){dom.toast.classList.add('show');setTimeout(()=>dom.toast.classList.remove('show'),1800)}
  function scrollToHash(){const h=location.hash;if(!h||!h.startsWith('#post-'))return;while(shown<filtered.length){if(document.getElementById(h.slice(1)))break;more()}setTimeout(()=>{const el=document.getElementById(h.slice(1));if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('highlighted');setTimeout(()=>el.classList.remove('highlighted'),3000)}},150)}
  function clearMiniappTimer(){if(miniappTimer){clearTimeout(miniappTimer);miniappTimer=null}}
  function setMiniappStatus(text){
    dom.miniappStatusText.textContent=text;
  }
  function openMiniapp(){
    clearMiniappTimer();
    dom.miniappOpenWindow.href=MINIAPP_URL;
    dom.miniappFrame.removeAttribute('src');
    dom.miniappStatus.classList.remove('is-hidden','is-warning');
    setMiniappStatus('Загрузка… Если что-то блокирует iframe, откройте в новом окне.');
    dom.miniappModal.classList.add('open');
    dom.miniappModal.setAttribute('aria-hidden','false');
    document.body.style.overflow='hidden';
    dom.miniappFrame.src=MINIAPP_URL;
    miniappTimer=setTimeout(()=>{
      dom.miniappStatus.classList.remove('is-hidden');
      dom.miniappStatus.classList.add('is-warning');
      setMiniappStatus('Похоже, iframe блокируется браузером или расширением. Откройте сервис в новом окне.');
    },4000);
  }
  function closeMiniapp(){
    clearMiniappTimer();
    dom.miniappModal.classList.remove('open');
    dom.miniappModal.setAttribute('aria-hidden','true');
    dom.miniappFrame.removeAttribute('src');
    dom.miniappStatus.classList.remove('is-hidden','is-warning');
    document.body.style.overflow='';
  }
  function loadCommentsWidget(postId){
    const post=allPosts.find(x=>x.id===Number(postId));
    const container=document.getElementById(`comments-${postId}`);
    if(!post||!container)return;
    const host=container.querySelector('.post-comments-inner');
    if(!host||host.dataset.loaded==='1')return;
    const discussionRef=getDiscussionRef(post.url);
    if(!discussionRef){
      host.innerHTML='<div class="post-comments-loader">Комментарии для этого поста недоступны.</div>';
      return;
    }
    host.innerHTML='';
    const script=document.createElement('script');
    script.async=true;
    script.src='https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-discussion', discussionRef);
    script.setAttribute('data-comments-limit', '10');
    script.setAttribute('data-dark', '1');
    script.setAttribute('data-color', '22c55e');
    host.appendChild(script);
    host.dataset.loaded='1';
  }
  function setCommentsExpanded(postId, expanded){
    const btn=document.querySelector(`[data-comments-toggle="${postId}"]`);
    const panel=document.getElementById(`comments-${postId}`);
    if(btn) {
      btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      btn.textContent = expanded ? 'Скрыть комментарии' : 'Комментарии';
    }
    if(panel) panel.hidden = !expanded;
  }
  function toggleComments(postId){
    const id=Number(postId);
    const isSame=openCommentsPostId===id;
    if(openCommentsPostId!==null) setCommentsExpanded(openCommentsPostId,false);
    if(isSame){
      openCommentsPostId=null;
      return;
    }
    openCommentsPostId=id;
    setCommentsExpanded(id,true);
    loadCommentsWidget(id);
  }

  // ========== EVENTS ==========
  let sTO;
  dom.searchInput.addEventListener('input',()=>{clearTimeout(sTO);sTO=setTimeout(onSearch,250)});
  dom.searchClear.addEventListener('click',()=>{dom.searchInput.value='';onSearch();dom.searchInput.focus()});
  if(dom.miniappFrame){
    dom.miniappFrame.addEventListener('load',()=>{
      clearMiniappTimer();
      dom.miniappStatus.classList.add('is-hidden');
      dom.miniappStatus.classList.remove('is-warning');
    });
  }
  document.addEventListener('click',e=>{
    const miniappBtn=e.target.closest('[data-miniapp-open]');
    if(miniappBtn){e.preventDefault();openMiniapp();return}
    const mediaAction=e.target.closest('.media-open,.media-more');
    if(mediaAction&&mediaAction.dataset.pid){e.preventDefault();openLB(mediaAction.dataset.pid,mediaAction.dataset.mediaIdx);return}
    const th=e.target.closest('.media-thumb[data-pid]');
    if(th&&!th.classList.contains('media-broken')){
      if(th.classList.contains('media-video-native') || th.classList.contains('media-video')) return;
      openLB(th.dataset.pid,th.dataset.mediaIdx);
      return;
    }
    const commentsToggle=e.target.closest('[data-comments-toggle]');
    if(commentsToggle){toggleComments(commentsToggle.dataset.commentsToggle);return}
    const cp=e.target.closest('.btn-copy');if(cp){copyLink(cp.dataset.pid);return}
    const tg=e.target.closest('.htag');if(tg){dom.searchInput.value=tg.dataset.tag;onSearch();window.scrollTo({top:0,behavior:'smooth'});return}
  });
  dom.lbClose.addEventListener('click',closeLB);
  if(dom.miniappClose) dom.miniappClose.addEventListener('click',closeMiniapp);
  if(dom.miniappModal) dom.miniappModal.addEventListener('click',e=>{if(e.target===dom.miniappModal)closeMiniapp()});
  dom.lbPrev.addEventListener('click',()=>{lbI=(lbI-1+lbItems.length)%lbItems.length;showLB()});
  dom.lbNext.addEventListener('click',()=>{lbI=(lbI+1)%lbItems.length;showLB()});
  dom.lightbox.addEventListener('click',e=>{if(e.target===dom.lightbox)closeLB()});
  document.addEventListener('keydown',e=>{
    const mediaAction=document.activeElement&&document.activeElement.closest?document.activeElement.closest('.media-open,.media-more'):null;
    if(mediaAction&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openLB(mediaAction.dataset.pid,mediaAction.dataset.mediaIdx);return}
    if(dom.miniappModal.classList.contains('open')&&e.key==='Escape'){closeMiniapp();return}
    if(!dom.lightbox.classList.contains('open'))return;
    if(e.key==='Escape')closeLB();
    if(e.key==='ArrowLeft'){lbI=(lbI-1+lbItems.length)%lbItems.length;showLB()}
    if(e.key==='ArrowRight'){lbI=(lbI+1)%lbItems.length;showLB()}
  });

  init();
})();














