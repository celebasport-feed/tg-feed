/* ============================================================
   CELEBASPORT WEB FEED — app.js v6
   - Видео: карточка со ссылкой «Смотреть в Telegram» (не «фото недоступно»)
   - Документы/PDF: кликабельная ссылка на пост в Telegram
   - Подписчики: динамически из data/channel.json
   - Текст: отображается полностью, без обрезки
   - Бесконечный скролл
   ============================================================ */

(function () {
  'use strict';

  const CFG = {
    postsUrl: 'data/posts.json',
    channelUrl: 'data/channel.json',
    perPage: 15,
    locale: 'ru-RU',
    scrollMargin: '800px',
  };

  let allPosts = [], filtered = [], shown = 0, query = '', loading = false;

  const dom = {};
  ['feed','searchInput','searchClear','searchStatus','emptyState','scrollLoader',
   'lightbox','lbImg','lbClose','lbPrev','lbNext','lbCounter',
   'toast','subscriberCount','channelAvatar'
  ].forEach(id => dom[id] = document.getElementById(id));

  // ========== INIT ==========
  async function init() {
    loadChannelMeta();
    try {
      const r = await fetch(CFG.postsUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      allPosts = await r.json();
      allPosts.sort((a, b) => new Date(b.date) - new Date(a.date));
      filtered = allPosts;
      render();
      initInfiniteScroll();
      scrollToHash();
    } catch (err) {
      dom.feed.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>Не удалось загрузить посты</p><p style="font-size:11px;color:#52525b">${esc(err.message)}</p></div>`;
    }
  }

  async function loadChannelMeta() {
    try {
      const r = await fetch(CFG.channelUrl);
      if (!r.ok) return;
      const m = await r.json();
      if (m.subscribers && dom.subscriberCount)
        dom.subscriberCount.textContent = fmtSubs(m.subscribers);
      if (m.avatar_url && dom.channelAvatar)
        dom.channelAvatar.src = m.avatar_url;
    } catch (e) { /* не критично */ }
  }

  function fmtSubs(n) {
    if (n >= 1e6) return (n/1e6).toFixed(1) + 'M подписчиков';
    if (n >= 1e3) return (n/1e3).toFixed(1) + 'K подписчиков';
    return n.toLocaleString('ru-RU') + ' подписчиков';
  }

  // ========== RENDER ==========
  function render() { dom.feed.innerHTML = ''; shown = 0; more(); ui(); }

  function more() {
    if (loading || shown >= filtered.length) return;
    loading = true;
    const batch = filtered.slice(shown, shown + CFG.perPage);
    const frag = document.createDocumentFragment();
    batch.forEach(p => frag.appendChild(card(p)));
    dom.feed.appendChild(frag);
    shown += batch.length;
    ui(); loading = false;
  }

  function ui() {
    dom.emptyState.style.display = filtered.length === 0 ? '' : 'none';
    dom.searchStatus.textContent = query ? `Найдено: ${filtered.length}` : '';
    if (dom.scrollLoader) dom.scrollLoader.style.display = shown < filtered.length ? '' : 'none';
  }

  // ========== INFINITE SCROLL ==========
  function initInfiniteScroll() {
    if (!dom.scrollLoader) return;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(e => {
        if (e[0].isIntersecting && shown < filtered.length && !loading) more();
      }, { rootMargin: CFG.scrollMargin }).observe(dom.scrollLoader);
    } else {
      window.addEventListener('scroll', () => {
        if (!loading && shown < filtered.length &&
            document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 800) more();
      }, { passive: true });
    }
  }

  // ========== POST CARD ==========
  function card(post) {
    const el = document.createElement('article');
    el.className = 'post-card';
    el.id = `post-${post.id}`;

    const photos = (post.media||[]).filter(m => m.type === 'photo');
    const videos = (post.media||[]).filter(m => m.type === 'video');
    const docs   = (post.media||[]).filter(m => m.type === 'document');

    // === ФОТО (только type=photo → галерея) ===
    let mediaHTML = '';
    if (photos.length > 0) {
      const sc = Math.min(photos.length, 3);
      const items = photos.slice(0, sc).map((m, i) => {
        let ov = '';
        if (i === sc-1 && photos.length > 3) ov = `<div class="media-more">+${photos.length-3}</div>`;
        return `<div class="media-thumb" data-pid="${post.id}" data-idx="${i}"><img src="${attr(m.url)}" alt="" loading="lazy" onerror="this.parentElement.classList.add('media-broken')">${ov}</div>`;
      }).join('');
      mediaHTML = `<div class="post-media" data-count="${sc}">${items}</div>`;
    }

    // === ВИДЕО (всегда ведёт на Telegram, НЕ «фото недоступно») ===
    let videosHTML = '';
    if (videos.length > 0) {
      const vItems = videos.map(v => {
        const dur = v.duration ? fmtDur(v.duration) : '';
        const link = v.post_url || post.url;
        const thumb = v.thumbnail;

        if (thumb) {
          return `<a class="video-card" href="${attr(link)}" target="_blank" rel="noopener">
            <img src="${attr(thumb)}" alt="" loading="lazy" onerror="this.style.display='none'">
            <div class="video-play-overlay"><svg width="28" height="28" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></div>
            <div class="media-video-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>${dur ? ' '+dur : ' Видео'}</div>
          </a>`;
        } else {
          return `<a class="video-card video-card--no-thumb" href="${attr(link)}" target="_blank" rel="noopener">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" opacity="0.6"><path d="M8 5v14l11-7z"/></svg>
            <span>Видео${dur ? ' · '+dur : ''}</span>
            <span class="video-card-tg">Смотреть в Telegram ↗</span>
          </a>`;
        }
      }).join('');
      videosHTML = `<div class="post-videos">${vItems}</div>`;
    }

    // === ДОКУМЕНТЫ (кликабельные, ведут на Telegram) ===
    let docsHTML = '';
    if (docs.length > 0) {
      const chips = docs.map(d => {
        const isPdf = d.filename && d.filename.toLowerCase().endsWith('.pdf');
        const ico = isPdf
          ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
          : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/></svg>`;
        const sz = d.size ? `<span class="doc-size">${fmtBytes(d.size)}</span>` : '';
        const href = d.url && d.url !== '#' ? d.url : post.url;
        return `<a class="doc-chip" href="${attr(href)}" target="_blank" rel="noopener">${ico} ${esc(d.filename||'Файл')} ${sz} <span class="doc-open">Открыть в Telegram ↗</span></a>`;
      }).join('');
      docsHTML = `<div class="post-docs">${chips}</div>`;
    }

    const textHTML = fmtContent(post);
    const dt = fmtDate(post.date);
    const views = post.views ? `<span class="post-stat"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>${fmtNum(post.views)}</span>` : '';
    const fwds = post.forwards ? `<span class="post-stat"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/></svg>${fmtNum(post.forwards)}</span>` : '';

    el.innerHTML = `${mediaHTML}${videosHTML}${docsHTML}<div class="post-body"><div class="post-head"><time class="post-date" datetime="${post.date}">${dt}</time><div class="post-actions"><button class="act-btn btn-copy" data-pid="${post.id}" title="Скопировать ссылку"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg></button></div></div><div class="post-text">${textHTML}</div></div><div class="post-foot">${views}${fwds}<a class="post-link-orig" href="${attr(post.url)}" target="_blank" rel="noopener">Оригинал ↗</a></div>`;
    return el;
  }

  // ========== TEXT FORMATTING ==========
  function fmtContent(post) {
    let c;
    if (post.html) {
      c = post.html.replace(/<br\s*\/?>/gi, '\n');
      c = addTags(c);
      if (query) c = hlSearch(c, query);
    } else {
      c = esc(post.text || '');
      c = c.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      c = c.replace(/@([\w]+)/g, '<a href="https://t.me/$1" target="_blank" rel="noopener">@$1</a>');
      c = c.replace(/(#[\wа-яёА-ЯЁ]+)/gu, '<span class="htag" data-tag="$1">$1</span>');
      if (query) c = hlSearch(c, query);
    }
    return c;
  }
  function addTags(h){return h.replace(/(<[^>]+>)|(#[\wа-яёА-ЯЁ]+)/gu,(m,t,ht)=>t?t:ht?`<span class="htag" data-tag="${ht}">${ht}</span>`:m)}
  function hlSearch(h,q){const re=new RegExp(`(${escRE(q)})`,'gi');return h.replace(/(<[^>]+>)|([^<]+)/g,(m,t,x)=>t?t:x?x.replace(re,'<mark class="hl">$1</mark>'):m)}

  // ========== UTILS ==========
  function fmtDate(iso){const d=new Date(iso);const day=d.toLocaleDateString(CFG.locale,{day:'numeric',month:'short'});const time=d.toLocaleTimeString(CFG.locale,{hour:'2-digit',minute:'2-digit'});const yr=d.getFullYear()!==new Date().getFullYear()?' '+d.getFullYear():'';return day+yr+', '+time}
  function fmtNum(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n)}
  function fmtBytes(b){return b>=1e6?(b/1e6).toFixed(1)+' МБ':b>=1e3?(b/1e3).toFixed(0)+' КБ':b+' Б'}
  function fmtDur(s){return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
  function attr(s){return s.replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
  function escRE(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}

  // ========== SEARCH ==========
  function onSearch(){query=dom.searchInput.value.trim();dom.searchClear.style.display=query?'':'none';filtered=query?allPosts.filter(p=>(p.text||'').toLowerCase().includes(query.toLowerCase())):allPosts;render()}

  // ========== LIGHTBOX (only photos) ==========
  let lbP=[],lbI=0;
  function openLB(pid,idx){const p=allPosts.find(x=>x.id===Number(pid));if(!p||!p.media)return;lbP=p.media.filter(m=>m.type==='photo');if(!lbP.length)return;lbI=Number(idx)||0;showLB();dom.lightbox.classList.add('open');document.body.style.overflow='hidden'}
  function closeLB(){dom.lightbox.classList.remove('open');document.body.style.overflow=''}
  function showLB(){const m=lbP[lbI];dom.lbImg.src=m.url;dom.lbCounter.textContent=lbP.length>1?`${lbI+1} / ${lbP.length}`:'';dom.lbPrev.style.display=lbP.length>1?'':'none';dom.lbNext.style.display=lbP.length>1?'':'none'}
  function copyLink(pid){navigator.clipboard.writeText(`${location.origin}${location.pathname}#post-${pid}`).then(toast).catch(toast)}
  function toast(){dom.toast.classList.add('show');setTimeout(()=>dom.toast.classList.remove('show'),1800)}

  function scrollToHash(){const h=location.hash;if(!h||!h.startsWith('#post-'))return;while(shown<filtered.length){if(document.getElementById(h.slice(1)))break;more()}setTimeout(()=>{const el=document.getElementById(h.slice(1));if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('highlighted');setTimeout(()=>el.classList.remove('highlighted'),3000)}},150)}

  // ========== EVENTS ==========
  let sTO;
  dom.searchInput.addEventListener('input',()=>{clearTimeout(sTO);sTO=setTimeout(onSearch,250)});
  dom.searchClear.addEventListener('click',()=>{dom.searchInput.value='';onSearch();dom.searchInput.focus()});
  document.addEventListener('click',e=>{
    const th=e.target.closest('.media-thumb');if(th&&!th.classList.contains('media-broken')){openLB(th.dataset.pid,th.dataset.idx);return}
    const cp=e.target.closest('.btn-copy');if(cp){copyLink(cp.dataset.pid);return}
    const tg=e.target.closest('.htag');if(tg){dom.searchInput.value=tg.dataset.tag;onSearch();window.scrollTo({top:0,behavior:'smooth'});return}
  });
  dom.lbClose.addEventListener('click',closeLB);
  dom.lbPrev.addEventListener('click',()=>{lbI=(lbI-1+lbP.length)%lbP.length;showLB()});
  dom.lbNext.addEventListener('click',()=>{lbI=(lbI+1)%lbP.length;showLB()});
  dom.lightbox.addEventListener('click',e=>{if(e.target===dom.lightbox)closeLB()});
  document.addEventListener('keydown',e=>{if(!dom.lightbox.classList.contains('open'))return;if(e.key==='Escape')closeLB();if(e.key==='ArrowLeft'){lbI=(lbI-1+lbP.length)%lbP.length;showLB()}if(e.key==='ArrowRight'){lbI=(lbI+1)%lbP.length;showLB()}});

  init();
})();
